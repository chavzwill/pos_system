'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');
const {ensureWorkOrderServiceEvidenceSchema}=require('../lib/work-order-service-evidence-schema');
const {ensureTransactionCostEvidenceSchema}=require('../lib/transaction-cost-evidence-schema');

router.use(async(req,res,next)=>{
  try{await Promise.all([ensureWorkOrderServiceEvidenceSchema(),ensureTransactionCostEvidenceSchema()]);next();}
  catch(e){res.status(500).json({error:'Repair runtime schema initialization failed',detail:e.message});}
});

async function validateCashDrawer(req,res,next){
  try{
    const m=String(req.path||'').match(/^\/(\d+)\/(assessment-paid|deposit-paid|final-payment)\/?$/);
    if(!m||req.method!=='PATCH')return next();
    const method=String(req.body?.payment_method||'cash').toLowerCase();
    if(method!=='cash')return next();
    if(req.apiKey)return res.status(403).json({error:'Repair cash payments require an authenticated employee drawer session',control:'work_order_cash_drawer'});
    const {rows:[wo]}=await db.execute({sql:'SELECT id,branch_id,status,assessment_fee,deposit_amount,estimate_labor,estimate_consumables FROM work_orders WHERE id=?',args:[Number(m[1])]});
    if(!wo)return next();
    let amount=0;
    if(m[2]==='assessment-paid')amount=Number(wo.assessment_fee||0);
    else if(m[2]==='deposit-paid')amount=Number(wo.deposit_amount||0);
    else{
      const {rows:[parts]}=await db.execute({sql:'SELECT COALESCE(SUM(total),0) total FROM work_order_items WHERE work_order_id=?',args:[wo.id]});
      amount=Math.max(0,Number((Number(wo.estimate_labor||0)+Number(wo.estimate_consumables||0)+Number(parts?.total||0)-Number(wo.deposit_amount||0)).toFixed(2)));
    }
    if(amount<=0)return next();
    const employeeId=Number(req.employee?.id||req.body?.employee_id)||null;
    const drawerId=Number(req.body?.drawer_session_id)||null;
    if(!employeeId||!drawerId)return res.status(409).json({error:'Cash repair payment requires the cashier and an open drawer session.',control:'work_order_cash_drawer'});
    const {rows:[drawer]}=await db.execute({sql:"SELECT id,employee_id,branch_id,status FROM drawer_sessions WHERE id=?",args:[drawerId]});
    if(!drawer||drawer.status!=='open')return res.status(409).json({error:'The selected cash drawer session is not open.',control:'work_order_cash_drawer'});
    if(Number(drawer.employee_id)!==employeeId)return res.status(409).json({error:'The cash drawer session belongs to a different employee.',control:'work_order_cash_drawer'});
    if(wo.branch_id&&Number(drawer.branch_id)!==Number(wo.branch_id))return res.status(409).json({error:'The cash drawer session belongs to a different branch.',control:'work_order_cash_drawer'});
    req.body.employee_id=employeeId;
    req.body.branch_id=wo.branch_id||drawer.branch_id;
    next();
  }catch(e){res.status(500).json({error:'Unable to verify repair cash custody',detail:e.message});}
}
router.use(validateCashDrawer);

router.patch('/:id/service-evidence',requirePermission('wo_technician'),async(req,res)=>{
  try{
    const diagnosis=String(req.body?.diagnosis||'').trim();
    const repairNotes=String(req.body?.repair_notes||'').trim();
    if(!diagnosis||!repairNotes)return res.status(400).json({error:'Diagnosis and repair notes are both required'});
    const {rows:[wo]}=await db.execute({sql:'SELECT id,status FROM work_orders WHERE id=?',args:[req.params.id]});
    if(!wo)return res.status(404).json({error:'Work order not found'});
    if(!['in_progress','awaiting_signoff'].includes(String(wo.status)))return res.status(409).json({error:`Service evidence cannot be changed while work order is ${wo.status}`});
    await db.execute({sql:'UPDATE work_orders SET diagnosis=?,repair_notes=? WHERE id=?',args:[diagnosis,repairNotes,wo.id]});
    await db.execute({sql:'INSERT INTO work_order_status_log(work_order_id,status,comment,employee_id) VALUES(?,?,?,?)',args:[wo.id,wo.status,'Diagnosis and repair evidence updated',req.employee?.id||null]});
    const {rows:[updated]}=await db.execute({sql:'SELECT id,wo_number,status,diagnosis,repair_notes FROM work_orders WHERE id=?',args:[wo.id]});
    res.json(updated);
  }catch(e){res.status(500).json({error:e.message});}
});
module.exports=router;
