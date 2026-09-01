'use strict';
const express=require('express');
const crypto=require('crypto');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');
router.use(requirePermission('reports'));
const r2=v=>Number(Number(v||0).toFixed(2));
const key=parts=>crypto.createHash('sha256').update(parts.map(x=>String(x??'')).join('|')).digest('hex');
async function table(name){const {rows:[r]}=await db.execute({sql:"SELECT name FROM sqlite_master WHERE type='table' AND name=?",args:[name]});return !!r;}
async function settingNumber(k,d){const {rows:[r]}=await db.execute({sql:'SELECT value FROM settings WHERE key=?',args:[k]});const n=Number(r?.value);return Number.isFinite(n)?n:d;}
function daysAgo(n){return new Date(Date.now()-Math.max(0,Number(n)||0)*86400000).toISOString().slice(0,10);}
function period(req){const days=Number(req.query.days||req.body?.days||30);return {start:String(req.query.start||req.body?.start||daysAgo(days)),end:String(req.query.end||req.body?.end||new Date().toISOString().slice(0,10)),branchId:Number(req.query.branch_id||req.body?.branch_id)||null};}
async function signals(p){
  if(!(await table('supplier_payments')))return [];
  const [windowDays,pctTolerance,absTolerance]=await Promise.all([
    settingNumber('loss_control_supplier_payment_similarity_days',2),
    settingNumber('loss_control_supplier_payment_similarity_amount_pct',0.25),
    settingNumber('loss_control_supplier_payment_similarity_amount_abs',100)
  ]);
  const win=Math.max(1,Math.min(14,Number(windowDays)||2)),pct=Math.max(0,Number(pctTolerance)||0),abs=Math.max(0,Number(absTolerance)||0);
  const args=[p.start,p.end,win,pct,abs];let branch='';if(p.branchId){branch=' AND (a.branch_id=? OR b.branch_id=?)';args.push(p.branchId,p.branchId);}
  const {rows}=await db.execute({sql:`SELECT a.id first_payment_id,b.id second_payment_id,a.supplier_id,s.name supplier_name,
      a.branch_id first_branch_id,b.branch_id second_branch_id,ba.name first_branch_name,bb.name second_branch_name,
      a.payment_date first_payment_date,b.payment_date second_payment_date,a.amount first_amount,b.amount second_amount,
      a.reference first_reference,b.reference second_reference,a.payment_method first_method,b.payment_method second_method,
      ABS(julianday(b.payment_date)-julianday(a.payment_date)) day_difference,ABS(b.amount-a.amount) amount_difference
    FROM supplier_payments a JOIN supplier_payments b ON b.supplier_id=a.supplier_id AND b.id>a.id
    LEFT JOIN suppliers s ON s.id=a.supplier_id LEFT JOIN branches ba ON ba.id=a.branch_id LEFT JOIN branches bb ON bb.id=b.branch_id
    WHERE date(a.payment_date) BETWEEN date(?) AND date(?)
      AND ABS(julianday(b.payment_date)-julianday(a.payment_date))<=?
      AND ABS(b.amount-a.amount)<=MAX(?,MAX(a.amount,b.amount)*?/100.0)${branch}
    ORDER BY MAX(a.amount,b.amount) DESC,day_difference,amount_difference`,args:[p.start,p.end,win,abs,pct,...(p.branchId?[p.branchId,p.branchId]:[])]});
  return rows.map(x=>{const exposure=r2(Math.min(Number(x.first_amount||0),Number(x.second_amount||0)));return {signal_key:key(['supplier_payment_near_duplicate',x.first_payment_id,x.second_payment_id]),signal_type:'supplier_payment_near_duplicate',category:'supplier_payment_risk',severity:exposure>=100000?'high':'medium',supplier_id:x.supplier_id,estimated_loss:0,at_risk_value:exposure,title:`Near-duplicate supplier payments require review: ${x.supplier_name||'supplier'}`,evidence:{first_payment_id:x.first_payment_id,second_payment_id:x.second_payment_id,first_branch_name:x.first_branch_name,second_branch_name:x.second_branch_name,first_payment_date:x.first_payment_date,second_payment_date:x.second_payment_date,first_amount:r2(x.first_amount),second_amount:r2(x.second_amount),amount_difference:r2(x.amount_difference),day_difference:Number(x.day_difference||0),first_reference:x.first_reference||null,second_reference:x.second_reference||null,first_method:x.first_method||null,second_method:x.second_method||null,window_days:win,amount_tolerance_pct:pct,amount_tolerance_abs:abs},recommended_action:'Compare bank, cheque, remittance, supplier statement and invoice-allocation evidence before treating either payment as valid or duplicate. Similar payments can be legitimate; this is a financial review signal, not a finding of improper payment.'};});
}
async function upsert(s,employeeId){
  if(!(await table('loss_control_cases')))throw new Error('Base loss-control module must initialize before supplier-payment scans can record cases.');
  const {rows:[existing]}=await db.execute({sql:'SELECT id FROM loss_control_cases WHERE signal_key=?',args:[s.signal_key]});
  if(existing){await db.execute({sql:`UPDATE loss_control_cases SET signal_type=?,category=?,severity=?,supplier_id=?,title=?,estimated_loss=?,at_risk_value=?,evidence_json=?,recommended_action=?,last_detected_at=CURRENT_TIMESTAMP WHERE id=?`,args:[s.signal_type,s.category,s.severity,s.supplier_id||null,s.title,r2(s.estimated_loss),r2(s.at_risk_value),JSON.stringify(s.evidence||{}),s.recommended_action,existing.id]});return existing.id;}
  const r=await db.execute({sql:`INSERT INTO loss_control_cases(signal_key,signal_type,category,severity,supplier_id,title,estimated_loss,at_risk_value,evidence_json,recommended_action) VALUES(?,?,?,?,?,?,?,?,?,?)`,args:[s.signal_key,s.signal_type,s.category,s.severity,s.supplier_id||null,s.title,r2(s.estimated_loss),r2(s.at_risk_value),JSON.stringify(s.evidence||{}),s.recommended_action]});
  const id=Number(r.lastInsertRowid);await db.execute({sql:'INSERT INTO loss_control_case_events(case_id,event_type,employee_id,details) VALUES(?,?,?,?)',args:[id,'detected',employeeId||null,'Near-duplicate supplier-payment signal created from payment evidence.']});return id;
}
router.get('/supplier-payment-near-duplicates',async(req,res)=>{try{const p=period(req),rows=await signals(p);res.json({period:p,count:rows.length,signals:rows,warning:'These are duplicate-payment risk signals requiring human review, not findings of misconduct.'});}catch(e){res.status(500).json({error:e.message});}});
router.post('/supplier-payment-near-duplicate-scan',async(req,res)=>{try{const p=period(req),rows=await signals(p),ids=[];for(const s of rows)ids.push(await upsert(s,req.employee?.id));res.json({period:p,detected:rows.length,case_ids:ids,message:'Supplier-payment review cases recorded. No payment, supplier, invoice, bank or accounting record was changed automatically.'});}catch(e){res.status(500).json({error:e.message});}});
module.exports=router;
