'use strict';
const express=require('express');
const crypto=require('crypto');
const {db}=require('../database');
const router=express.Router();
let readyPromise=null;
function canonical(v){if(Array.isArray(v))return v.map(canonical);if(v&&typeof v==='object')return Object.keys(v).sort().reduce((o,k)=>{if(!['operation_key','idempotency_key'].includes(k))o[k]=canonical(v[k]);return o;},{});return v;}
function hash(body){return crypto.createHash('sha256').update(JSON.stringify(canonical(body||{}))).digest('hex');}
function key(req){return String(req.get('Idempotency-Key')||req.get('X-Idempotency-Key')||req.body?.operation_key||req.body?.idempotency_key||'').trim();}
async function ensureSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=db.batch([
    {sql:`CREATE TABLE IF NOT EXISTS supplier_payment_operations(
      operation_key TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      supplier_payment_id INTEGER REFERENCES supplier_payments(id),
      response_status INTEGER,
      response_json TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME
    )`},
    {sql:'CREATE INDEX IF NOT EXISTS idx_supplier_payment_operations_payment ON supplier_payment_operations(supplier_payment_id)'}
  ],'write').catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Supplier payment operation guard initialization failed',detail:e.message});}});
router.post('/payments',async(req,res,next)=>{
  const operationKey=key(req);
  if(!operationKey)return res.status(428).json({error:'Idempotency-Key is required for supplier payment posting.',code:'IDEMPOTENCY_KEY_REQUIRED'});
  if(operationKey.length<12||operationKey.length>200)return res.status(400).json({error:'Idempotency key must be between 12 and 200 characters',code:'INVALID_IDEMPOTENCY_KEY'});
  const requestHash=hash(req.body);
  const tx=await db.transaction('write');let committed=false;
  try{
    const {rows:[existing]}=await tx.execute({sql:'SELECT * FROM supplier_payment_operations WHERE operation_key=?',args:[operationKey]});
    if(existing){
      await tx.commit();committed=true;
      if(existing.request_hash!==requestHash)return res.status(409).json({error:'Idempotency key was already used for a different supplier payment request'});
      if(existing.status==='completed'&&existing.response_json){
        res.set('Idempotency-Replayed','true');
        return res.status(existing.response_status||200).json({...JSON.parse(existing.response_json),replayed:true});
      }
      return res.status(409).json({error:'This supplier payment operation is already in progress or awaiting reconciliation. Retry with the same idempotency key.'});
    }
    await tx.execute({sql:`INSERT INTO supplier_payment_operations(operation_key,request_hash,status) VALUES(?,?,'pending')`,args:[operationKey,requestHash]});
    await tx.commit();committed=true;
  }catch(e){if(!committed)await tx.rollback();return res.status(409).json({error:e.message});}

  const originalJson=res.json.bind(res);let handled=false;
  res.json=function(payload){
    if(handled)return originalJson(payload);handled=true;
    if(res.statusCode>=200&&res.statusCode<300&&payload?.id){
      return db.execute({sql:`UPDATE supplier_payment_operations SET status='completed',supplier_payment_id=?,response_status=?,response_json=?,updated_at=CURRENT_TIMESTAMP,completed_at=CURRENT_TIMESTAMP WHERE operation_key=? AND request_hash=?`,args:[payload.id,res.statusCode,JSON.stringify(payload),operationKey,requestHash]}).then(()=>{res.set('Idempotency-Key',operationKey);return originalJson(payload);}).catch(error=>{res.status(500);return originalJson({error:'Supplier payment committed but operation evidence finalization failed. Retry only with the same idempotency key.',supplier_payment_id:payload.id,operation_key:operationKey,detail:error.message});});
    }
    return db.execute({sql:`UPDATE supplier_payment_operations SET status='failed',response_status=?,response_json=?,updated_at=CURRENT_TIMESTAMP WHERE operation_key=? AND request_hash=?`,args:[res.statusCode,JSON.stringify(payload||{}),operationKey,requestHash]}).then(()=>originalJson(payload)).catch(()=>originalJson(payload));
  };
  next();
});
module.exports=router;
module.exports.ensureSchema=ensureSchema;
module.exports.hash=hash;
