'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');
router.use(requirePermission('reports'));
const r2=v=>Number(Number(v||0).toFixed(2));
async function table(name){const {rows:[r]}=await db.execute({sql:"SELECT name FROM sqlite_master WHERE type='table' AND name=?",args:[name]});return !!r;}
function windowDays(req){return Math.max(1,Math.min(365,Number(req.query.days)||90));}
function safeJson(v){try{return JSON.parse(v||'{}')}catch{return{}}}
function pct(n,d){return Number(d)>0?r2(100*Number(n||0)/Number(d)):null;}

async function collect(days,offsetDays=0){
  const events=[],range=`-${days+offsetDays} days`,cutoff=offsetDays?`-${offsetDays} days`:null;
  const timeClause=col=>cutoff?`${col}>=datetime('now',?) AND ${col}<datetime('now',?)`:`${col}>=datetime('now',?)`;
  const args=()=>cutoff?[range,cutoff]:[range];
  if(await table('retail_margin_override_events')){
    const {rows}=await db.execute({sql:`SELECT 'margin_override' event_type,e.transaction_id source_id,e.branch_id,e.cashier_employee_id employee_id,t.customer_id,
      MAX(0,-e.projected_gross_margin) realized_loss,MAX(0,e.required_margin_pct-e.projected_gross_margin_pct) margin_gap_pct,
      e.discount_amount exposure,e.evidence_json,e.created_at
      FROM retail_margin_override_events e LEFT JOIN transactions t ON t.id=e.transaction_id
      WHERE ${timeClause('e.created_at')}`,args:args()});events.push(...rows);
  }
  if(await table('service_concessions')){
    const {rows}=await db.execute({sql:`SELECT 'service_concession' event_type,sc.work_order_id source_id,wo.branch_id,sc.created_by_employee_id employee_id,wo.customer_id,
      CASE WHEN sc.status='approved' THEN sc.approved_amount ELSE 0 END realized_loss,
      0 margin_gap_pct,CASE WHEN sc.status='pending_approval' THEN sc.proposed_amount ELSE 0 END exposure,sc.created_at
      FROM service_concessions sc JOIN work_orders wo ON wo.id=sc.work_order_id WHERE ${timeClause('sc.created_at')}`,args:args()});events.push(...rows);
  }
  if(await table('service_refunds')){
    const {rows}=await db.execute({sql:`SELECT 'service_refund' event_type,sr.work_order_id source_id,wo.branch_id,sr.created_by_employee_id employee_id,wo.customer_id,
      CASE WHEN sr.status='settled' THEN sr.refund_amount ELSE 0 END realized_loss,
      0 margin_gap_pct,CASE WHEN sr.status IN ('pending_approval','approved') THEN sr.refund_amount ELSE 0 END exposure,sr.created_at
      FROM service_refunds sr JOIN work_orders wo ON wo.id=sr.work_order_id WHERE ${timeClause('sr.created_at')}`,args:args()});events.push(...rows);
  }
  if(await table('retail_promotion_control_events')){
    const {rows}=await db.execute({sql:`SELECT 'promotion_discount' event_type,e.transaction_id source_id,e.branch_id,e.employee_id,t.customer_id,
      0 realized_loss,0 margin_gap_pct,e.authoritative_discount exposure,e.created_at
      FROM retail_promotion_control_events e LEFT JOIN transactions t ON t.id=e.transaction_id WHERE ${timeClause('e.created_at')}`,args:args()});events.push(...rows);
  }
  if(await table('inventory_writeoffs')){
    const {rows}=await db.execute({sql:`SELECT 'inventory_writeoff' event_type,w.id source_id,w.branch_id,w.created_by_employee_id employee_id,NULL customer_id,w.product_id,
      COALESCE(w.tracked_value,0) realized_loss,0 margin_gap_pct,0 exposure,w.created_at
      FROM inventory_writeoffs w WHERE w.status='approved' AND ${timeClause('w.created_at')}`,args:args()});events.push(...rows);
  }
  return events.map(e=>({...e,realized_loss:r2(e.realized_loss),exposure:r2(e.exposure),margin_gap_pct:r2(e.margin_gap_pct)}));
}

