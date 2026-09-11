'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');
const {nextNumber}=require('../lib/nextNumber');
const {runCreditCheck}=require('./customers');
const {calcRentalCommission}=require('./commissions');
const {ensureSchema:ensurePaymentInvariants}=require('../lib/account-payment-invariants');

const money=v=>Number(Number(v||0).toFixed(2));
const cent=v=>Number.isFinite(Number(v))&&Math.abs(Number(v)-money(v))<0.0000001;

router.use(async(req,res,next)=>{try{await ensurePaymentInvariants();next();}catch(e){res.status(500).json({error:'Account payment integrity initialization failed'});}});

router.post('/payments',requirePermission('accounts_payments'),async(req,res)=>{
  const customerId=Number(req.body?.customer_id),raw=Number(req.body?.amount);
  if(!customerId||!Number.isFinite(raw)||raw<=0)return res.status(400).json({error:'customer_id and positive amount required'});
  if(!cent(raw))return res.status(400).json({error:'Account payment amount must use cent precision',code:'ACCOUNT_PAYMENT_AMOUNT_MUST_HAVE_CENT_PRECISION'});
  const amount=money(raw),requested=Array.isArray(req.body?.allocations)&&req.body.allocations.length?req.body.allocations:null;
  if(requested&&requested.some(a=>!Number.isFinite(Number(a.amount))||Number(a.amount)<=0||!cent(a.amount)))return res.status(400).json({error:'Payment allocation amounts must be positive cent-precision values'});

  let paymentNumber;
  try{paymentNumber=await nextNumber(db,'account_payments','payment_number','PMT-',6);}catch(e){return res.status(500).json({error:'Unable to allocate payment number'});}
  const tx=await db.transaction('write');let committed=false;
  try{
    const {rows:[customer]}=await tx.execute({sql:'SELECT * FROM customers WHERE id=? AND active=1',args:[customerId]});
    if(!customer)throw new Error('CUSTOMER_NOT_FOUND');
    const balance=money(customer.account_balance);
    if(balance<=0)throw new Error('NO_RECEIVABLE_BALANCE');
    if(amount-balance>0.001)throw new Error('PAYMENT_EXCEEDS_RECEIVABLE');

    const {rows:rows}=await tx.execute({sql:`SELECT t.id,t.transaction_number,t.total,
      COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa WHERE pa.transaction_id=t.id),0) paid,
      COALESCE((SELECT SUM(caa.amount) FROM customer_account_adjustments caa WHERE caa.transaction_id=t.id AND caa.adjustment_type='credit_note'),0) credits
      FROM transactions t WHERE t.customer_id=? AND t.payment_method='credit' AND t.status='completed'
      AND t.id NOT IN (SELECT checkout_transaction_id FROM rental_agreements WHERE status='returned' AND checkout_transaction_id IS NOT NULL)
      ORDER BY t.created_at,t.id`,args:[customerId]});
    const open=rows.map(r=>({...r,due:money(Number(r.total||0)-Number(r.paid||0)-Number(r.credits||0))})).filter(r=>r.due>0.001);
    const byId=new Map(open.map(r=>[Number(r.id),r]));
    const allocations=[];let remaining=amount;
    if(requested){
      const seen=new Set();let sum=0;
      for(const a of requested){const id=Number(a.transaction_id),value=money(a.amount),inv=byId.get(id);if(!inv)throw new Error('INVOICE_NOT_OPEN');if(seen.has(id))throw new Error('DUPLICATE_INVOICE_ALLOCATION');seen.add(id);if(value-inv.due>0.001)throw new Error('ALLOCATION_EXCEEDS_RECEIVABLE');allocations.push({transaction_id:id,amount:value});sum=money(sum+value);}
      if(Math.abs(sum-amount)>0.001)throw new Error('ALLOCATIONS_MUST_EQUAL_PAYMENT');
    }else{
      for(const inv of open){if(remaining<=0.001)break;const apply=money(Math.min(remaining,inv.due));if(apply>0)allocations.push({transaction_id:inv.id,amount:apply});remaining=money(remaining-apply);}
      if(remaining>0.001)throw new Error('ACCOUNT_DOES_NOT_RECONCILE_TO_OPEN_INVOICES');
    }

    const inserted=await tx.execute({sql:'INSERT INTO account_payments(payment_number,customer_id,employee_id,branch_id,amount,payment_method,notes) VALUES(?,?,?,?,?,?,?)',args:[paymentNumber,customerId,req.employee?.id||null,req.body?.branch_id||null,amount,req.body?.payment_method||'cash',req.body?.notes||null]});
    const paymentId=Number(inserted.lastInsertRowid);
    for(const a of allocations)await tx.execute({sql:'INSERT INTO payment_allocations(payment_id,transaction_id,amount) VALUES(?,?,?)',args:[paymentId,a.transaction_id,a.amount]});
    const updated=await tx.execute({sql:'UPDATE customers SET account_balance=ROUND(account_balance-?,2) WHERE id=? AND ROUND(account_balance,2)>=?',args:[amount,customerId,amount]});
    if(Number(updated.rowsAffected||0)!==1)throw new Error('RECEIVABLE_CHANGED_CONCURRENTLY');
    await tx.commit();committed=true;

    const {rows:[saved]}=await db.execute({sql:'SELECT * FROM account_payments WHERE id=?',args:[paymentId]});
    try{await runCreditCheck(customerId);}catch(e){console.error('Post-payment credit check failed:',e.message);}
    try{
      for(const allocation of allocations){
        const {rows:[rental]}=await db.execute({sql:'SELECT * FROM rental_agreements WHERE checkout_transaction_id=?',args:[allocation.transaction_id]});
        if(!rental)continue;
        const {rows:[checkout]}=await db.execute({sql:'SELECT * FROM transactions WHERE id=?',args:[allocation.transaction_id]});
        if(!checkout)continue;
        const {rows:[paid]}=await db.execute({sql:'SELECT COALESCE(SUM(amount),0) amount FROM payment_allocations WHERE transaction_id=?',args:[allocation.transaction_id]});
        if(money(checkout.total)-money(paid?.amount)>0.001)continue;
        await calcRentalCommission(rental,checkout);
      }
    }catch(e){console.error('Post-payment rental commission check failed:',e.message);}
    return res.status(201).json({...saved,allocations});
  }catch(e){if(!committed)await tx.rollback().catch(()=>{});const status=e.message==='CUSTOMER_NOT_FOUND'?404:409;return res.status(status).json({error:e.message});}
});

module.exports=router;
