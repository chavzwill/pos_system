'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');
router.use(requirePermission('reports'));
const r2=v=>Number(Number(v||0).toFixed(2));
async function table(name){const {rows:[r]}=await db.execute({sql:"SELECT name FROM sqlite_master WHERE type='table' AND name=?",args:[name]});return !!r;}
function windowDays(req){return Math.max(1,Math.min(365,Number(req.query.days)||90));}
async function collect(days){
  const events=[];
  if(await table('retail_margin_override_events')){
    const {rows}=await db.execute({sql:`SELECT 'margin_override' event_type,e.transaction_id source_id,e.branch_id,e.cashier_employee_id employee_id,t.customer_id,
      MAX(0,-e.projected_gross_margin) realized_loss,MAX(0,e.required_margin_pct-e.projected_gross_margin_pct) margin_gap_pct,
      e.discount_amount exposure,e.created_at
      FROM retail_margin_override_events e LEFT JOIN transactions t ON t.id=e.transaction_id
      WHERE e.created_at>=datetime('now',?)`,args:[`-${days} days`]});events.push(...rows);
  }
  if(await table('service_concessions')){
    const {rows}=await db.execute({sql:`SELECT 'service_concession' event_type,sc.work_order_id source_id,wo.branch_id,sc.created_by_employee_id employee_id,wo.customer_id,
      CASE WHEN sc.status='approved' THEN sc.approved_amount ELSE 0 END realized_loss,
      0 margin_gap_pct,CASE WHEN sc.status='pending_approval' THEN sc.proposed_amount ELSE 0 END exposure,sc.created_at
      FROM service_concessions sc JOIN work_orders wo ON wo.id=sc.work_order_id WHERE sc.created_at>=datetime('now',?)`,args:[`-${days} days`]});events.push(...rows);
  }
  if(await table('service_refunds')){
    const {rows}=await db.execute({sql:`SELECT 'service_refund' event_type,sr.work_order_id source_id,wo.branch_id,sr.created_by_employee_id employee_id,wo.customer_id,
      CASE WHEN sr.status='settled' THEN sr.refund_amount ELSE 0 END realized_loss,
      0 margin_gap_pct,CASE WHEN sr.status IN ('pending_approval','approved') THEN sr.refund_amount ELSE 0 END exposure,sr.created_at
      FROM service_refunds sr JOIN work_orders wo ON wo.id=sr.work_order_id WHERE sr.created_at>=datetime('now',?)`,args:[`-${days} days`]});events.push(...rows);
  }
  if(await table('retail_promotion_control_events')){
    const {rows}=await db.execute({sql:`SELECT 'promotion_discount' event_type,e.transaction_id source_id,e.branch_id,e.employee_id,t.customer_id,
      0 realized_loss,0 margin_gap_pct,e.authoritative_discount exposure,e.created_at
      FROM retail_promotion_control_events e LEFT JOIN transactions t ON t.id=e.transaction_id WHERE e.created_at>=datetime('now',?)`,args:[`-${days} days`]});events.push(...rows);
  }
  if(await table('inventory_writeoffs')){
    const {rows}=await db.execute({sql:`SELECT 'inventory_writeoff' event_type,w.id source_id,w.branch_id,w.created_by_employee_id employee_id,NULL customer_id,
      COALESCE(w.tracked_value,0) realized_loss,0 margin_gap_pct,0 exposure,w.created_at
      FROM inventory_writeoffs w WHERE w.status='approved' AND w.created_at>=datetime('now',?)`,args:[`-${days} days`]});events.push(...rows);
  }
  return events.map(e=>({...e,realized_loss:r2(e.realized_loss),exposure:r2(e.exposure),margin_gap_pct:r2(e.margin_gap_pct)}));
}
function aggregate(events,key,labelMap={}){const m=new Map();for(const e of events){const id=e[key];if(id==null)continue;const k=String(id);const x=m.get(k)||{id,events:0,realized_loss:0,at_risk_value:0,margin_override_events:0,refund_events:0,concession_events:0,promotion_events:0,writeoff_events:0};x.events++;x.realized_loss+=Number(e.realized_loss||0);x.at_risk_value+=Number(e.exposure||0);if(e.event_type==='margin_override')x.margin_override_events++;if(e.event_type==='service_refund')x.refund_events++;if(e.event_type==='service_concession')x.concession_events++;if(e.event_type==='promotion_discount')x.promotion_events++;if(e.event_type==='inventory_writeoff')x.writeoff_events++;m.set(k,x);}return [...m.values()].map(x=>({...x,name:labelMap[String(x.id)]||null,realized_loss:r2(x.realized_loss),at_risk_value:r2(x.at_risk_value),combined_erosion:r2(x.realized_loss+x.at_risk_value)})).sort((a,b)=>b.combined_erosion-a.combined_erosion);}
async function names(tableName,ids){if(!ids.length)return{};const ph=ids.map(()=>'?').join(',');let sql;if(tableName==='branches')sql=`SELECT id,name FROM branches WHERE id IN (${ph})`;else if(tableName==='employees')sql=`SELECT id,first_name||' '||last_name name FROM employees WHERE id IN (${ph})`;else sql=`SELECT id,first_name||' '||last_name name FROM customers WHERE id IN (${ph})`;const {rows}=await db.execute({sql,args:ids});return Object.fromEntries(rows.map(r=>[String(r.id),r.name]));}
router.get('/systemic-margin-erosion',async(req,res)=>{
  try{
    const days=windowDays(req),events=await collect(days);
    const branchIds=[...new Set(events.map(e=>e.branch_id).filter(Boolean))],employeeIds=[...new Set(events.map(e=>e.employee_id).filter(Boolean))],customerIds=[...new Set(events.map(e=>e.customer_id).filter(Boolean))];
    const [bn,en,cn]=await Promise.all([names('branches',branchIds),names('employees',employeeIds),names('customers',customerIds)]);
    const byBranch=aggregate(events,'branch_id',bn),byEmployee=aggregate(events,'employee_id',en),byCustomer=aggregate(events,'customer_id',cn);
    const realized=r2(events.reduce((s,e)=>s+Number(e.realized_loss||0),0)),risk=r2(events.reduce((s,e)=>s+Number(e.exposure||0),0));
    const types={};for(const e of events){const x=types[e.event_type]||(types[e.event_type]={event_type:e.event_type,events:0,realized_loss:0,at_risk_value:0});x.events++;x.realized_loss+=Number(e.realized_loss||0);x.at_risk_value+=Number(e.exposure||0);}for(const x of Object.values(types)){x.realized_loss=r2(x.realized_loss);x.at_risk_value=r2(x.at_risk_value);x.combined_erosion=r2(x.realized_loss+x.at_risk_value);}
    res.json({window_days:days,headline:{evidence_backed_realized_loss:realized,at_risk_value:risk,combined_erosion:r2(realized+risk),events:events.length},by_type:Object.values(types).sort((a,b)=>b.combined_erosion-a.combined_erosion),by_branch:byBranch.slice(0,50),by_employee_workflow:byEmployee.slice(0,50),by_customer:byCustomer.slice(0,50),methodology:{realized_loss:'Only evidence-backed completed loss/erosion events are included here.',at_risk_value:'Discount, promotion, pending concession/refund and similar exposure is kept separate from realized loss.',employee_warning:'Employee workflow concentration is an operational review signal, not a misconduct finding.',scope_warning:'This view does not yet claim full accounting net contribution; it combines controlled leakage evidence across subsystems without inventing missing COGS or overhead.',writeoff_valuation:'Approved inventory write-offs use tracked inventory value only; untracked value is not invented.'},automatic_actions:false});
  }catch(e){res.status(500).json({error:e.message});}
});
module.exports=router;