function aggregate(events,key,labelMap={}){
  const m=new Map();
  for(const e of events){const id=e[key];if(id==null)continue;const k=String(id);const x=m.get(k)||{id,events:0,realized_loss:0,at_risk_value:0,event_types:new Set(),margin_override_events:0,refund_events:0,concession_events:0,promotion_events:0,writeoff_events:0};x.events++;x.realized_loss+=Number(e.realized_loss||0);x.at_risk_value+=Number(e.exposure||0);x.event_types.add(e.event_type);if(e.event_type==='margin_override')x.margin_override_events++;if(e.event_type==='service_refund')x.refund_events++;if(e.event_type==='service_concession')x.concession_events++;if(e.event_type==='promotion_discount')x.promotion_events++;if(e.event_type==='inventory_writeoff')x.writeoff_events++;m.set(k,x);}
  return [...m.values()].map(x=>{const eventTypes=[...x.event_types];return {...x,event_types:eventTypes,control_types:eventTypes.length,cross_control_pattern:eventTypes.length>=2,name:labelMap[String(x.id)]||null,realized_loss:r2(x.realized_loss),at_risk_value:r2(x.at_risk_value),combined_erosion:r2(x.realized_loss+x.at_risk_value)}}).sort((a,b)=>b.combined_erosion-a.combined_erosion);
}
async function names(tableName,ids){if(!ids.length)return{};const ph=ids.map(()=>'?').join(',');let sql;if(tableName==='branches')sql=`SELECT id,name FROM branches WHERE id IN (${ph})`;else if(tableName==='employees')sql=`SELECT id,first_name||' '||last_name name FROM employees WHERE id IN (${ph})`;else if(tableName==='products')sql=`SELECT id,name FROM products WHERE id IN (${ph})`;else if(tableName==='suppliers')sql=`SELECT id,name FROM suppliers WHERE id IN (${ph})`;else sql=`SELECT id,first_name||' '||last_name name FROM customers WHERE id IN (${ph})`;const {rows}=await db.execute({sql,args:ids});return Object.fromEntries(rows.map(r=>[String(r.id),r.name]));}

async function productErosion(days){
  const rows=[];
  if(await table('inventory_writeoffs')){
    const {rows:w}=await db.execute({sql:`SELECT w.product_id,p.name product_name,p.sku,COUNT(*) writeoff_events,COALESCE(SUM(w.tracked_value),0) realized_loss
      FROM inventory_writeoffs w JOIN products p ON p.id=w.product_id WHERE w.status='approved' AND w.created_at>=datetime('now',?) GROUP BY w.product_id,p.name,p.sku`,args:[`-${days} days`]});
    for(const x of w)rows.push({product_id:x.product_id,product_name:x.product_name,sku:x.sku,realized_loss:r2(x.realized_loss),at_risk_value:0,writeoff_events:Number(x.writeoff_events||0),margin_override_events:0});
  }
  if(await table('retail_margin_override_events')){
    const {rows:m}=await db.execute({sql:`SELECT id,evidence_json,projected_gross_margin,discount_amount,gross_revenue FROM retail_margin_override_events WHERE created_at>=datetime('now',?)`,args:[`-${days} days`]});
    for(const ev of m){const evidence=safeJson(ev.evidence_json),lines=Array.isArray(evidence.lines)?evidence.lines:[],gross=Math.max(0,Number(ev.gross_revenue||0)),discount=Math.max(0,Number(ev.discount_amount||0));for(const line of lines){const productId=Number(line.product_id)||null;if(!productId)continue;const lineGross=Math.max(0,Number(line.line_gross||0)),share=gross>0?lineGross/gross:(lines.length?1/lines.length:0),lineDiscount=discount*share,lineNet=Math.max(0,lineGross-lineDiscount),lineCost=Math.max(0,Number(line.line_cost||0)),loss=Math.max(0,lineCost-lineNet);rows.push({product_id:productId,product_name:line.name||null,sku:line.sku||null,realized_loss:r2(loss),at_risk_value:r2(lineDiscount),writeoff_events:0,margin_override_events:1});}}
  }
  const m=new Map();for(const x of rows){const k=String(x.product_id),v=m.get(k)||{product_id:x.product_id,product_name:x.product_name,sku:x.sku,realized_loss:0,at_risk_value:0,writeoff_events:0,margin_override_events:0};v.product_name=v.product_name||x.product_name;v.sku=v.sku||x.sku;v.realized_loss+=Number(x.realized_loss||0);v.at_risk_value+=Number(x.at_risk_value||0);v.writeoff_events+=Number(x.writeoff_events||0);v.margin_override_events+=Number(x.margin_override_events||0);m.set(k,v);}return [...m.values()].map(x=>({...x,realized_loss:r2(x.realized_loss),at_risk_value:r2(x.at_risk_value),combined_erosion:r2(x.realized_loss+x.at_risk_value)})).sort((a,b)=>b.combined_erosion-a.combined_erosion);
}

