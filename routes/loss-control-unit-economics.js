'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');
router.use(requirePermission('reports'));
const r2=v=>Number(Number(v||0).toFixed(2));
const pct=(n,d)=>Number(d)>0?r2(100*Number(n||0)/Number(d)):null;
async function table(name){const {rows:[r]}=await db.execute({sql:"SELECT name FROM sqlite_master WHERE type='table' AND name=?",args:[name]});return !!r;}
function days(req){return Math.max(1,Math.min(3650,Number(req.query.days)||90));}

async function serviceJobs(windowDays){
  if(!(await table('work_orders')))return {rows:[],coverage:{grade:'blocked',reason:'work_orders unavailable'}};
  const hasItems=await table('work_order_items'),hasTasks=await table('work_order_tasks'),hasTime=await table('work_order_task_time_entries'),hasRates=await table('technician_pay_rates'),hasConcessions=await table('service_concessions'),hasRefunds=await table('service_refunds');
  const {rows:orders}=await db.execute({sql:`SELECT wo.id,wo.wo_number,wo.branch_id,wo.customer_id,wo.status,wo.created_at,wo.completed_at,wo.picked_up_at,
      COALESCE(wo.assessment_fee,0) assessment_fee,COALESCE(wo.estimate_labor,0) labor_revenue,COALESCE(wo.estimate_consumables,0) consumables_revenue
      FROM work_orders wo WHERE wo.created_at>=datetime('now',?) ORDER BY wo.created_at DESC,wo.id DESC`,args:[`-${windowDays} days`]});
  const rows=[];
  for(const wo of orders){
    let partsRevenue=0,partsCost=null,partsCostComplete=false;
    if(hasItems){
      const {rows:[p]}=await db.execute({sql:`SELECT COALESCE(SUM(total),0) revenue,COALESCE(SUM(CASE WHEN COALESCE(is_customer_supplied,0)=0 THEN COALESCE(unit_cost,0)*COALESCE(quantity,0) ELSE 0 END),0) cost,
        SUM(CASE WHEN COALESCE(is_customer_supplied,0)=0 AND unit_cost IS NULL THEN 1 ELSE 0 END) missing_cost_lines
        FROM work_order_items WHERE work_order_id=?`,args:[wo.id]});
      partsRevenue=Number(p?.revenue||0);partsCost=Number(p?.cost||0);partsCostComplete=Number(p?.missing_cost_lines||0)===0;
    }
    let technicianLaborCost=null,workedHours=null,laborCostComplete=false;
    if(hasTasks&&hasTime&&hasRates){
      const {rows:[t]}=await db.execute({sql:`SELECT COALESCE(SUM((julianday(te.ended_at)-julianday(te.started_at))*24),0) worked_hours,
        COALESCE(SUM(((julianday(te.ended_at)-julianday(te.started_at))*24)*COALESCE((SELECT r.hourly_rate FROM technician_pay_rates r WHERE r.employee_id=te.technician_id AND r.effective_from<=date(te.started_at) AND (r.effective_to IS NULL OR r.effective_to>=date(te.started_at)) ORDER BY r.effective_from DESC,r.id DESC LIMIT 1),0)),0) labor_cost,
        SUM(CASE WHEN (SELECT r.id FROM technician_pay_rates r WHERE r.employee_id=te.technician_id AND r.effective_from<=date(te.started_at) AND (r.effective_to IS NULL OR r.effective_to>=date(te.started_at)) ORDER BY r.effective_from DESC,r.id DESC LIMIT 1) IS NULL THEN 1 ELSE 0 END) missing_rate_entries
        FROM work_order_task_time_entries te JOIN work_order_tasks wt ON wt.id=te.task_id WHERE wt.work_order_id=? AND te.ended_at IS NOT NULL`,args:[wo.id]});
      workedHours=r2(t?.worked_hours);technicianLaborCost=r2(t?.labor_cost);laborCostComplete=Number(t?.missing_rate_entries||0)===0;
    }
    let concessions=0,refunds=0;
    if(hasConcessions){const {rows:[c]}=await db.execute({sql:`SELECT COALESCE(SUM(CASE WHEN status='approved' AND applied_transaction_id IS NOT NULL THEN approved_amount ELSE 0 END),0) amount FROM service_concessions WHERE work_order_id=?`,args:[wo.id]});concessions=Number(c?.amount||0);}
    if(hasRefunds){const {rows:[f]}=await db.execute({sql:`SELECT COALESCE(SUM(CASE WHEN status='settled' THEN refund_amount ELSE 0 END),0) amount FROM service_refunds WHERE work_order_id=?`,args:[wo.id]});refunds=Number(f?.amount||0);}
    const grossService=Number(wo.assessment_fee||0)+Number(wo.labor_revenue||0)+Number(wo.consumables_revenue||0)+partsRevenue;
    const netService=Math.max(0,grossService-concessions-refunds);
    const complete=partsCostComplete&&laborCostComplete&&partsCost!=null&&technicianLaborCost!=null;
    const directCost=complete?r2(partsCost+technicianLaborCost):null;
    const contribution=complete?r2(netService-directCost):null;
    const missing=[];if(!hasItems)missing.push('work_order_items');else if(!partsCostComplete)missing.push('part_cost_evidence');if(!(hasTasks&&hasTime&&hasRates))missing.push('technician_time_or_rate_evidence');else if(!laborCostComplete)missing.push('technician_pay_rate_evidence');
    rows.push({work_order_id:wo.id,wo_number:wo.wo_number,branch_id:wo.branch_id,customer_id:wo.customer_id,status:wo.status,gross_service_value:r2(grossService),applied_concessions:r2(concessions),settled_refunds:r2(refunds),net_service_value:r2(netService),parts_revenue:r2(partsRevenue),parts_cost:partsCost==null?null:r2(partsCost),technician_worked_hours:workedHours,technician_direct_labor_cost:technicianLaborCost,evidence_grade:complete?'complete':missing.length?'partial':'blocked',missing_evidence:missing,direct_cost:directCost,evidenced_contribution:contribution,evidenced_contribution_margin_pct:contribution==null?null:pct(contribution,netService),created_at:wo.created_at,completed_at:wo.completed_at||null});
  }
  const completeRows=rows.filter(x=>x.evidence_grade==='complete'),net=completeRows.reduce((s,x)=>s+Number(x.net_service_value||0),0),cost=completeRows.reduce((s,x)=>s+Number(x.direct_cost||0),0),coverage=pct(completeRows.length,rows.length);
  return {rows,coverage:{total_jobs:rows.length,complete_jobs:completeRows.length,coverage_pct:coverage,evidence_grade:rows.length===0?'blocked':coverage>=95?'complete':coverage>=50?'partial':'limited',evidenced_net_service_value:r2(net),evidenced_direct_cost:r2(cost),evidenced_contribution:r2(net-cost),evidenced_contribution_margin_pct:pct(net-cost,net)}};
}

