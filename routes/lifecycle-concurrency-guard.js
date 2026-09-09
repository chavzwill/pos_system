'use strict';
const express=require('express');
const crypto=require('crypto');
const router=express.Router();
const {db}=require('../database');

let readyPromise=null;
async function ensureSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=db.batch([
    {sql:`CREATE TABLE IF NOT EXISTS lifecycle_operation_locks(
      resource_key TEXT PRIMARY KEY,
      lock_token TEXT NOT NULL,
      actor_key TEXT,
      acquired_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL
    )`},
    {sql:'CREATE INDEX IF NOT EXISTS idx_lifecycle_operation_locks_expiry ON lifecycle_operation_locks(expires_at)'}
  ],'write').catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}

function actorKey(req){
  if(req.apiKey)return `api:${req.apiKey.id||req.apiKey.key_id||'key'}`;
  if(req.employee)return `employee:${req.employee.id}`;
  return 'anonymous';
}
function matchId(path,re){const m=String(path||'').match(re);return m?String(m[1]):null;}
function resourceFor(req){
  const p=String(req.path||'');
  const method=String(req.method||'').toUpperCase();
  let id;
  if(method==='PATCH'&&(id=matchId(p,/^\/purchase-orders\/(\d+)\/receive$/)))return `purchase_order:${id}:receiving`;
  if(method==='PATCH'&&(id=matchId(p,/^\/rentals\/agreements\/(\d+)\/(?:checkout|issue|return|collect-balance)$/)))return `rental_agreement:${id}:lifecycle`;
  if(method==='PATCH'&&(id=matchId(p,/^\/work-orders\/(\d+)\/(?:signoff|assessment-paid|deposit-paid|final-payment)$/)))return `work_order:${id}:financial_lifecycle`;
  if(method==='POST'&&(id=matchId(p,/^\/transactions\/(\d+)\/return$/)))return `transaction:${id}:return`;
  if(method==='PATCH'&&(id=matchId(p,/^\/transactions\/(\d+)\/void$/)))return `transaction:${id}:void`;
  if(method==='POST'&&p==='/transactions'&&req.body?.source_hold_id)return `held_sale:${Number(req.body.source_hold_id)}:recall`;
  if(method==='POST'&&p==='/transactions'&&req.body?.quote_id)return `quotation:${Number(req.body.quote_id)}:checkout`;
  if(method==='POST'&&(id=matchId(p,/^\/quotations\/(\d+)\/convert$/)))return `quotation:${id}:convert`;
  if(method==='PATCH'&&(id=matchId(p,/^\/quotations\/(\d+)\/status$/)))return `quotation:${id}:status`;
  if(method==='PATCH'&&(id=matchId(p,/^\/transfers\/(\d+)\/receive$/)))return `transfer:${id}:receive`;
  if(method==='POST'&&(id=matchId(p,/^\/logistics-intelligence\/from-purchase-order\/(\d+)$/)))return `dispatch:purchase_order:${id}:supplier_pickup`;
  if(method==='POST'&&(id=matchId(p,/^\/logistics-intelligence\/from-sales-invoice\/(\d+)$/)))return `dispatch:sales_invoice:${id}:customer_delivery`;
  if(method==='POST'&&(id=matchId(p,/^\/logistics-intelligence\/from-rental\/(\d+)$/))){
    const direction=String(req.body?.direction||'delivery').toLowerCase()==='pickup'?'pickup':'delivery';
    return `dispatch:rental:${id}:${direction}`;
  }
  if(method==='POST'&&(id=matchId(p,/^\/logistics-intelligence\/from-repair\/(\d+)$/))){
    const direction=String(req.body?.direction||req.body?.job_type||'pickup').toLowerCase();
    return `dispatch:repair:${id}:${direction}`;
  }
  return null;
}
function requiresRequestIdentity(req){
  if(req.apiKey)return false;
  const method=String(req.method).toUpperCase();
  if(method==='POST'&&(req.path==='/transactions'||req.path==='/rentals/agreements'||/^\/quotations\/\d+\/convert$/.test(req.path)))return true;
  if(method==='PATCH'&&/^\/transactions\/\d+\/void$/.test(req.path))return true;
  return false;
}
async function acquire(resourceKey,req){
  const token=crypto.randomUUID();
  const tx=await db.transaction('write');let committed=false;
  try{
    await tx.execute({sql:"DELETE FROM lifecycle_operation_locks WHERE expires_at<=CURRENT_TIMESTAMP",args:[]});
    await tx.execute({sql:`INSERT OR IGNORE INTO lifecycle_operation_locks(resource_key,lock_token,actor_key,expires_at) VALUES(?,?,?,datetime('now','+45 seconds'))`,args:[resourceKey,token,actorKey(req)]});
    const {rows:[row]}=await tx.execute({sql:'SELECT lock_token,actor_key,expires_at FROM lifecycle_operation_locks WHERE resource_key=?',args:[resourceKey]});
    await tx.commit();committed=true;
    return row?.lock_token===token?{token,row}:null;
  }catch(e){if(!committed)await tx.rollback();throw e;}
}
async function release(resourceKey,token){
  try{await db.execute({sql:'DELETE FROM lifecycle_operation_locks WHERE resource_key=? AND lock_token=?',args:[resourceKey,token]});}catch(e){}
}

router.use(async(req,res,next)=>{
  try{
    if(['GET','HEAD','OPTIONS'].includes(String(req.method).toUpperCase()))return next();
    await ensureSchema();
    if(requiresRequestIdentity(req)&&!String(req.get('Idempotency-Key')||'').trim()){
      return res.status(428).json({error:'This state-changing POS operation requires an Idempotency-Key so a lost response cannot create a duplicate business event.',control:'operation_identity_required'});
    }
    const resourceKey=resourceFor(req);
    if(!resourceKey)return next();
    const lock=await acquire(resourceKey,req);
    if(!lock){
      res.set('Retry-After','1');
      return res.status(409).json({error:'Another request is already changing this business record. Wait for it to finish, then refresh before retrying.',control:'lifecycle_concurrency',resource:resourceKey});
    }
    let released=false;
    const cleanup=()=>{if(released)return;released=true;void release(resourceKey,lock.token);};
    // Do not release on client connection close. A disconnect can happen after
    // the server has started committing the mutation but before the response is
    // observed. Holding the lock until a normal finish (or bounded expiry) keeps
    // a new request from racing an ambiguous in-flight business outcome.
    res.once('finish',cleanup);
    req.lifecycleConcurrency={resourceKey,lockToken:lock.token};
    next();
  }catch(e){res.status(500).json({error:'Lifecycle concurrency protection failed',detail:e.message,control:'lifecycle_concurrency'});}
});

module.exports=router;
module.exports.ensureSchema=ensureSchema;
module.exports.resourceFor=resourceFor;
module.exports.acquire=acquire;
module.exports.release=release;
module.exports.requiresRequestIdentity=requiresRequestIdentity;
