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
async function overrideSignals(p){
  if(!(await table('rental_financial_override_events')))return [];
  const countThreshold=Math.max(2,await settingNumber('loss_control_rental_override_review_count',5));
  const args=[p.start,p.end];let where='';if(p.branchId){where=' AND e.branch_id=?';args.push(p.branchId);}
  const {rows}=await db.execute({sql:`SELECT e.employee_id,e.authorizer_employee_id,e.branch_id,COUNT(*) override_count,
    SUM(CASE WHEN e.override_type='duration_adjustment_override' THEN 1 ELSE 0 END) duration_overrides,
    SUM(CASE WHEN e.override_type='backdated_return' THEN 1 ELSE 0 END) backdated_returns,
    emp.first_name||' '||emp.last_name employee_name,auth.first_name||' '||auth.last_name authorizer_name,b.name branch_name
    FROM rental_financial_override_events e
    LEFT JOIN employees emp ON emp.id=e.employee_id LEFT JOIN employees auth ON auth.id=e.authorizer_employee_id LEFT JOIN branches b ON b.id=e.branch_id
    WHERE date(e.created_at) BETWEEN date(?) AND date(?)${where}
    GROUP BY e.employee_id,e.authorizer_employee_id,e.branch_id HAVING override_count>=? ORDER BY override_count DESC`,args:[...args,countThreshold]});
  return rows.map(x=>({signal_key:key(['rental_override_concentration',x.employee_id,x.authorizer_employee_id,x.branch_id,p.start,p.end]),signal_type:'rental_financial_override_concentration',category:'rental_leakage',severity:Number(x.override_count)>=countThreshold*2?'high':'medium',branch_id:x.branch_id,employee_id:x.employee_id,estimated_loss:0,at_risk_value:0,title:`Rental financial overrides require review: ${x.employee_name||'employee'}`,evidence:{period_start:p.start,period_end:p.end,override_count:Number(x.override_count||0),duration_overrides:Number(x.duration_overrides||0),backdated_returns:Number(x.backdated_returns||0),employee_name:x.employee_name,authorizer_name:x.authorizer_name,branch_name:x.branch_name},recommended_action:'Review rental return override evidence for legitimate customer-service corrections, backdated hand-offs, waived duration charges, repeated staff/authorizer pairing, and supporting documentation. This is an investigation signal, not a misconduct finding.'}));
}
async function collect(p){return (await overrideSignals(p)).sort((a,b)=>String(b.severity).localeCompare(String(a.severity)));}
async function upsert(s,employeeId){if(!(await table('loss_control_cases')))throw new Error('Base loss-control module must initialize before rental scan can record cases.');const {rows:[existing]}=await db.execute({sql:'SELECT id FROM loss_control_cases WHERE signal_key=?',args:[s.signal_key]});if(existing){await db.execute({sql:`UPDATE loss_control_cases SET signal_type=?,category=?,severity=?,branch_id=?,employee_id=?,title=?,estimated_loss=?,at_risk_value=?,evidence_json=?,recommended_action=?,last_detected_at=CURRENT_TIMESTAMP WHERE id=?`,args:[s.signal_type,s.category,s.severity,s.branch_id||null,s.employee_id||null,s.title,r2(s.estimated_loss),r2(s.at_risk_value),JSON.stringify(s.evidence||{}),s.recommended_action||null,existing.id]});return existing.id;}const r=await db.execute({sql:`INSERT INTO loss_control_cases(signal_key,signal_type,category,severity,branch_id,employee_id,title,estimated_loss,at_risk_value,evidence_json,recommended_action) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,args:[s.signal_key,s.signal_type,s.category,s.severity,s.branch_id||null,s.employee_id||null,s.title,r2(s.estimated_loss),r2(s.at_risk_value),JSON.stringify(s.evidence||{}),s.recommended_action||null]});const id=Number(r.lastInsertRowid);await db.execute({sql:'INSERT INTO loss_control_case_events(case_id,event_type,employee_id,details) VALUES(?,?,?,?)',args:[id,'detected',employeeId||null,'Rental financial-control signal created from override evidence.']});return id;}
router.get('/rental-signals',async(req,res)=>{try{const p=period(req),signals=await collect(p);res.json({period:p,count:signals.length,signals,warning:'Rental financial-control signals require human review and do not establish misconduct.'});}catch(e){res.status(500).json({error:e.message});}});
router.post('/rental-scan',async(req,res)=>{try{const p=period(req),signals=await collect(p),ids=[];for(const s of signals)ids.push(await upsert(s,req.employee?.id));res.json({period:p,detected:signals.length,case_ids:ids,message:'Rental financial-control cases recorded for review. No rental, customer balance, inventory, employee or payment record was changed automatically.'});}catch(e){res.status(500).json({error:e.message});}});
module.exports=router;