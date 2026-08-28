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
async function columns(name){const {rows}=await db.execute({sql:`PRAGMA table_info(${name})`,args:[]});return new Set(rows.map(x=>String(x.name)));}
async function settingNumber(k,d){const {rows:[r]}=await db.execute({sql:'SELECT value FROM settings WHERE key=?',args:[k]});const n=Number(r?.value);return Number.isFinite(n)?n:d;}
function period(req){const days=Number(req.query.days||req.body?.days||30),start=String(req.query.start||req.body?.start||daysAgo(days)),end=String(req.query.end||req.body?.end||new Date().toISOString().slice(0,10)),branchId=Number(req.query.branch_id||req.body?.branch_id)||null;return {start,end,branchId};}

async function rentalPauseSignals(p){
  if(!(await table('rental_agreement_pauses'))||!(await table('rental_agreements')))return [];
  const countThreshold=Math.max(2,await settingNumber('loss_control_rental_pause_review_count',3));
  const hoursThreshold=Math.max(1,await settingNumber('loss_control_rental_pause_review_hours',24));
  const args=[p.start,p.end];let branch='';if(p.branchId){branch=' AND ra.branch_id=?';args.push(p.branchId);}
  const {rows}=await db.execute({sql:`SELECT ra.id agreement_id,ra.agreement_number,ra.branch_id,b.name branch_name,ra.customer_id,
      COUNT(rp.id) pause_count,
      COALESCE(SUM(CASE WHEN rp.ended_at IS NOT NULL THEN MAX(0,(julianday(rp.ended_at)-julianday(rp.started_at))*24.0) ELSE 0 END),0) closed_pause_hours,
      GROUP_CONCAT(DISTINCT rp.reason) pause_reasons,
      GROUP_CONCAT(DISTINCT rp.authorized_by) authorizer_ids
    FROM rental_agreement_pauses rp JOIN rental_agreements ra ON ra.id=rp.agreement_id LEFT JOIN branches b ON b.id=ra.branch_id
    WHERE date(rp.started_at) BETWEEN date(?) AND date(?)${branch}
    GROUP BY ra.id
    HAVING pause_count>=? OR closed_pause_hours>=?
    ORDER BY closed_pause_hours DESC,pause_count DESC`,args:[...args,countThreshold,hoursThreshold]});
  return rows.map(x=>({signal_key:key(['rental_pause_concentration',x.agreement_id,p.start,p.end]),signal_type:'rental_pause_billing_suppression_review',category:'rental_leakage',severity:Number(x.closed_pause_hours)>=72||Number(x.pause_count)>=5?'high':'medium',branch_id:x.branch_id,customer_id:x.customer_id,source_type:'rental_agreement',source_id:x.agreement_id,estimated_loss:0,at_risk_value:0,title:`Rental pause pattern requires billing review: ${x.agreement_number}`,evidence:{period_start:p.start,period_end:p.end,branch_name:x.branch_name,pause_count:Number(x.pause_count||0),closed_pause_hours:r2(x.closed_pause_hours),pause_reasons:x.pause_reasons||null,authorizer_ids:x.authorizer_ids||null,count_threshold:countThreshold,hours_threshold:hoursThreshold},recommended_action:'Review each pause against maintenance/replacement evidence and verify the non-billable downtime was legitimate. This signal does not assume the pause was improper and does not invent a monetary loss without rate-specific billing evidence.'}));
}

