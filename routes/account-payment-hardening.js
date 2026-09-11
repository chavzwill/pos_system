'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');
const {nextNumber}=require('../lib/nextNumber');
const {runCreditCheck}=require('./customers');
const {calcRentalCommission}=require('./commissions');
const {ensureSchema:ensureCustomerAccountIntegrity}=require('./customer-account-integrity');
const {ensureSchema:ensurePaymentInvariants}=require('../lib/account-payment-invariants');

const money=v=>Number(Number(v||0).toFixed(2));
const hasCentPrecision=v=>Number.isFinite(Number(v))&&Math.abs(Number(v)-money(v))<0.0000001;

let readyPromise=null;
async function ensureSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{await ensureCustomerAccountIntegrity();await ensurePaymentInvariants();})().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Account payment integrity initialization failed',detail:e.message});}});

router.post('/payments',requirePermission('accounts_payments'),async(req,res)=>{
  const customerId=Number(req.body?.customer_id), rawAmount=Number(req.body?.amount);
  if(!customerId||!Number.isFinite(rawAmount)||rawAmount<=0)return res.status(400).json({error:'customer_id and positive amount required'});
  if(!hasCentPrecision(rawAmount))return res.status(400).json({error:'Account payment amount must use cent precision',code:'ACCOUNT_PAYMENT_AMOUNT_MUST_HAVE_CENT_PRECISION'});
  const amount=money(rawAmount);
  const requested=Array.isArray(req.body?.allocations)&&req.body.allocations.length?req.body.allocations:null;
  if(requested){
    for(const a of requested){if(!Number.isFinite(Number(a.amount))||Number(a.amount)<=0||!hasCentPrecision(a.amount))return res.status(400).json({error:'Payment allocation amounts must be positive cent-precision values'});}
  }

  let paymentNumber;
  try{paymentNumber=await nextNumber(db,'account_payments','payment_number','PMT-',6);}catch(e){return res.status(500).json({error:'Unable to allocate payment number'});}
  const tx=await db.transaction('write');let committed=false;
  try{
    const {rows:[customer]}=await tx.execute({sql:'SELECT * FROM customers WHERE id=? AND active=1',args:[customerId]});
    if(!customer){await tx.rollback();return res.status(404).json({error:'Customer not found'});}
    const balance=money(customer.account_balance);
    if(balance<=0){await tx.rollback();return res.status(409).json({error:balance<0?'This customer has store credit and no receivable balance to pay':'This customer has no outstanding receivable balance'});}
    if(amount-balance>0.001){await tx.rollback();return res.status(409).json({error:`Payment exceeds the customer outstanding balance (${balance.toFixed(2)})`});}

    const {rows:invoices}=await tx.execute({sql:`SELECT t.id,t.transaction_number,t.total,t.created_at,
      COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa WHERE pa.transaction_id=t.id),0) paid_amount,
      COALESCE((SELECT SUM(caa.amount) FROM customer_account_adjustments caa WHERE caa.transaction_id=t.id AND caa.adjustment_type='credit_note'),0) credit_adjustments
      FROM transactions t
      WHERE t.customer_id=? AND t.payment_method='credit' AND t.status='completed'
        AND t.id NOT IN (SELECT checkout_transaction_id FROM rental_agreements WHERE status='returned' AND checkout_transaction_id IS NOT NULL)
      ORDER BY t.created_at ASC,t.id ASC`,args:[customerId]});
    const open=invoices.map(i=>({...i,balance_due:money(Number(i.total||0)-Number(i.paid_amount||0)-Number(i.credit_adjustments||0))})).filter(i=>i.balance_due>0.001);
    const byId=new Map(open.map(i=>[Number(i.id),i]));
    let allocations=[];
    if(requested){
      const seen=new Set();let sum=0;
      for(const a of requested){
        const id=Number(a.transaction_id), value=money(a.amount), inv=byId.get(id);
        if(!inv)throw new Error(`Invoice ${id} is not an open charge-account invoice for this customer`);
        if(seen.has(id))throw new Error(`Invoice ${id} appears more than once in the allocation`);
        seen.add(id);
        if(value-inv.balance_due>0.001)throw new Error(`Allocation exceeds adjusted balance for ${inv.transaction_number} (${inv.balance_due.toFixed(2)})`);
        allocations.push({transaction_id:id,amount:value});sum=money(sum+value);
      }
      if(Math.abs(sum-amount)>0.001)throw new Error('Allocated amount must exactly equal the payment amount');
    }else{
      let remaining=amount;
      for(const inv of open){
        if(remaining<=0.001)break;
        const apply=money(Math.min(remaining,inv.balance_due));
        if(apply>0)allocations.push({transaction_id:inv.id,amount:apply});
        remaining=money(remaining-apply);
      }
      if(remaining>0.001)throw new Error('Customer account balance does not reconcile to open invoices; resolve the account before accepting payment');
    }

    const result=await tx.execute({sql:'INSERT INTO account_payments(payment_number,customer_id,employee_id,branch_id,amount,payment_method,notes) VALUES(?,?,?,?,?,?,?)',args:[paymentNumber,customerId,req.employee?.id||req.body?.employee_id||null,req.body?.branch_id||null,amount,req.body?.payment_method||'cash',req.body?.notes||null]});
    const paymentId=Number(result.lastInsertRowid);
    for(const alloc of allocations)await tx.execute({sql:'INSERT INTO payment_allocations(payment_id,transaction_id,amount) VALUES(?,?,?)',args:[paymentId,alloc.transaction_id,alloc.amount]});
    const upd=await tx.execute({sql:'UPDATE customers SET account_balance=ROUND(account_balance-?,2) WHERE id=? AND ROUND(account_balance,2)>=?',args:[amount,customerId,amount]});
    if(Number(upd.rowsAffected||0)!==1)throw new Error('ACCOUNT_PAYMENT_RECEIVABLE_CHANGED_CONCURRENTLY');
    await tx.commit();committed=true;

    const {rows:[saved]}=await db.execute({sql:`SELECT p.*,c.first_name||' '||c.last_name customer_name FROM account_payments p LEFT JOIN customers c ON c.id=p.customer_id WHERE p.id=?`,args:[paymentId]});
    try{await runCreditCheck(customerId);}catch(e){}
    try{
      for(const alloc of allocations){
        const {rows:[rental]}=await db.execute({sql:'SELECT * FROM rental_agreements WHERE checkout_transaction_id=?',args:[alloc.transaction_id]});
        if(!rental)continue;
        const {rows:[checkout]}=await db.execute({sql:'SELECT * FROM transactions WHERE id=?',args:[alloc.transaction_id]});
        const {rows:[paidRow]}=await db.execute({sql:'SELECT COALESCE(SUM(amount),0) paid FROM payment_allocations WHERE transaction_id=?',args:[alloc.transaction_id]});
        if(checkout&&Number(checkout.total||0)-Number(paidRow?.paid||0)<=0.001)await calcRentalCommission(rental,checkout);
      }
    }catch(e){}
    return res.status(201).json({...saved,allocations});
  }catch(e){
    if(!committed)await tx.rollback().catch(()=>{});
    return res.status(committed?500:409).json({error:e.message});
  }
});

module.exports=router;
module.exports.ensureSchema=ensureSchema;
