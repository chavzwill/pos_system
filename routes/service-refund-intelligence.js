'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requireAnyPermission}=require('../lib/permissions');

router.get('/refunds/intelligence',requireAnyPermission('reports','reports_financial','work_orders_manage'),async(req,res)=>{
  try{
    const days=Math.max(1,Math.min(365,Number(req.query.days)||90));
    const {rows:summary}=await db.execute({sql:`SELECT refund_method,status,COUNT(*) cases,COALESCE(SUM(refund_amount),0) amount FROM service_refunds WHERE created_at>=datetime('now',?) GROUP BY refund_method,status ORDER BY amount DESC`,args:[`-${days} days`]});
    const {rows:creators}=await db.execute({sql:`SELECT sr.created_by_employee_id,e.first_name||' '||e.last_name employee_name,COUNT(*) cases,COALESCE(SUM(CASE WHEN sr.status='settled' THEN sr.refund_amount ELSE 0 END),0) settled_amount FROM service_refunds sr LEFT JOIN employees e ON e.id=sr.created_by_employee_id WHERE sr.created_at>=datetime('now',?) GROUP BY sr.created_by_employee_id,e.first_name,e.last_name HAVING COUNT(*)>0 ORDER BY settled_amount DESC,cases DESC LIMIT 25`,args:[`-${days} days`]});
    const {rows:approvers}=await db.execute({sql:`SELECT sr.approved_by_employee_id,e.first_name||' '||e.last_name employee_name,COUNT(*) approvals,COALESCE(SUM(sr.refund_amount),0) approved_amount FROM service_refunds sr LEFT JOIN employees e ON e.id=sr.approved_by_employee_id WHERE sr.approved_at>=datetime('now',?) AND sr.approved_by_employee_id IS NOT NULL GROUP BY sr.approved_by_employee_id,e.first_name,e.last_name ORDER BY approved_amount DESC,approvals DESC LIMIT 25`,args:[`-${days} days`]});
    const {rows:recent}=await db.execute({sql:`SELECT sr.*,wo.wo_number,c.first_name||' '||c.last_name customer_name,t.transaction_number original_transaction_number,rt.transaction_number refund_transaction_number,ce.first_name||' '||ce.last_name created_by_name,ae.first_name||' '||ae.last_name approved_by_name FROM service_refunds sr JOIN work_orders wo ON wo.id=sr.work_order_id LEFT JOIN customers c ON c.id=wo.customer_id JOIN transactions t ON t.id=sr.original_transaction_id LEFT JOIN transactions rt ON rt.id=sr.refund_transaction_id LEFT JOIN employees ce ON ce.id=sr.created_by_employee_id LEFT JOIN employees ae ON ae.id=sr.approved_by_employee_id WHERE sr.created_at>=datetime('now',?) ORDER BY sr.created_at DESC LIMIT 100`,args:[`-${days} days`]});
    res.json({window_days:days,summary,employee_proposal_patterns:creators,approval_patterns:approvers,recent,note:'Refund concentration is an investigation signal, not proof of misconduct. Review customer circumstances, original payment evidence, authorization and settlement records before drawing conclusions. No customer, employee, payment or accounting record is changed by this intelligence endpoint.'});
  }catch(e){res.status(500).json({error:e.message});}
});
module.exports=router;