async function supplierErosion(days){
  if(!(await table('procurement_outcome_snapshots'))||!(await table('procurement_decision_po_links'))||!(await table('purchase_orders')))return [];
  const {rows}=await db.execute({sql:`WITH latest AS (
      SELECT s.* FROM procurement_outcome_snapshots s JOIN (SELECT review_id,MAX(id) id FROM procurement_outcome_snapshots WHERE captured_at>=datetime('now',?) GROUP BY review_id) x ON x.id=s.id
    ), supplier_sets AS (
      SELECT l.review_id,COUNT(DISTINCT po.supplier_id) supplier_count,MIN(po.supplier_id) supplier_id,GROUP_CONCAT(DISTINCT s.name) supplier_names
      FROM procurement_decision_po_links l JOIN purchase_orders po ON po.id=l.po_id LEFT JOIN suppliers s ON s.id=po.supplier_id GROUP BY l.review_id
    )
    SELECT latest.*,ss.supplier_count,CASE WHEN ss.supplier_count=1 THEN ss.supplier_id ELSE NULL END supplier_id,ss.supplier_names
    FROM latest JOIN supplier_sets ss ON ss.review_id=latest.review_id ORDER BY latest.cost_variance DESC`,args:[`-${days} days`]});
  const m=new Map();for(const x of rows){const variance=Number(x.cost_variance||0),loss=Math.max(0,variance),saving=Math.max(0,-variance),key=x.supplier_id?`supplier:${x.supplier_id}`:`mixed:${x.review_id}`,v=m.get(key)||{supplier_id:x.supplier_id||null,supplier_name:x.supplier_count===1?x.supplier_names:'Mixed sourcing',decision_reviews:0,realized_cost_overrun:0,realized_savings:0,actual_landed_cost:0,expected_landed_cost:0,mixed_sourcing:x.supplier_count!==1};v.decision_reviews++;v.realized_cost_overrun+=loss;v.realized_savings+=saving;v.actual_landed_cost+=Number(x.actual_landed_cost||0);v.expected_landed_cost+=Number(x.expected_landed_cost||0);m.set(key,v);}return [...m.values()].map(x=>({...x,realized_cost_overrun:r2(x.realized_cost_overrun),realized_savings:r2(x.realized_savings),actual_landed_cost:r2(x.actual_landed_cost),expected_landed_cost:r2(x.expected_landed_cost),net_variance:r2(x.realized_cost_overrun-x.realized_savings)})).sort((a,b)=>b.realized_cost_overrun-a.realized_cost_overrun);
}

async function branchTransactionValue(days){
  if(!(await table('transactions')))return{};
  const {rows}=await db.execute({sql:`SELECT branch_id,COALESCE(SUM(CASE WHEN total>0 THEN total ELSE 0 END),0) posted_value,COUNT(CASE WHEN total>0 THEN 1 END) positive_transactions FROM transactions WHERE created_at>=datetime('now',?) AND status='completed' GROUP BY branch_id`,args:[`-${days} days`]});
  return Object.fromEntries(rows.map(x=>[String(x.branch_id),{posted_value:r2(x.posted_value),positive_transactions:Number(x.positive_transactions||0)}]));
}
function branchRatios(rows,posted){return rows.map(x=>{const p=posted[String(x.id)]||{posted_value:0,positive_transactions:0};return {...x,posted_positive_transaction_value:p.posted_value,positive_transactions:p.positive_transactions,realized_loss_to_posted_value_pct:pct(x.realized_loss,p.posted_value),combined_erosion_to_posted_value_pct:pct(x.combined_erosion,p.posted_value)};});}
function headline(events){const realized=r2(events.reduce((s,e)=>s+Number(e.realized_loss||0),0)),risk=r2(events.reduce((s,e)=>s+Number(e.exposure||0),0));return {evidence_backed_realized_loss:realized,at_risk_value:risk,combined_erosion:r2(realized+risk),events:events.length};}

