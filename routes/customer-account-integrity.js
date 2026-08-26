'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');

let readyPromise=null;
async function ensureSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=db.batch([
    {sql:`CREATE TABLE IF NOT EXISTS customer_account_adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      transaction_id INTEGER REFERENCES transactions(id),
      return_id INTEGER UNIQUE REFERENCES returns(id),
      adjustment_type TEXT NOT NULL,
      amount REAL NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`},
    {sql:'CREATE INDEX IF NOT EXISTS idx_customer_account_adjustments_customer ON customer_account_adjustments(customer_id)'},
    {sql:'CREATE INDEX IF NOT EXISTS idx_customer_account_adjustments_transaction ON customer_account_adjustments(transaction_id)'},
    {sql:`CREATE TRIGGER IF NOT EXISTS trg_credit_note_account_adjustment
      AFTER INSERT ON returns
      WHEN NEW.resolution='credit_note' AND NEW.customer_id IS NOT NULL AND NEW.total>0
      BEGIN
        INSERT OR IGNORE INTO customer_account_adjustments(customer_id,transaction_id,return_id,adjustment_type,amount)
        VALUES(NEW.customer_id,NEW.original_transaction_id,NEW.id,'credit_note',NEW.total);
      END`}
  ],'write').catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Customer account integrity initialization failed',detail:e.message});}});

async function adjustedInvoices(customerId){
  const {rows}=await db.execute({sql:`SELECT t.id,t.transaction_number,t.total,t.created_at,
      COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa WHERE pa.transaction_id=t.id),0) paid_amount,
      COALESCE((SELECT SUM(caa.amount) FROM customer_account_adjustments caa WHERE caa.transaction_id=t.id AND caa.adjustment_type='credit_note'),0) credit_adjustments
    FROM transactions t
    WHERE t.customer_id=? AND t.payment_method='credit' AND t.status='completed'
      AND t.id NOT IN (SELECT checkout_transaction_id FROM rental_agreements WHERE status='returned' AND checkout_transaction_id IS NOT NULL)
    ORDER BY t.created_at ASC,t.id ASC`,args:[customerId]});
  return rows.map(r=>({...r,balance_due:Number((Number(r.total||0)-Number(r.paid_amount||0)-Number(r.credit_adjustments||0)).toFixed(2))}));
}

router.get('/invoices/:customer_id',requirePermission('accounts'),async(req,res)=>{
  try{const rows=(await adjustedInvoices(req.params.customer_id)).filter(r=>r.balance_due>0.001);res.json(rows);}catch(e){res.status(500).json({error:e.message});}
});

router.get('/aging',requirePermission('accounts'),async(req,res)=>{
  try{
    const {rows:customers}=await db.execute({sql:`SELECT id,customer_number,first_name||' '||last_name customer_name,email,phone,account_balance FROM customers WHERE credit_enabled=1 AND active=1 ORDER BY account_balance DESC`,args:[]});
    const out=[];
    for(const c of customers){
      const inv=await adjustedInvoices(c.id);let current_30=0,days_31_60=0,days_61_90=0,over_90=0;
      for(const x of inv){if(x.balance_due<=0.001)continue;const age=Math.max(0,Math.floor((Date.now()-new Date(x.created_at).getTime())/86400000));if(age<=30)current_30+=x.balance_due;else if(age<=60)days_31_60+=x.balance_due;else if(age<=90)days_61_90+=x.balance_due;else over_90+=x.balance_due;}
      out.push({...c,current_30:Number(current_30.toFixed(2)),days_31_60:Number(days_31_60.toFixed(2)),days_61_90:Number(days_61_90.toFixed(2)),over_90:Number(over_90.toFixed(2))});
    }
    res.json(out);
  }catch(e){res.status(500).json({error:e.message});}
});

router.post('/payments',requirePermission('accounts_payments'),async(req,res,next)=>{
  try{
    const customerId=Number(req.body?.customer_id),amount=Number(req.body?.amount);
    if(!customerId||!Number.isFinite(amount)||amount<=0)return res.status(400).json({error:'customer_id and positive amount required'});
    const {rows:[customer]}=await db.execute({sql:'SELECT * FROM customers WHERE id=? AND active=1',args:[customerId]});
    if(!customer)return res.status(404).json({error:'Customer not found'});
    const balance=Number(customer.account_balance||0);
    if(balance<=0)return res.status(409).json({error:balance<0?'This customer has store credit and no receivable balance to pay':'This customer has no outstanding receivable balance'});
    if(amount-balance>0.01)return res.status(400).json({error:`Payment exceeds the customer outstanding balance (${balance.toFixed(2)})`});
    const invoices=await adjustedInvoices(customerId);const byId=new Map(invoices.map(x=>[Number(x.id),x]));
    let allocations=Array.isArray(req.body?.allocations)&&req.body.allocations.length?req.body.allocations:null;
    if(allocations){
      let sum=0;
      for(const a of allocations){const id=Number(a.transaction_id),v=Number(a.amount),inv=byId.get(id);if(!inv)return res.status(400).json({error:`Invoice ${id} is not an open charge-account invoice for this customer`});if(!Number.isFinite(v)||v<=0)return res.status(400).json({error:'Payment allocation amounts must be positive'});if(v-inv.balance_due>0.01)return res.status(400).json({error:`Allocation exceeds adjusted balance for ${inv.transaction_number} (${inv.balance_due.toFixed(2)})`});sum+=v;}
      if(sum-amount>0.01)return res.status(400).json({error:'Allocated amount cannot exceed payment amount'});
    }else{
      allocations=[];let remaining=amount;
      for(const inv of invoices){if(remaining<=0.001)break;if(inv.balance_due<=0.001)continue;const apply=Number(Math.min(remaining,inv.balance_due).toFixed(2));allocations.push({transaction_id:inv.id,amount:apply});remaining=Number((remaining-apply).toFixed(2));}
      if(remaining>0.01)return res.status(409).json({error:'Customer account balance does not reconcile to open invoices; resolve the account before accepting payment'});
      req.body.allocations=allocations;
    }
    req.body.employee_id=req.employee?.id||req.body.employee_id||null;
    next();
  }catch(e){res.status(500).json({error:e.message});}
});

module.exports=router;
module.exports.ensureSchema=ensureSchema;
