'use strict';
const express=require('express');
const crypto=require('crypto');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');

let schemaReady=false;
async function ensureSchema(){
  if(schemaReady)return;
  await db.batch([
    {sql:`CREATE TABLE IF NOT EXISTS purchase_receive_operations(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      po_id INTEGER NOT NULL REFERENCES purchase_orders(id),
      operation_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('in_progress','completed')),
      response_status INTEGER,
      response_json TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(po_id,operation_key)
    )`},
    {sql:`CREATE TABLE IF NOT EXISTS purchase_receive_locks(
      po_id INTEGER PRIMARY KEY REFERENCES purchase_orders(id),
      operation_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      acquired_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`},
    {sql:'CREATE INDEX IF NOT EXISTS idx_purchase_receive_operations_state ON purchase_receive_operations(po_id,state)'}
  ],'write');
  schemaReady=true;
}
function canonical(v){
  if(Array.isArray(v))return v.map(canonical);
  if(v&&typeof v==='object')return Object.keys(v).sort().reduce((o,k)=>(o[k]=canonical(v[k]),o),{});
  return v;
}
function hashRequest(poId,body){return crypto.createHash('sha256').update(JSON.stringify({po_id:Number(poId),body:canonical(body||{})})).digest('hex');}
function keyOf(req){return String(req.get('Idempotency-Key')||req.get('X-Idempotency-Key')||req.body?.operation_id||'').trim();}

router.patch('/:id/receive',async(req,res,next)=>{
  try{
    await ensureSchema();
    const poId=Number(req.params.id);
    if(!Number.isInteger(poId)||poId<=0)return res.status(400).json({error:'Valid purchase order id required'});
    const {rows:[po]}=await db.execute({sql:'SELECT id,status FROM purchase_orders WHERE id=?',args:[poId]});
    if(!po)return next();
    if(!['approved','partial'].includes(String(po.status)))return next();

    const key=keyOf(req);
    if(!key)return res.status(428).json({error:'Idempotency-Key is required for purchase-order receiving'});
    if(key.length<8||key.length>160)return res.status(400).json({error:'Idempotency-Key must be 8 to 160 characters'});
    const requestHash=hashRequest(poId,req.body);

    const tx=await db.transaction('write');let committed=false;
    try{
      const {rows:[existing]}=await tx.execute({sql:'SELECT * FROM purchase_receive_operations WHERE po_id=? AND operation_key=?',args:[poId,key]});
      if(existing){
        if(existing.request_hash!==requestHash){await tx.rollback();return res.status(409).json({error:'Idempotency-Key was already used with a different receiving payload'});}
        if(existing.state==='completed'){
          await tx.rollback();
          res.set('Idempotency-Replayed','true');
          res.status(Number(existing.response_status)||200);
          try{return res.json(JSON.parse(existing.response_json||'{}'));}catch{return res.json({replayed:true,operation_key:key});}
        }
        await tx.rollback();
        return res.status(409).set('Retry-After','2').json({error:'This receiving operation is already in progress. Retry with the same Idempotency-Key.',operation_key:key});
      }
      const {rows:[lock]}=await tx.execute({sql:'SELECT * FROM purchase_receive_locks WHERE po_id=?',args:[poId]});
      if(lock){
        await tx.rollback();
        return res.status(409).set('Retry-After','2').json({error:'Another receiving operation is already in progress for this purchase order',operation_key:lock.operation_key});
      }
      await tx.execute({sql:`INSERT INTO purchase_receive_operations(po_id,operation_key,request_hash,state) VALUES(?,?,?,'in_progress')`,args:[poId,key,requestHash]});
      await tx.execute({sql:'INSERT INTO purchase_receive_locks(po_id,operation_key,request_hash) VALUES(?,?,?)',args:[poId,key,requestHash]});
      await tx.commit();committed=true;
    }catch(e){if(!committed)await tx.rollback();throw e;}

    const originalJson=res.json.bind(res);
    let finalized=false;
    res.json=function(payload){
      if(finalized)return originalJson(payload);
      finalized=true;
      const status=Number(res.statusCode)||200;
      (async()=>{
        if(status>=200&&status<300){
          const tx2=await db.transaction('write');let c=false;
          try{
            await tx2.execute({sql:`UPDATE purchase_receive_operations SET state='completed',response_status=?,response_json=?,updated_at=CURRENT_TIMESTAMP WHERE po_id=? AND operation_key=? AND request_hash=?`,args:[status,JSON.stringify(payload??null),poId,key,requestHash]});
            await tx2.execute({sql:'DELETE FROM purchase_receive_locks WHERE po_id=? AND operation_key=?',args:[poId,key]});
            await tx2.commit();c=true;
            originalJson(payload);
          }catch(e){
            if(!c)await tx2.rollback().catch(()=>{});
            console.error('Purchase receive idempotency finalization failed',e);
            res.status(500);
            originalJson({error:'Receipt committed but idempotency finalization failed. Do not resubmit with a new key; review the operation before retrying.',operation_key:key});
          }
        }else{
          try{
            const tx2=await db.transaction('write');let c=false;
            try{
              await tx2.execute({sql:"DELETE FROM purchase_receive_operations WHERE po_id=? AND operation_key=? AND state='in_progress'",args:[poId,key]});
              await tx2.execute({sql:'DELETE FROM purchase_receive_locks WHERE po_id=? AND operation_key=?',args:[poId,key]});
              await tx2.commit();c=true;
            }catch(e){if(!c)await tx2.rollback().catch(()=>{});throw e;}
          }catch(e){console.error('Purchase receive idempotency cleanup failed',e);}
          originalJson(payload);
        }
      })().catch(e=>{
        console.error('Purchase receive response finalization failed',e);
        if(!res.headersSent){res.status(500);originalJson({error:'Receiving operation finalization failed',operation_key:key});}
      });
      return res;
    };
    next();
  }catch(e){next(e);}
});

router.get('/:id/receive-operations',requirePermission('purchasing'),async(req,res,next)=>{
  try{
    await ensureSchema();
    const {rows}=await db.execute({sql:`SELECT id,po_id,operation_key,state,response_status,created_at,updated_at FROM purchase_receive_operations WHERE po_id=? ORDER BY id DESC LIMIT 100`,args:[req.params.id]});
    res.json(rows);
  }catch(e){next(e);}
});

module.exports=router;
module.exports.ensureSchema=ensureSchema;
module.exports.hashRequest=hashRequest;
