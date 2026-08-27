'use strict';
const express=require('express');
const crypto=require('crypto');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');
router.use(requirePermission('reports'));
const r2=v=>Number(Number(v||0).toFixed(2));
const key=parts=>crypto.createHash('sha256').update(parts.map(x=>String(x??'')).join('|')).digest('hex');
const daysAgo=n=>new Date(Date.now()-Math.max(0,Number(n)||0)*86400000).toISOString().slice(0,10);
async function table(name){const {rows:[r]}=await db.execute({sql:"SELECT name FROM sqlite_master WHERE type='table' AND name=?",args:[name]});return !!r;}
async function settingNumber(k,d){const {rows:[r]}=await db.execute({sql:'SELECT value FROM settings WHERE key=?',args:[k]});const n=Number(r?.value);return Number.isFinite(n)?n:d;}
function period(req){const days=Number(req.query.days||req.body?.days||30),start=String(req.query.start||req.body?.start||daysAgo(days)),end=String(req.query.end||req.body?.end||new Date().toISOString().slice(0,10)),branchId=Number(req.query.branch_id||req.body?.branch_id)||null;return {start,end,branchId};}

async function promotionSignals(p){
  if(!(await table('retail_promotion_control_events')))return [];
  const countThreshold=Math.max(2,await settingNumber('loss_control_promotion_usage_review_count',10));
  const valueThreshold=Math.max(0,await settingNumber('loss_control_promotion_discount_review_value',50000));
  const args=[p.start,p.end];let where='';if(p.branchId){where=' AND e.branch_id=?';args.push(p.branchId);}
  const {rows}=await db.execute({sql:`SELECT e.employee_id,e.branch_id,emp.first_name||' '||emp.last_name employee_name,b.name branch_name,
      COUNT(*) promotion_sales,COUNT(DISTINCT e.promotion_id) promotion_count,COALESCE(SUM(e.authoritative_discount),0) discount_value,
      COALESCE(SUM(e.eligible_amount),0) eligible_sales_value
    FROM retail_promotion_control_events e LEFT JOIN employees emp ON emp.id=e.employee_id LEFT JOIN branches b ON b.id=e.branch_id
    WHERE date(e.created_at) BETWEEN date(?) AND date(?)${where} GROUP BY e.employee_id,e.branch_id
    HAVING promotion_sales>=? OR discount_value>=? ORDER BY discount_value DESC`,args:[...args,countThreshold,valueThreshold]});
  return rows.map(x=>({signal_key:key(['promotion_concentration',x.employee_id,x.branch_id,p.start,p.end]),signal_type:'promotion_discount_concentration',category:'pricing_promotion',severity:Number(x.discount_value)>=100000?'high':'medium',branch_id:x.branch_id,employee_id:x.employee_id,estimated_loss:0,at_risk_value:r2(x.discount_value),title:`Promotion discount concentration requires review: ${x.employee_name||'employee'}`,evidence:{period_start:p.start,period_end:p.end,promotion_sales:Number(x.promotion_sales||0),distinct_promotions:Number(x.promotion_count||0),discount_value:r2(x.discount_value),eligible_sales_value:r2(x.eligible_sales_value),discount_rate_pct:Number(x.eligible_sales_value)>0?r2(100*Number(x.discount_value)/Number(x.eligible_sales_value)):0,branch_name:x.branch_name},recommended_action:'Review whether the promotion usage pattern reflects legitimate sales activity, campaign concentration, code sharing or control circumvention. The signal is not a misconduct finding.'}));
}

