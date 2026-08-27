'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');

let readyPromise=null;
async function ensureColumn(table,column,ddl){const {rows}=await db.execute({sql:`PRAGMA table_info(${table})`,args:[]});if(!rows.some(r=>r.name===column))await db.execute({sql:`ALTER TABLE ${table} ADD COLUMN ${ddl}`,args:[]});}
async function ensureSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS retail_refund_settlements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        return_id INTEGER NOT NULL UNIQUE REFERENCES returns(id),
        original_transaction_id INTEGER NOT NULL REFERENCES transactions(id),
        return_number TEXT NOT NULL,
        branch_id INTEGER REFERENCES branches(id),
        drawer_session_id INTEGER REFERENCES drawer_sessions(id),
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
      {sql:'CREATE INDEX IF NOT EXISTS idx_refund_settlement_return ON retail_refund_settlements(return_id)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_refund_settlement_drawer ON retail_refund_settlements(drawer_session_id,settled_at)'}
    ],'write');
    await ensureColumn('retail_refund_settlements','drawer_session_id','drawer_session_id INTEGER REFERENCES drawer_sessions(id)');
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Refund settlement initialization failed',detail:e.message});}});

async function originalTenderAvailability(transactionId,transactionTotal){
  const {rows:payments}=await db.execute({sql:'SELECT payment_method,amount FROM transaction_payments WHERE transaction_id=? ORDER BY id',args:[transactionId]});
  const pool={};
  if(payments.length){for(const p of payments){const m=String(p.payment_method||'').trim();pool[m]=Number(((pool[m]||0)+Number(p.amount||0)).toFixed(2));}}
  else{
    const {rows:[tx]}=await db.execute({sql:'SELECT payment_method FROM transactions WHERE id=?',args:[transactionId]});
    if(tx?.payment_method)pool[String(tx.payment_method)]=Number(Number(transactionTotal||0).toFixed(2));
  }
  const {rows:used}=await db.execute({sql:`SELECT l.payment_method,COALESCE(SUM(l.amount),0) amount
    FROM retail_refund_settlement_legs l JOIN retail_refund_settlements s ON s.id=l.settlement_id
    WHERE s.original_transaction_id=? GROUP BY l.payment_method`,args:[transactionId]});
  for(const u of used)pool[u.payment_method]=Number(((pool[u.payment_method]||0)-Number(u.amount||0)).toFixed(2));
  return pool;
}
async function resolveRefundDrawer(req,ret,normalized){
  if(!normalized.some(x=>x.method==='cash'))return null;
  if(req.apiKey){const e=new Error('Cash refunds require an authenticated employee drawer session');e.status=403;throw e;}
  if(!req.employee){const e=new Error('Cash refunds require an authenticated employee');e.status=401;throw e;}
  let drawer=null;
  if(req.body?.drawer_session_id){
    const {rows:[s]}=await db.execute({sql:"SELECT * FROM drawer_sessions WHERE id=? AND status='open'",args:[Number(req.body.drawer_session_id)]});drawer=s||null;
  }else{
    const {rows:[s]}=await db.execute({sql:"SELECT * FROM drawer_sessions WHERE employee_id=? AND branch_id=? AND status='open' ORDER BY opened_at DESC LIMIT 1",args:[req.employee.id,ret.branch_id]});drawer=s||null;
  }
  if(!drawer){const e=new Error('Open the correct cash drawer before settling a cash refund');e.status=409;throw e;}
  if(String(drawer.employee_id)!==String(req.employee.id)){const e=new Error('Cash refund drawer session belongs to another employee');e.status=403;throw e;}
  if(ret.branch_id&&String(drawer.branch_id)!==String(ret.branch_id)){const e=new Error('Cash refund drawer session does not belong to the return branch');e.status=409;throw e;}
  return drawer.id;
}