router.get('/systemic-margin-erosion',async(req,res)=>{
  try{
    const days=windowDays(req),events=await collect(days),previous=await collect(days,days);
    const branchIds=[...new Set(events.map(e=>e.branch_id).filter(Boolean))],employeeIds=[...new Set(events.map(e=>e.employee_id).filter(Boolean))],customerIds=[...new Set(events.map(e=>e.customer_id).filter(Boolean))];
    const [bn,en,cn,products,suppliers,posted]=await Promise.all([names('branches',branchIds),names('employees',employeeIds),names('customers',customerIds),productErosion(days),supplierErosion(days),branchTransactionValue(days)]);
    const byBranch=branchRatios(aggregate(events,'branch_id',bn),posted),byEmployee=aggregate(events,'employee_id',en),byCustomer=aggregate(events,'customer_id',cn);
    const currentHeadline=headline(events),previousHeadline=headline(previous);
    const types={};for(const e of events){const x=types[e.event_type]||(types[e.event_type]={event_type:e.event_type,events:0,realized_loss:0,at_risk_value:0});x.events++;x.realized_loss+=Number(e.realized_loss||0);x.at_risk_value+=Number(e.exposure||0);}for(const x of Object.values(types)){x.realized_loss=r2(x.realized_loss);x.at_risk_value=r2(x.at_risk_value);x.combined_erosion=r2(x.realized_loss+x.at_risk_value);}
    const repeatCustomers=byCustomer.filter(x=>x.events>=2&&(x.refund_events+x.concession_events>=2||x.control_types>=2)).map(x=>({...x,review_reason:x.control_types>=2?'Repeated customer erosion spans multiple control types':'Repeated customer concessions/refunds'}));
    const crossControlEmployees=byEmployee.filter(x=>x.control_types>=2).map(x=>({...x,review_reason:`Workflow involvement spans ${x.control_types} controlled loss/erosion types`}));
    res.json({window_days:days,headline:currentHeadline,trend:{comparison_window_days:days,previous:previousHeadline,realized_loss_change:r2(currentHeadline.evidence_backed_realized_loss-previousHeadline.evidence_backed_realized_loss),realized_loss_change_pct:previousHeadline.evidence_backed_realized_loss>0?pct(currentHeadline.evidence_backed_realized_loss-previousHeadline.evidence_backed_realized_loss,previousHeadline.evidence_backed_realized_loss):null,combined_erosion_change:r2(currentHeadline.combined_erosion-previousHeadline.combined_erosion)},by_type:Object.values(types).sort((a,b)=>b.combined_erosion-a.combined_erosion),by_branch:byBranch.slice(0,50),by_employee_workflow:byEmployee.slice(0,50),cross_control_employee_patterns:crossControlEmployees.slice(0,50),by_customer:byCustomer.slice(0,50),repeat_customer_patterns:repeatCustomers.slice(0,50),by_product:products.slice(0,100),by_supplier_procurement:suppliers.slice(0,100),methodology:{realized_loss:'Only evidence-backed completed loss/erosion events are included here.',at_risk_value:'Discount, promotion, pending concession/refund and similar exposure is kept separate from realized loss.',employee_warning:'Employee workflow concentration is an operational review signal, not a misconduct finding.',customer_warning:'Repeated customer concessions/refunds are review signals and may reflect legitimate warranty or service-recovery circumstances.',supplier_warning:'Supplier procurement overrun is attributed to a supplier only when the linked sourcing outcome uses one supplier. Mixed-supplier outcomes remain labeled mixed sourcing rather than being arbitrarily allocated.',product_warning:'Product erosion uses tracked write-off value plus line-level economics preserved by margin-override evidence. Promotion exposure is not allocated to products when authoritative product-level promotion evidence is unavailable.',branch_ratio_warning:'Branch ratios use posted positive completed transaction value as an operational denominator, not audited accounting revenue or net profit.',scope_warning:'This view does not claim full accounting net contribution; it combines controlled leakage evidence across subsystems without inventing missing historical COGS, overhead or unsupported allocations.',writeoff_valuation:'Approved inventory write-offs use tracked inventory value only; untracked value is not invented.'},automatic_actions:false});
  }catch(e){res.status(500).json({error:e.message});}
});
module.exports=router;