async function rentalConditionSignals(p){
  if(!(await table('rental_agreement_items'))||!(await table('rental_agreements')))return [];
  const c=await columns('rental_agreement_items');
  if(!c.has('condition_in')||!c.has('condition_out')||!c.has('damage_fee')||!c.has('quantity_returned'))return [];
  const args=[p.start,p.end];let branch='';if(p.branchId){branch=' AND ra.branch_id=?';args.push(p.branchId);}
  const bad=`(lower(COALESCE(rai.condition_in,'')) LIKE '%damage%' OR lower(COALESCE(rai.condition_in,'')) LIKE '%broken%' OR lower(COALESCE(rai.condition_in,'')) LIKE '%poor%' OR lower(COALESCE(rai.condition_in,'')) LIKE '%missing%' OR lower(COALESCE(rai.condition_in,'')) LIKE '%unusable%' OR lower(COALESCE(rai.condition_in,'')) LIKE '%repair%')`;
  const {rows}=await db.execute({sql:`SELECT ra.id agreement_id,ra.agreement_number,ra.branch_id,b.name branch_name,ra.customer_id,rai.id agreement_item_id,rai.product_id,rai.product_name,rai.sku,rai.condition_out,rai.condition_in,rai.damage_fee,rai.damage_notes,rai.quantity_returned,COALESCE(pr.cost,0) unit_cost
    FROM rental_agreement_items rai JOIN rental_agreements ra ON ra.id=rai.agreement_id LEFT JOIN products pr ON pr.id=rai.product_id LEFT JOIN branches b ON b.id=ra.branch_id
    WHERE rai.returned_at IS NOT NULL AND date(rai.returned_at) BETWEEN date(?) AND date(?)${branch}
      AND rai.quantity_returned>0 AND COALESCE(rai.damage_fee,0)<=0.01 AND ${bad}
      AND lower(TRIM(COALESCE(rai.condition_in,'')))<>lower(TRIM(COALESCE(rai.condition_out,'')))
    ORDER BY ra.id DESC,rai.id`,args});
  return rows.map(x=>{const exposure=r2(Number(x.unit_cost||0)*Number(x.quantity_returned||0));return {signal_key:key(['rental_condition_without_damage_fee',x.agreement_item_id]),signal_type:'rental_condition_downgrade_without_damage_charge',category:'rental_leakage',severity:exposure>=50000?'high':'medium',branch_id:x.branch_id,customer_id:x.customer_id,product_id:x.product_id,source_type:'rental_agreement',source_id:x.agreement_id,estimated_loss:0,at_risk_value:exposure,title:`Returned rental condition worsened without a damage charge: ${x.agreement_number}`,evidence:{branch_name:x.branch_name,product_name:x.product_name,sku:x.sku,condition_out:x.condition_out,condition_in:x.condition_in,damage_fee:r2(x.damage_fee),damage_notes:x.damage_notes||null,quantity_returned:Number(x.quantity_returned||0),unit_inventory_cost:r2(x.unit_cost),inventory_value_exposed:exposure},recommended_action:'Review return photos/inspection notes and the rental agreement. Confirm whether the condition change is ordinary wear, warranty/maintenance, customer damage, or requires a documented fee/waiver. The signal is not a finding of customer or employee fault.'};});
}

async function supplierPaymentSimilaritySignals(p){
  if(!(await table('supplier_payments')))return [];
  const args=[p.start,p.end];let branch='';if(p.branchId){branch=' AND sp.branch_id=?';args.push(p.branchId);}
  const {rows}=await db.execute({sql:`SELECT sp.supplier_id,s.name supplier_name,sp.branch_id,b.name branch_name,sp.payment_date,ROUND(sp.amount,2) amount,
      COUNT(*) payment_count,GROUP_CONCAT(sp.id) payment_ids,GROUP_CONCAT(COALESCE(sp.reference,''),' | ') payment_references
    FROM supplier_payments sp LEFT JOIN suppliers s ON s.id=sp.supplier_id LEFT JOIN branches b ON b.id=sp.branch_id
    WHERE date(sp.payment_date) BETWEEN date(?) AND date(?)${branch}
    GROUP BY sp.supplier_id,sp.branch_id,sp.payment_date,ROUND(sp.amount,2)
    HAVING payment_count>1
    ORDER BY (amount*(payment_count-1)) DESC`,args});
  return rows.map(x=>{const exposure=r2(Number(x.amount||0)*Math.max(1,Number(x.payment_count||0)-1));return {signal_key:key(['supplier_same_day_same_amount',x.supplier_id,x.branch_id,x.payment_date,x.amount]),signal_type:'supplier_payment_same_day_same_amount',category:'supplier_payment_risk',severity:exposure>=100000?'high':'medium',branch_id:x.branch_id,supplier_id:x.supplier_id,estimated_loss:0,at_risk_value:exposure,title:`Repeated same-day supplier payment amount requires review: ${x.supplier_name||'supplier'}`,evidence:{supplier_name:x.supplier_name,branch_name:x.branch_name,payment_date:x.payment_date,amount:r2(x.amount),payment_count:Number(x.payment_count||0),payment_ids:x.payment_ids,payment_references:x.payment_references,duplicate_value_exposure:exposure},recommended_action:'Compare bank/cheque/remittance evidence and invoice allocations for these payments. Multiple legitimate payments can share an amount; this signal identifies duplicate-payment risk and does not classify any payment as improper.'};});
}