router.post('/returns/:returnId/settle',requirePermission('transactions_refund'),async(req,res)=>{
  try{
    const returnId=Number(req.params.returnId);if(!returnId)return res.status(400).json({error:'Invalid return id'});
    const {rows:[ret]}=await db.execute({sql:`SELECT r.*,t.status original_status,t.transaction_number original_transaction_number,t.payment_method original_payment_method,t.total original_total,
      a.external_refund_total,a.store_credit_restored,a.customer_entitlement_total
      FROM returns r JOIN transactions t ON t.id=r.original_transaction_id
      LEFT JOIN retail_return_allocations a ON a.return_id=r.id WHERE r.id=?`,args:[returnId]});
    if(!ret)return res.status(404).json({error:'Return not found'});
    if(ret.resolution!=='refund')return res.status(409).json({error:'Only refund returns require cash/payment settlement'});
    if(String(ret.status||'completed')==='cancelled')return res.status(409).json({error:'Cancelled returns cannot be settled'});
    if(ret.original_payment_method==='credit')return res.status(409).json({error:'Charge-account transactions must be reversed through a credit note, not a cash/payment refund'});
    const {rows:[existing]}=await db.execute({sql:'SELECT * FROM retail_refund_settlements WHERE return_id=?',args:[returnId]});
    if(existing){const {rows:legs}=await db.execute({sql:'SELECT * FROM retail_refund_settlement_legs WHERE settlement_id=? ORDER BY id',args:[existing.id]});return res.json({...existing,legs,replayed:true});}

    const total=Number(Number(ret.external_refund_total==null?ret.total:ret.external_refund_total).toFixed(2));
    if(total<=0)return res.status(409).json({error:'This return has no external tender amount to refund; its value was restored as customer/store credit'});
    let legs=Array.isArray(req.body?.tenders)?req.body.tenders:null;
    if(!legs||!legs.length)legs=[{method:req.body?.payment_method,amount:req.body?.amount,reference_code:req.body?.reference_code||req.body?.approval_code}];
    const allowed=new Set(['cash','card','bank_transfer','check']);
    const normalized=[];let sum=0;
    for(const leg of legs){
      const method=String(leg.method||leg.payment_method||'').trim();const amount=Number(leg.amount);const ref=String(leg.reference_code||leg.approval_code||'').trim()||null;
      if(!allowed.has(method))return res.status(400).json({error:`Unsupported refund method: ${method||'missing'}`});
      if(!Number.isFinite(amount)||amount<=0)return res.status(400).json({error:'Refund settlement amounts must be greater than zero'});
      if((method==='card'||method==='bank_transfer'||method==='check')&&!ref)return res.status(400).json({error:`${method} refund requires settlement/reference evidence`});
      normalized.push({method,amount:Number(amount.toFixed(2)),reference_code:ref});sum+=amount;
    }
    sum=Number(sum.toFixed(2));
    if(Math.abs(sum-total)>0.01)return res.status(400).json({error:`Refund settlement total (${sum.toFixed(2)}) must equal the external refundable amount (${total.toFixed(2)})`});
    const available=await originalTenderAvailability(ret.original_transaction_id,ret.original_total);
    const requested={};for(const leg of normalized)requested[leg.method]=Number(((requested[leg.method]||0)+leg.amount).toFixed(2));
    for(const [method,amount] of Object.entries(requested)){const cap=Number(available[method]||0);if(amount-cap>0.01)return res.status(409).json({error:`Refund to ${method} exceeds the remaining amount originally tendered by that method (${Math.max(0,cap).toFixed(2)} available)`});}
    const drawerSessionId=await resolveRefundDrawer(req,ret,normalized);

    const tx=await db.transaction('write');let committed=false;
    try{
      if(drawerSessionId){const {rows:[live]}=await tx.execute({sql:"SELECT id FROM drawer_sessions WHERE id=? AND employee_id=? AND status='open'",args:[drawerSessionId,req.employee?.id||null]});if(!live)throw Object.assign(new Error('Cash refund drawer closed or changed before settlement; retry from the active drawer'),{status:409});}
      const r=await tx.execute({sql:`INSERT INTO retail_refund_settlements(return_id,original_transaction_id,return_number,branch_id,drawer_session_id,total,settled_by_employee_id)
        VALUES(?,?,?,?,?,?,?)`,args:[returnId,ret.original_transaction_id,ret.return_number,ret.branch_id||null,drawerSessionId,total,req.employee?.id||null]});
      const settlementId=Number(r.lastInsertRowid);
      for(const leg of normalized)await tx.execute({sql:'INSERT INTO retail_refund_settlement_legs(settlement_id,payment_method,amount,reference_code) VALUES(?,?,?,?)',args:[settlementId,leg.method,leg.amount,leg.reference_code]});
      await tx.commit();committed=true;
      const {rows:[saved]}=await db.execute({sql:'SELECT * FROM retail_refund_settlements WHERE id=?',args:[settlementId]});
      const {rows:savedLegs}=await db.execute({sql:'SELECT * FROM retail_refund_settlement_legs WHERE settlement_id=? ORDER BY id',args:[settlementId]});
      res.status(201).json({...saved,legs:savedLegs,store_credit_restored:Number(ret.store_credit_restored||0),customer_entitlement_total:Number(ret.customer_entitlement_total||ret.total||0)});
    }catch(e){if(!committed)await tx.rollback();res.status(e.status|| (committed?500:400)).json({error:e.message});}
  }catch(e){res.status(e.status||500).json({error:e.message});}
});

module.exports=router;
module.exports.ensureSchema=ensureSchema;
module.exports.originalTenderAvailability=originalTenderAvailability;
module.exports.resolveRefundDrawer=resolveRefundDrawer;