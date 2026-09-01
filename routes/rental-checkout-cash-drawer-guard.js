'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {ensureTransactionCostEvidenceSchema}=require('../lib/transaction-cost-evidence-schema');

router.use(async(req,res,next)=>{
  try{await ensureTransactionCostEvidenceSchema();next();}
  catch(e){res.status(500).json({error:'Rental transaction cost-evidence initialization failed',detail:e.message});}
});

router.patch('/agreements/:id/checkout',async(req,res,next)=>{
  try{
    if(String(req.body?.payment_method||'cash').toLowerCase()!=='cash')return next();
    const employeeId=Number(req.body?.employee_id||req.employee?.id)||null;
    const drawerSessionId=Number(req.body?.drawer_session_id)||null;
    const {rows:[agreement]}=await db.execute({sql:'SELECT id,branch_id,status FROM rental_agreements WHERE id=?',args:[req.params.id]});
    if(!agreement)return next();
    if(agreement.status!=='pending')return next();
    if(!employeeId||!drawerSessionId)return res.status(409).json({error:'Cash rental checkout requires the cashier and an open drawer session.',control:'rental_checkout_cash_drawer'});
    const {rows:[session]}=await db.execute({sql:"SELECT id,employee_id,branch_id,status FROM drawer_sessions WHERE id=?",args:[drawerSessionId]});
    if(!session||session.status!=='open')return res.status(409).json({error:'The selected cash drawer session is not open.',control:'rental_checkout_cash_drawer'});
    if(Number(session.employee_id)!==employeeId)return res.status(409).json({error:'The cash drawer session belongs to a different employee.',control:'rental_checkout_cash_drawer'});
    if(Number(session.branch_id)!==Number(agreement.branch_id))return res.status(409).json({error:'The cash drawer session belongs to a different branch.',control:'rental_checkout_cash_drawer'});
    req.body.employee_id=employeeId;
    req.body.drawer_session_id=drawerSessionId;
    next();
  }catch(e){res.status(500).json({error:e.message});}
});

module.exports=router;
