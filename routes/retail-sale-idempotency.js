'use strict';
const express=require('express');
const crypto=require('crypto');
const router=express.Router();
const {db}=require('../database');

let readyPromise=null;
async function ensureSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS retail_sale_operations(
        operation_key TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        transaction_id INTEGER REFERENCES transactions(id),
        response_status INTEGER,
        response_json TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME
      )`},
      {sql:'CREATE INDEX IF NOT EXISTS idx_retail_sale_operations_tx ON retail_sale_operations(transaction_id)'}
    ],'write');
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}

function canonical(value){
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.keys(value).sort().reduce((o,k)=>{if(k!=='idempotency_key'&&k!=='operation_key')o[k]=canonical(value[k]);return o;},{});
  return value;
}
function fingerprint(body){return crypto.createHash('sha256').update(JSON.stringify(canonical(body||{}))).digest('hex');}
function operationKey(req){return String(req.get('Idempotency-Key')||req.get('X-Idempotency-Key')||req.body?.idempotency_key||req.body?.operation_key||'').trim();}
async function loadCompleted(row){
  if(!row)return null;
  if(row.response_json){try{return JSON.parse(row.response_json);}catch(e){}}
  if(!row.transaction_id)return null;
  const {rows:[tx]}=await db.execute({sql:'SELECT * FROM transactions WHERE id=?',args:[row.transaction_id]});
  if(!tx)return null;
  const {rows:items}=await db.execute({sql:'SELECT * FROM transaction_items WHERE transaction_id=? ORDER BY id',args:[row.transaction_id]});
  const {rows:payments}=await db.execute({sql:'SELECT * FROM transaction_payments WHERE transaction_id=? ORDER BY id',args:[row.transaction_id]});
  return {...tx,items,payments};
}

router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Sale idempotency initialization failed',detail:e.message});}});
router.post('/',async(req,res,next)=>{
  const key=operationKey(req);
  if(!key){
    res.set('Idempotency-Protection','not-requested');
    return next();
  }
  if(key.length<12||key.length>200)return res.status(400).json({error:'Idempotency key must be between 12 and 200 characters'});
  const hash=fingerprint(req.body);
  const claim=await db.transaction('write');let committed=false;
  try{
    const {rows:[existing]}=await claim.execute({sql:'SELECT * FROM retail_sale_operations WHERE operation_key=?',args:[key]});
    if(existing){
      await claim.commit();committed=true;
      if(existing.request_hash!==hash)return res.status(409).json({error:'Idempotency key was already used for a different sale request'});
      if(existing.status==='completed'){
        const payload=await loadCompleted(existing);
        if(!payload)return res.status(409).json({error:'Sale operation is marked completed but its transaction evidence is unavailable; reconciliation is required'});
        res.set('Idempotency-Replayed','true');
        return res.status(existing.response_status||200).json({...payload,replayed:true});
      }
      return res.status(409).json({error:'This sale operation is already in progress or awaiting reconciliation. Retry with the same idempotency key; do not create a new key.'});
    }
    await claim.execute({sql:'INSERT INTO retail_sale_operations(operation_key,request_hash,status) VALUES(?,?,\'pending\')',args:[key,hash]});
    await claim.commit();committed=true;
  }catch(e){if(!committed)await claim.rollback();return res.status(409).json({error:e.message});}

  req.saleOperationKey=key;
  const originalJson=res.json.bind(res);let finalized=false;
  res.json=function(payload){
    if(finalized)return originalJson(payload);
    finalized=true;
    if(res.statusCode>=200&&res.statusCode<300&&payload&&payload.id){
      return db.execute({sql:`UPDATE retail_sale_operations SET status='completed',transaction_id=?,response_status=?,response_json=?,updated_at=CURRENT_TIMESTAMP,completed_at=CURRENT_TIMESTAMP WHERE operation_key=? AND request_hash=?`,args:[payload.id,res.statusCode,JSON.stringify(payload),key,hash]}).then(()=>{res.set('Idempotency-Key',key);return originalJson(payload);}).catch(error=>{res.status(500);return originalJson({error:'Sale committed but idempotency evidence finalization failed. Retry only with the same idempotency key.',operation_key:key,transaction_id:payload.id,detail:error.message});});
    }
    return db.execute({sql:`UPDATE retail_sale_operations SET status='failed',response_status=?,response_json=?,updated_at=CURRENT_TIMESTAMP WHERE operation_key=? AND request_hash=?`,args:[res.statusCode,JSON.stringify(payload||{}),key,hash]}).then(()=>originalJson(payload)).catch(()=>originalJson(payload));
  };
  next();
});

module.exports=router;
module.exports.ensureSchema=ensureSchema;
module.exports.fingerprint=fingerprint;
