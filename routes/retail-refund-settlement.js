'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');

let readyPromise=null;
async function ensureSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=db.batch([
    {sql:`CREATE TABLE IF NOT EXISTS retail_refund_settlements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      return_id INTEGER NOT NULL UNIQUE REFERENCES returns(id),
      original_transaction_id INTEGER NOT NULL REFERENCES transactions(id),
      return_number TEXT NOT NULL,
      branch_id INTEGER REFERENCES branches(id),
      total REAL NOT NULL,
      settled_by_employee_id INTEGER REFERENCES employees(id),
      settled_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`},
    {sql:`CREATE TABLE IF NOT EXISTS retail_refund_settlement_legs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      settlement_id INTEGER NOT NULL REFERENCES retail_refund_settlements(id),
      payment_method TEXT NOT NULL,
      amount REAL NOT NULL,
      reference_code TEXT,
      UNIQUE(settlement_id,payment_method,reference_code)
    )`},
    {sql:'CREATE INDEX IF NOT EXISTS idx_refund_settlement_return ON retail_refund_settlements(return_id)'}
  ],'write').catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Refund settlement initialization failed',detail:e.message});}});

router.post('/returns/:returnId/settle',requirePermission('transactions_refund'),async(req,res)=>{
  try{
    const returnId=Number(req.params.returnId);if(!returnId)return res.status(400).json({error:'Invalid return id'});
    const {rows:[ret]}=await db.execute({sql:`SELECT r.*,t.status original_status,t.transaction_number original_transaction_number
      FROM returns r JOIN transactions t ON t.id=r.original_transaction_id WHERE r.id=?`,args:[returnId]});
    if(!ret)return res.status(404).json({error:'Return not found'});
    if(ret.resolution!=='refund')return res.status(409).json({error:'Only refund returns require cash/payment settlement'});
    if(String(ret.status||'completed')==='cancelled')return res.status(409).json({error:'Cancelled returns cannot be settled'});
    const {rows:[existing]}=await db.execute({sql:'SELECT * FROM retail_refund_settlements WHERE return_id=?',args:[returnId]});
    if(existing){
      const {rows:legs}=await db.execute({sql:'SELECT * FROM retail_refund_settlement_legs WHERE settlement_id=? ORDER BY id',args:[existing.id]});
      return res.json({...existing,legs,replayed:true});
    }
    let legs=Array.isArray(req.body?.tenders)?req.body.tenders:null;
    if(!legs||!legs.length)legs=[{method:req.body?.payment_method,amount:req.body?.amount,reference_code:req.body?.reference_code||req.body?.approval_code}];
    const allowed=new Set(['cash','card','bank_transfer','check']);
    const normalized=[];let sum=0;
    for(const leg of legs){
      const method=String(leg.method||leg.payment_method||'').trim();
      const amount=Number(leg.amount);
      const ref=String(leg.reference_code||leg.approval_code||'').trim()||null;
      if(!allowed.has(method))return res.status(400).json({error:`Unsupported refund method: ${method||'missing'}`});
      if(!Number.isFinite(amount)||amount<=0)return res.status(400).json({error:'Refund settlement amounts must be greater than zero'});
      if((method==='card'||method==='bank_transfer'||method==='check')&&!ref)return res.status(400).json({error:`${method} refund requires settlement/reference evidence`});
      normalized.push({method,amount:Number(amount.toFixed(2)),reference_code:ref});sum+=amount;
    }
    sum=Number(sum.toFixed(2));const total=Number(Number(ret.total||0).toFixed(2));
    if(Math.abs(sum-total)>0.01)return res.status(400).json({error:`Refund settlement total (${sum.toFixed(2)}) must equal return total (${total.toFixed(2)})`});
    const tx=await db.transaction('write');let committed=false;
    try{
      const r=await tx.execute({sql:`INSERT INTO retail_refund_settlements(return_id,original_transaction_id,return_number,branch_id,total,settled_by_employee_id)
        VALUES(?,?,?,?,?,?)`,args:[returnId,ret.original_transaction_id,ret.return_number,ret.branch_id||null,total,req.employee?.id||null]});
      const settlementId=Number(r.lastInsertRowid);
      for(const leg of normalized)await tx.execute({sql:'INSERT INTO retail_refund_settlement_legs(settlement_id,payment_method,amount,reference_code) VALUES(?,?,?,?)',args:[settlementId,leg.method,leg.amount,leg.reference_code]});
      await tx.commit();committed=true;
      const {rows:[saved]}=await db.execute({sql:'SELECT * FROM retail_refund_settlements WHERE id=?',args:[settlementId]});
      const {rows:savedLegs}=await db.execute({sql:'SELECT * FROM retail_refund_settlement_legs WHERE settlement_id=? ORDER BY id',args:[settlementId]});
      res.status(201).json({...saved,legs:savedLegs});
    }catch(e){if(!committed)await tx.rollback();res.status(committed?500:400).json({error:e.message});}
  }catch(e){res.status(500).json({error:e.message});}
});

module.exports=router;
module.exports.ensureSchema=ensureSchema;
