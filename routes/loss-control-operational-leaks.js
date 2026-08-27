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
function period(req){const end=String(req.query.end||req.body?.end||new Date().toISOString().slice(0,10)),days=Number(req.query.days||req.body?.days||30),start=String(req.query.start||req.body?.start||daysAgo(days)),branchId=Number(req.query.branch_id||req.body?.branch_id)||null;return {start,end,branchId};}
function normalizeRef(v){return String(v||'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'');}

async function adjustmentSignals(p){
  if(!(await table('inventory_adjustment_control_events')))return [];
  const countThreshold=Math.max(2,await settingNumber('loss_control_adjustment_frequency_threshold',5));
  const valueThreshold=Math.max(0,await settingNumber('loss_control_adjustment_review_value',10000));
  const args=[p.start,p.end];let where='';if(p.branchId){where=' AND a.branch_id=?';args.push(p.branchId);}
  const {rows}=await db.execute({sql:`SELECT a.employee_id,a.branch_id,e.first_name||' '||e.last_name employee_name,b.name branch_name,
      COUNT(*) adjustment_count,SUM(CASE WHEN a.adjustment_quantity<0 THEN 1 ELSE 0 END) negative_count,
      COALESCE(SUM(CASE WHEN a.adjustment_quantity<0 THEN ABS(a.estimated_value_change) ELSE 0 END),0) negative_value,
      COALESCE(SUM(CASE WHEN a.adjustment_quantity>0 THEN a.estimated_value_change ELSE 0 END),0) positive_value,
      COUNT(DISTINCT a.product_id) product_count,
      SUM(CASE WHEN a.approval_required=1 THEN 1 ELSE 0 END) approved_high_value_count
    FROM inventory_adjustment_control_events a LEFT JOIN employees e ON e.id=a.employee_id LEFT JOIN branches b ON b.id=a.branch_id
    WHERE date(a.created_at) BETWEEN date(?) AND date(?)${where}
    GROUP BY a.employee_id,a.branch_id HAVING negative_count>=? OR negative_value>=? ORDER BY negative_value DESC`,args:[...args,countThreshold,valueThreshold]});
  return rows.map(x=>({signal_key:key(['adjustment_concentration',x.employee_id,x.branch_id,p.start,p.end]),signal_type:'inventory_adjustment_concentration',category:'inventory_adjustment',severity:Number(x.negative_value)>=100000?'high':Number(x.negative_value)>=25000?'medium':'low',branch_id:x.branch_id,employee_id:x.employee_id,estimated_loss:0,at_risk_value:r2(x.negative_value),title:`Inventory reduction pattern requires review: ${x.employee_name||'employee'}`,evidence:{period_start:p.start,period_end:p.end,adjustment_count:Number(x.adjustment_count||0),negative_adjustment_count:Number(x.negative_count||0),negative_inventory_value:r2(x.negative_value),positive_inventory_value:r2(x.positive_value),distinct_products:Number(x.product_count||0),high_value_approved_count:Number(x.approved_high_value_count||0),branch_name:x.branch_name},recommended_action:'Review adjustment reasons, physical-count evidence, serial/lot movements, write-offs and supervisor approvals. Repeated negative adjustments are an anomaly signal and do not by themselves establish theft or misconduct.'}));
}

async function productAdjustmentSignals(p){
  if(!(await table('inventory_adjustment_control_events')))return [];
  const repeat=Math.max(2,await settingNumber('loss_control_product_adjustment_repeat_threshold',3));const args=[p.start,p.end];let where='';if(p.branchId){where=' AND a.branch_id=?';args.push(p.branchId);}
  const {rows}=await db.execute({sql:`SELECT a.product_id,a.branch_id,p.name product_name,p.sku,b.name branch_name,COUNT(*) negative_events,COALESCE(SUM(ABS(a.estimated_value_change)),0) value_exposure,GROUP_CONCAT(DISTINCT a.reason) reasons
    FROM inventory_adjustment_control_events a JOIN products p ON p.id=a.product_id LEFT JOIN branches b ON b.id=a.branch_id
    WHERE a.adjustment_quantity<0 AND date(a.created_at) BETWEEN date(?) AND date(?)${where} GROUP BY a.product_id,a.branch_id HAVING negative_events>=? ORDER BY value_exposure DESC`,args:[...args,repeat]});
  return rows.map(x=>({signal_key:key(['repeat_product_adjustment',x.product_id,x.branch_id,p.start,p.end]),signal_type:'repeated_product_stock_reduction',category:'inventory_adjustment',severity:Number(x.value_exposure)>=50000?'high':'medium',branch_id:x.branch_id,product_id:x.product_id,estimated_loss:0,at_risk_value:r2(x.value_exposure),title:`Repeated stock reductions: ${x.product_name}`,evidence:{sku:x.sku,negative_events:Number(x.negative_events||0),inventory_value_review:r2(x.value_exposure),reasons:x.reasons,branch_name:x.branch_name},recommended_action:'Reconcile this SKU against receiving, sales, transfers, returns, serial/lot identity and physical counts. Repeated adjustments can indicate process/data problems as well as genuine shrinkage.'}));
}

async function supplierPaymentSignals(p){
  if(!(await table('supplier_payments')))return [];
  const args=[p.start,p.end];let where='';if(p.branchId){where=' AND sp.branch_id=?';args.push(p.branchId);}
  const {rows}=await db.execute({sql:`SELECT sp.*,s.name supplier_name FROM supplier_payments sp JOIN suppliers s ON s.id=sp.supplier_id WHERE date(sp.payment_date) BETWEEN date(?) AND date(?)${where} AND TRIM(COALESCE(sp.reference,''))!='' ORDER BY sp.supplier_id,sp.payment_date,sp.id`,args});
  const groups=new Map();for(const row of rows){const ref=normalizeRef(row.reference);if(!ref)continue;const k=`${row.supplier_id}|${ref}`;const a=groups.get(k)||[];a.push(row);groups.set(k,a);}
  const out=[];for(const a of groups.values()){if(a.length<2)continue;const exposure=r2(a.slice(1).reduce((s,x)=>s+Number(x.amount||0),0));out.push({signal_key:key(['duplicate_supplier_payment_reference',a[0].supplier_id,normalizeRef(a[0].reference)]),signal_type:'duplicate_supplier_payment_reference',category:'supplier_payment',severity:exposure>=100000?'high':'medium',supplier_id:a[0].supplier_id,branch_id:a[0].branch_id,estimated_loss:0,at_risk_value:exposure,title:`Repeated supplier payment reference: ${a[0].supplier_name}`,evidence:{normalized_reference:normalizeRef(a[0].reference),payment_ids:a.map(x=>x.id),payment_numbers:a.map(x=>x.payment_number),amounts:a.map(x=>Number(x.amount||0)),payment_dates:a.map(x=>x.payment_date)},recommended_action:'Confirm whether these records represent the same bank/payment event, a legitimate split/remittance reuse, or duplicate payment before additional funds are released.'});}return out;
}

async function rentalSignals(p){
  if(!(await table('rental_agreements')))return [];
  const out=[];const args=[p.start,p.end];let branch='';if(p.branchId){branch=' AND ra.branch_id=?';args.push(p.branchId);}
  const {rows:unsettled}=await db.execute({sql:`SELECT ra.id,ra.agreement_number,ra.branch_id,ra.customer_id,ra.returned_at,ra.damage_fee_total,ra.duration_adjustment_total,ra.deposit_total,ra.tax_adjustment_total,c.first_name||' '||c.last_name customer_name,b.name branch_name,
      MAX(0,COALESCE(ra.damage_fee_total,0)+COALESCE(ra.duration_adjustment_total,0)-COALESCE(ra.deposit_total,0)+COALESCE(ra.tax_adjustment_total,0)) balance_due
    FROM rental_agreements ra LEFT JOIN customers c ON c.id=ra.customer_id LEFT JOIN branches b ON b.id=ra.branch_id
    WHERE ra.status='returned' AND ra.settlement_transaction_id IS NULL AND date(COALESCE(ra.returned_at,ra.created_at)) BETWEEN date(?) AND date(?)${branch} HAVING balance_due>0.01 ORDER BY balance_due DESC`,args});
  for(const x of unsettled)out.push({signal_key:key(['rental_uncollected_balance',x.id]),signal_type:'rental_uncollected_balance',category:'rental_leakage',severity:Number(x.balance_due)>=50000?'high':'medium',branch_id:x.branch_id,customer_id:x.customer_id,source_type:'rental_agreement',source_id:x.id,estimated_loss:0,at_risk_value:r2(x.balance_due),title:`Returned rental still has uncollected balance: ${x.agreement_number}`,evidence:{customer_name:x.customer_name,branch_name:x.branch_name,balance_due:r2(x.balance_due),damage_fee:r2(x.damage_fee_total),duration_adjustment:r2(x.duration_adjustment_total),deposit_applied:r2(x.deposit_total),tax_adjustment:r2(x.tax_adjustment_total),returned_at:x.returned_at},recommended_action:'Confirm the settlement hold, collect or formally resolve the outstanding rental balance, and document any authorized waiver. Do not silently clear the balance.'});
  if(await table('rental_agreement_items')){
    const staleDays=Math.max(1,await settingNumber('loss_control_rental_overdue_days',1));const a=[];let w='';if(p.branchId){w=' AND ra.branch_id=?';a.push(p.branchId);}
    const {rows:overdue}=await db.execute({sql:`SELECT ra.id,ra.agreement_number,ra.branch_id,ra.customer_id,ra.due_date,c.first_name||' '||c.last_name customer_name,b.name branch_name,CAST(julianday('now')-julianday(ra.due_date) AS INTEGER) overdue_days,
      COALESCE(SUM(rai.quantity*COALESCE(p.cost,0)),0) inventory_cost_exposure
      FROM rental_agreements ra JOIN rental_agreement_items rai ON rai.agreement_id=ra.id AND rai.parent_item_id IS NULL LEFT JOIN products p ON p.id=rai.product_id LEFT JOIN customers c ON c.id=ra.customer_id LEFT JOIN branches b ON b.id=ra.branch_id
      WHERE ra.status='active' AND ra.is_paused=0 AND date(ra.due_date)<date('now',?)${w} GROUP BY ra.id ORDER BY inventory_cost_exposure DESC`,args:[`-${staleDays-1} day`,...a]});
    for(const x of overdue)out.push({signal_key:key(['overdue_rental_asset',x.id]),signal_type:'overdue_rental_asset_exposure',category:'rental_leakage',severity:Number(x.inventory_cost_exposure)>=100000?'high':'medium',branch_id:x.branch_id,customer_id:x.customer_id,source_type:'rental_agreement',source_id:x.id,estimated_loss:0,at_risk_value:r2(x.inventory_cost_exposure),title:`Rental asset overdue: ${x.agreement_number}`,evidence:{customer_name:x.customer_name,branch_name:x.branch_name,due_date:x.due_date,overdue_days:Number(x.overdue_days||0),inventory_cost_exposure:r2(x.inventory_cost_exposure)},recommended_action:'Confirm customer contact, extension billing, asset location and recovery plan. The inventory value shown is exposure, not an assumption that the asset is lost.'});
  }
  return out;
}

async function delinquentCreditSignals(p){
  if(!(await table('customers'))||!(await table('transactions'))||!(await table('payment_allocations')))return [];
  const age=Math.max(30,await settingNumber('loss_control_ar_high_risk_days',90));const args=[age,p.start,p.end];let branch='';if(p.branchId){branch=' AND recent.branch_id=?';args.push(p.branchId);}
  const {rows}=await db.execute({sql:`SELECT c.id customer_id,c.customer_number,c.first_name||' '||c.last_name customer_name,c.account_balance,c.credit_limit,
      aged.aged_balance,recent.branch_id,COUNT(recent.id) recent_credit_sales,COALESCE(SUM(recent.total),0) recent_credit_value
    FROM customers c
    JOIN (SELECT t.customer_id,COALESCE(SUM(MAX(0,t.total-COALESCE(pa.paid,0))),0) aged_balance FROM transactions t LEFT JOIN (SELECT transaction_id,SUM(amount) paid FROM payment_allocations GROUP BY transaction_id) pa ON pa.transaction_id=t.id WHERE t.status='completed' AND t.payment_method='credit' AND julianday('now')-julianday(t.created_at)>? GROUP BY t.customer_id) aged ON aged.customer_id=c.id AND aged.aged_balance>0.01
    JOIN transactions recent ON recent.customer_id=c.id AND recent.status='completed' AND recent.payment_method='credit' AND date(recent.created_at) BETWEEN date(?) AND date(?)
    WHERE c.active=1${branch} GROUP BY c.id,recent.branch_id HAVING recent_credit_value>0.01 ORDER BY recent_credit_value DESC`,args});
  return rows.map(x=>({signal_key:key(['credit_after_aged_debt',x.customer_id,x.branch_id,p.start,p.end]),signal_type:'continued_credit_with_aged_debt',category:'accounts_receivable',severity:Number(x.recent_credit_value)>=100000?'high':'medium',branch_id:x.branch_id,customer_id:x.customer_id,estimated_loss:0,at_risk_value:r2(x.recent_credit_value),title:`New credit extended while older debt remains: ${x.customer_name}`,evidence:{customer_number:x.customer_number,aged_balance:r2(x.aged_balance),recent_credit_sales:Number(x.recent_credit_sales||0),recent_credit_value:r2(x.recent_credit_value),account_balance:r2(x.account_balance),credit_limit:r2(x.credit_limit),aged_threshold_days:age},recommended_action:'Review customer credit status, collection promises and management authorization for continued credit. This signal does not assume the new receivable will become bad debt.'}));
}

async function collect(p){const groups=await Promise.all([adjustmentSignals(p),productAdjustmentSignals(p),supplierPaymentSignals(p),rentalSignals(p),delinquentCreditSignals(p)]);return groups.flat().sort((a,b)=>(Number(b.estimated_loss||0)+Number(b.at_risk_value||0))-(Number(a.estimated_loss||0)+Number(a.at_risk_value||0)));}
async function upsert(s,employeeId){if(!(await table('loss_control_cases')))throw new Error('Base loss-control module must initialize before operational scan can record cases.');const {rows:[existing]}=await db.execute({sql:'SELECT id FROM loss_control_cases WHERE signal_key=?',args:[s.signal_key]});if(existing){await db.execute({sql:`UPDATE loss_control_cases SET signal_type=?,category=?,severity=?,branch_id=?,employee_id=?,supplier_id=?,customer_id=?,product_id=?,source_type=?,source_id=?,title=?,estimated_loss=?,at_risk_value=?,evidence_json=?,recommended_action=?,last_detected_at=CURRENT_TIMESTAMP WHERE id=?`,args:[s.signal_type,s.category,s.severity,s.branch_id||null,s.employee_id||null,s.supplier_id||null,s.customer_id||null,s.product_id||null,s.source_type||null,s.source_id||null,s.title,r2(s.estimated_loss),r2(s.at_risk_value),JSON.stringify(s.evidence||{}),s.recommended_action||null,existing.id]});return existing.id;}const r=await db.execute({sql:`INSERT INTO loss_control_cases(signal_key,signal_type,category,severity,branch_id,employee_id,supplier_id,customer_id,product_id,source_type,source_id,title,estimated_loss,at_risk_value,evidence_json,recommended_action) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:[s.signal_key,s.signal_type,s.category,s.severity,s.branch_id||null,s.employee_id||null,s.supplier_id||null,s.customer_id||null,s.product_id||null,s.source_type||null,s.source_id||null,s.title,r2(s.estimated_loss),r2(s.at_risk_value),JSON.stringify(s.evidence||{}),s.recommended_action||null]});const id=Number(r.lastInsertRowid);await db.execute({sql:'INSERT INTO loss_control_case_events(case_id,event_type,employee_id,details) VALUES(?,?,?,?)',args:[id,'detected',employeeId||null,'Operational leakage signal created from system evidence.']});return id;}
router.get('/operational-signals',async(req,res)=>{try{const p=period(req),signals=await collect(p);res.json({period:p,count:signals.length,signals,warning:'Operational leakage signals identify money or inventory exposure requiring human investigation. They are not misconduct findings.'});}catch(e){res.status(500).json({error:e.message});}});
router.post('/operational-scan',async(req,res)=>{try{const p=period(req),signals=await collect(p),ids=[];for(const s of signals)ids.push(await upsert(s,req.employee?.id));res.json({period:p,detected:signals.length,case_ids:ids,message:'Operational leakage cases recorded for review. No inventory, supplier payment, rental, customer-credit or disciplinary action was performed automatically.'});}catch(e){res.status(500).json({error:e.message});}});
module.exports=router;
