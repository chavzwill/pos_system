'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');
const {ensureSchema:ensureCustomerAccountIntegrity}=require('./customer-account-integrity');

router.post('/:id/return',requirePermission('transactions_returns'),async(req,res,next)=>{
  try{
    if(req.body?.resolution==='replacement')return next();
    const allowed=new Set(['refund','credit_note']);
    const resolution=String(req.body?.resolution||'').trim();
    if(!allowed.has(resolution))return res.status(400).json({error:'Return resolution must be refund, credit_note, or replacement'});
    const {rows:[tx]}=await db.execute({sql:'SELECT * FROM transactions WHERE id=?',args:[req.params.id]});
    if(!tx)return res.status(404).json({error:'Transaction not found'});
    if(tx.status!=='completed')return res.status(409).json({error:'Only completed transactions can be returned'});
    const {rows:[rental]}=await db.execute({sql:'SELECT agreement_number FROM rental_agreements WHERE checkout_transaction_id=? OR settlement_transaction_id=?',args:[tx.id,tx.id]});
    if(rental)return res.status(409).json({error:`Transaction belongs to rental agreement ${rental.agreement_number}; use the Rentals return workflow.`});
    const items=Array.isArray(req.body?.items)?req.body.items:[];
    if(!items.length)return res.status(400).json({error:'No items selected for return'});
    for(const item of items){const qty=Number(item.quantity);if(!Number.isInteger(qty)||qty<=0)return res.status(400).json({error:'Return quantities must be positive whole numbers'});}
    if(resolution==='credit_note'&&!tx.customer_id)return res.status(400).json({error:'A credit note requires a customer on the original transaction'});
    if(tx.payment_method==='credit'&&resolution==='refund')return res.status(409).json({error:'Charge-account sales must be returned as a credit note so Accounts Receivable is reduced before any customer credit is created'});
    if(resolution==='credit_note')await ensureCustomerAccountIntegrity();
    req.body.employee_id=req.employee?.id||req.body.employee_id||tx.employee_id||null;
    next();
  }catch(e){res.status(500).json({error:e.message});}
});

module.exports=router;