async function collect(p){const groups=await Promise.all([rentalPauseSignals(p),rentalConditionSignals(p),supplierPaymentSimilaritySignals(p)]);return groups.flat().sort((a,b)=>Number(b.at_risk_value||0)-Number(a.at_risk_value||0));}
async function upsert(s,employeeId){
  if(!(await table('loss_control_cases')))throw new Error('Base loss-control module must initialize before rental/payment scans can record cases.');
  const {rows:[existing]}=await db.execute({sql:'SELECT id FROM loss_control_cases WHERE signal_key=?',args:[s.signal_key]});
  if(existing){await db.execute({sql:`UPDATE loss_control_cases SET signal_type=?,category=?,severity=?,branch_id=?,employee_id=?,supplier_id=?,customer_id=?,product_id=?,source_type=?,source_id=?,title=?,estimated_loss=?,at_risk_value=?,evidence_json=?,recommended_action=?,last_detected_at=CURRENT_TIMESTAMP WHERE id=?`,args:[s.signal_type,s.category,s.severity,s.branch_id||null,s.employee_id||null,s.supplier_id||null,s.customer_id||null,s.product_id||null,s.source_type||null,s.source_id||null,s.title,r2(s.estimated_loss),r2(s.at_risk_value),JSON.stringify(s.evidence||{}),s.recommended_action||null,existing.id]});return existing.id;}
  const r=await db.execute({sql:`INSERT INTO loss_control_cases(signal_key,signal_type,category,severity,branch_id,employee_id,supplier_id,customer_id,product_id,source_type,source_id,title,estimated_loss,at_risk_value,evidence_json,recommended_action) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:[s.signal_key,s.signal_type,s.category,s.severity,s.branch_id||null,s.employee_id||null,s.supplier_id||null,s.customer_id||null,s.product_id||null,s.source_type||null,s.source_id||null,s.title,r2(s.estimated_loss),r2(s.at_risk_value),JSON.stringify(s.evidence||{}),s.recommended_action||null]});
  const id=Number(r.lastInsertRowid);await db.execute({sql:'INSERT INTO loss_control_case_events(case_id,event_type,employee_id,details) VALUES(?,?,?,?)',args:[id,'detected',employeeId||null,'Rental/payment leakage signal created from system evidence.']});return id;
}
router.get('/rental-payment-signals',async(req,res)=>{try{const p=period(req),signals=await collect(p);res.json({period:p,count:signals.length,signals,warning:'These signals identify rental or supplier-payment exposure requiring human review. They do not establish misconduct.'});}catch(e){res.status(500).json({error:e.message});}});
router.post('/rental-payment-scan',async(req,res)=>{try{const p=period(req),signals=await collect(p),ids=[];for(const s of signals)ids.push(await upsert(s,req.employee?.id));res.json({period:p,detected:signals.length,case_ids:ids,message:'Rental/payment leakage cases recorded for review. No rental, payment, inventory, supplier or disciplinary record was changed automatically.'});}catch(e){res.status(500).json({error:e.message});}});
module.exports=router;