async function rentalProducts(windowDays){
  if(!(await table('rental_agreements'))||!(await table('rental_agreement_items')))return {rows:[],coverage:{grade:'blocked',reason:'rental agreement evidence unavailable'}};
  const {rows}=await db.execute({sql:`SELECT rai.product_id,p.name product_name,p.sku,
      COUNT(DISTINCT ra.id) rental_agreements,COALESCE(SUM(rai.quantity),0) issued_units,
      COALESCE(SUM(CASE WHEN COALESCE(rai.is_mandatory,0)=0 THEN rai.rental_fee ELSE 0 END),0) core_rental_revenue,
      MIN(ra.created_at) first_rental_at,MAX(ra.created_at) last_rental_at
      FROM rental_agreement_items rai JOIN rental_agreements ra ON ra.id=rai.agreement_id LEFT JOIN products p ON p.id=rai.product_id
      WHERE ra.created_at>=datetime('now',?) AND ra.status NOT IN ('cancelled','pending')
      GROUP BY rai.product_id,p.name,p.sku ORDER BY core_rental_revenue DESC`,args:[`-${windowDays} days`]});
  const out=rows.map(x=>({product_id:x.product_id,product_name:x.product_name,sku:x.sku,rental_agreements:Number(x.rental_agreements||0),issued_units:Number(x.issued_units||0),core_rental_revenue:r2(x.core_rental_revenue),revenue_per_issued_unit:Number(x.issued_units||0)>0?r2(Number(x.core_rental_revenue||0)/Number(x.issued_units)):null,evidence_grade:'partial',missing_evidence:['asset_acquisition_cost_snapshot','asset_specific_maintenance_cost','agreement_level_damage_and_service_allocation'],first_rental_at:x.first_rental_at,last_rental_at:x.last_rental_at}));
  return {rows:out,coverage:{products:out.length,evidence_grade:out.length?'partial':'blocked',note:'Core rental-fee revenue is evidenced, but lifetime ROI is intentionally not claimed until acquisition cost, maintenance cost and agreement-level charges can be assigned to the specific asset/product without guessing.'}};
}

router.get('/unit-economics',async(req,res)=>{
  try{const windowDays=days(req),[service,rentals]=await Promise.all([serviceJobs(windowDays),rentalProducts(windowDays)]);res.json({window_days:windowDays,service_job_economics:{coverage:service.coverage,rows:service.rows.slice(0,250)},rental_product_economics:{coverage:rentals.coverage,rows:rentals.rows.slice(0,250)},methodology:{service:'Service contribution is net service value after applied concessions and settled refunds, less evidenced parts cost and technician direct labor cost. A job is Complete only when both cost dimensions are evidenced.',rental:'Rental product reporting currently shows evidenced core rental revenue and utilization-like activity only. It does not call current catalog cost an acquisition-cost snapshot and does not invent asset ROI.',scope:'These are direct-unit economics, not audited net profit. Overhead, depreciation, financing, taxes and unsupported allocations are excluded.',automatic_actions:false},automatic_actions:false});}catch(e){res.status(500).json({error:e.message});}
});
module.exports=router;