async function repairPartSignals(p){
  if(!(await table('repair_part_reservations'))||!(await table('work_order_items'))||!(await table('work_orders')))return [];
  const args=[p.start,p.end];let where='';if(p.branchId){where=' AND wo.branch_id=?';args.push(p.branchId);}
  const {rows}=await db.execute({sql:`SELECT wo.id work_order_id,wo.wo_number,wo.status,wo.branch_id,b.name branch_name,woi.id work_order_item_id,woi.product_id,woi.product_name,woi.sku,
      COALESCE(woi.quantity,0) billed_quantity,COALESCE(woi.total,0) billed_line_total,
      COALESCE(SUM(r.quantity_consumed),0) consumed_quantity,COALESCE(p.cost,0) unit_cost,
      MAX(0,COALESCE(SUM(r.quantity_consumed),0)-COALESCE(woi.quantity,0)) excess_consumed_quantity
    FROM repair_part_reservations r JOIN work_order_items woi ON woi.id=r.work_order_item_id JOIN work_orders wo ON wo.id=r.work_order_id
    LEFT JOIN products p ON p.id=r.product_id LEFT JOIN branches b ON b.id=wo.branch_id
    WHERE date(r.created_at) BETWEEN date(?) AND date(?)${where} GROUP BY woi.id
    HAVING (consumed_quantity>0 AND billed_line_total<=0.01) OR excess_consumed_quantity>0.0001
    ORDER BY (excess_consumed_quantity*unit_cost) DESC`,args});
  return rows.map(x=>{const excess=Number(x.excess_consumed_quantity||0),allUnbilled=Number(x.billed_line_total||0)<=0.01?Number(x.consumed_quantity||0):0,qty=Math.max(excess,allUnbilled),exposure=r2(qty*Number(x.unit_cost||0));return {signal_key:key(['repair_part_billing_gap',x.work_order_item_id]),signal_type:'repair_consumed_part_billing_gap',category:'repair_leakage',severity:exposure>=50000?'high':'medium',branch_id:x.branch_id,product_id:x.product_id,source_type:'work_order',source_id:x.work_order_id,estimated_loss:0,at_risk_value:exposure,title:`Consumed repair part may not be fully billed: ${x.wo_number}`,evidence:{work_order_status:x.status,branch_name:x.branch_name,product_name:x.product_name,sku:x.sku,billed_quantity:Number(x.billed_quantity||0),billed_line_total:r2(x.billed_line_total),consumed_quantity:Number(x.consumed_quantity||0),excess_consumed_quantity:excess,unit_cost:r2(x.unit_cost),inventory_cost_exposure:exposure},recommended_action:'Reconcile consumed part usage against the approved estimate/final invoice. Bill valid additional usage, return unused parts to stock, or document an authorized warranty/goodwill write-off.'};});
}

async function collect(p){const groups=await Promise.all([promotionSignals(p),repairPartSignals(p)]);return groups.flat().sort((a,b)=>Number(b.at_risk_value||0)-Number(a.at_risk_value||0));}
async function upsert(s,employeeId){if(!(await table('loss_control_cases')))throw new Error('Base loss-control module must initialize before commercial/service scan can record cases.');const {rows:[existing]}=await db.execute({sql:'SELECT id FROM loss_control_cases WHERE signal_key=?',args:[s.signal_key]});if(existing){await db.execute({sql:`UPDATE loss_control_cases SET signal_type=?,category=?,severity=?,branch_id=?,employee_id=?,supplier_id=?,customer_id=?,product_id=?,source_type=?,source_id=?,title=?,estimated_loss=?,at_risk_value=?,evidence_json=?,recommended_action=?,last_detected_at=CURRENT_TIMESTAMP WHERE id=?`,args:[s.signal_type,s.category,s.severity,s.branch_id||null,s.employee_id||null,s.supplier_id||null,s.customer_id||null,s.product_id||null,s.source_type||null,s.source_id||null,s.title,r2(s.estimated_loss),r2(s.at_risk_value),JSON.stringify(s.evidence||{}),s.recommended_action||null,existing.id]});return existing.id;}const r=await db.execute({sql:`INSERT INTO loss_control_cases(signal_key,signal_type,category,severity,branch_id,employee_id,supplier_id,customer_id,product_id,source_type,source_id,title,estimated_loss,at_risk_value,evidence_json,recommended_action) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:[s.signal_key,s.signal_type,s.category,s.severity,s.branch_id||null,s.employee_id||null,s.supplier_id||null,s.customer_id||null,s.product_id||null,s.source_type||null,s.source_id||null,s.title,r2(s.estimated_loss),r2(s.at_risk_value),JSON.stringify(s.evidence||{}),s.recommended_action||null]});const id=Number(r.lastInsertRowid);await db.execute({sql:'INSERT INTO loss_control_case_events(case_id,event_type,employee_id,details) VALUES(?,?,?,?)',args:[id,'detected',employeeId||null,'Commercial/service leakage signal created from system evidence.']});return id;}
router.get('/commercial-service-signals',async(req,res)=>{try{const p=period(req),signals=await collect(p);res.json({period:p,count:signals.length,signals,warning:'These signals identify commercial or service billing exposure requiring human review. They do not establish misconduct.'});}catch(e){res.status(500).json({error:e.message});}});
router.post('/commercial-service-scan',async(req,res)=>{try{const p=period(req),signals=await collect(p),ids=[];for(const s of signals)ids.push(await upsert(s,req.employee?.id));res.json({period:p,detected:signals.length,case_ids:ids,message:'Commercial/service leakage cases recorded for review. No sale, repair invoice, promotion, inventory or disciplinary action was changed automatically.'});}catch(e){res.status(500).json({error:e.message});}});
module.exports=router;