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

async function approvedWriteoffSignals(p){
  if(!(await table('inventory_writeoffs')))return [];
  const high=Math.max(0,await settingNumber('loss_control_high_value_writeoff_threshold',100000));
  const args=[p.start,p.end];let branch='';if(p.branchId){branch=' AND w.branch_id=?';args.push(p.branchId);}
  const {rows}=await db.execute({sql:`SELECT w.id,w.writeoff_number,w.product_id,w.branch_id,w.quantity,w.reason_code,w.reason_detail,w.reference,w.created_by_employee_id,w.approved_by_employee_id,w.tracked_value,w.valuation_status,w.approved_at,p.name product_name,p.sku,b.name branch_name,
      c.first_name||' '||c.last_name creator_name,a.first_name||' '||a.last_name approver_name,
      fa.financial_authorizer_employee_id,fa.reason financial_reason,fa.evidence_reference,fa.estimated_value
    FROM inventory_writeoffs w JOIN products p ON p.id=w.product_id JOIN branches b ON b.id=w.branch_id
    LEFT JOIN employees c ON c.id=w.created_by_employee_id LEFT JOIN employees a ON a.id=w.approved_by_employee_id
    LEFT JOIN inventory_writeoff_financial_approvals fa ON fa.writeoff_id=w.id
    WHERE w.status='approved' AND date(w.approved_at) BETWEEN date(?) AND date(?)${branch}
      AND (COALESCE(w.tracked_value,0)>=? OR w.reason_code IN ('theft','destruction','shrinkage'))
    ORDER BY COALESCE(w.tracked_value,0) DESC`,args:[...args,high]});
  return rows.map(x=>{const value=r2(Number(x.tracked_value||x.estimated_value||0));const missingFinancial=(value>=high||['theft','destruction'].includes(String(x.reason_code||'')))&&!x.financial_authorizer_employee_id;return {signal_key:key(['approved_writeoff_review',x.id]),signal_type:missingFinancial?'writeoff_financial_approval_gap':'high_risk_inventory_writeoff',category:'inventory_loss',severity:missingFinancial?'critical':value>=high*2?'high':'medium',branch_id:x.branch_id,employee_id:x.approved_by_employee_id,product_id:x.product_id,source_type:'inventory_writeoff',source_id:x.id,estimated_loss:value,at_risk_value:0,title:`Inventory write-off requires management review: ${x.writeoff_number}`,evidence:{product_name:x.product_name,sku:x.sku,branch_name:x.branch_name,quantity:Number(x.quantity||0),reason_code:x.reason_code,reason_detail:x.reason_detail,reference:x.reference||null,tracked_value:value,valuation_status:x.valuation_status,creator_name:x.creator_name,approver_name:x.approver_name,financial_authorizer_employee_id:x.financial_authorizer_employee_id||null,financial_reason:x.financial_reason||null,evidence_reference:x.evidence_reference||null,financial_approval_gap:missingFinancial},recommended_action:missingFinancial?'Reconcile this approved high-risk write-off immediately. Verify physical disposition, valuation, incident/disposal evidence and independent financial authorization.':'Review physical disposition, supporting evidence, valuation and approval chain. The write-off is already recorded as an inventory loss; this signal does not imply misconduct.'};});
}

async function pairingSignals(p){
  if(!(await table('inventory_writeoffs')))return [];
  const count=Math.max(2,await settingNumber('loss_control_writeoff_pair_review_count',4));
  const args=[p.start,p.end];let branch='';if(p.branchId){branch=' AND w.branch_id=?';args.push(p.branchId);}
  const {rows}=await db.execute({sql:`SELECT w.created_by_employee_id,w.approved_by_employee_id,w.branch_id,b.name branch_name,
      c.first_name||' '||c.last_name creator_name,a.first_name||' '||a.last_name approver_name,
      COUNT(*) approval_count,COALESCE(SUM(w.tracked_value),0) approved_value,
      SUM(CASE WHEN w.reason_code IN ('theft','destruction','shrinkage') THEN 1 ELSE 0 END) high_risk_count
    FROM inventory_writeoffs w LEFT JOIN employees c ON c.id=w.created_by_employee_id LEFT JOIN employees a ON a.id=w.approved_by_employee_id LEFT JOIN branches b ON b.id=w.branch_id
    WHERE w.status='approved' AND date(w.approved_at) BETWEEN date(?) AND date(?)${branch}
      AND w.created_by_employee_id IS NOT NULL AND w.approved_by_employee_id IS NOT NULL
    GROUP BY w.created_by_employee_id,w.approved_by_employee_id,w.branch_id
    HAVING approval_count>=? ORDER BY approved_value DESC`,args:[...args,count]});
  return rows.map(x=>({signal_key:key(['writeoff_pairing',x.created_by_employee_id,x.approved_by_employee_id,x.branch_id,p.start,p.end]),signal_type:'inventory_writeoff_approval_pair_concentration',category:'inventory_loss',severity:Number(x.high_risk_count||0)>=2||Number(x.approved_value||0)>=500000?'high':'medium',branch_id:x.branch_id,employee_id:x.approved_by_employee_id,estimated_loss:0,at_risk_value:r2(x.approved_value),title:`Repeated inventory write-off approval pairing requires review`,evidence:{period_start:p.start,period_end:p.end,creator_name:x.creator_name,approver_name:x.approver_name,branch_name:x.branch_name,approval_count:Number(x.approval_count||0),approved_value:r2(x.approved_value),high_risk_count:Number(x.high_risk_count||0),review_threshold:count},recommended_action:'Review whether repeated creator/approver pairing is operationally expected, whether evidence quality is consistent, and whether duties should be rotated. This is a concentration signal, not a misconduct finding.'}));
}

async function collect(p){const groups=await Promise.all([approvedWriteoffSignals(p),pairingSignals(p)]);return groups.flat().sort((a,b)=>Number(b.estimated_loss||b.at_risk_value||0)-Number(a.estimated_loss||a.at_risk_value||0));}
async function upsert(s,employeeId){
  if(!(await table('loss_control_cases')))throw new Error('Base loss-control module must initialize before write-off scan can record cases.');
  const {rows:[existing]}=await db.execute({sql:'SELECT id FROM loss_control_cases WHERE signal_key=?',args:[s.signal_key]});
  if(existing){await db.execute({sql:`UPDATE loss_control_cases SET signal_type=?,category=?,severity=?,branch_id=?,employee_id=?,product_id=?,source_type=?,source_id=?,title=?,estimated_loss=?,at_risk_value=?,evidence_json=?,recommended_action=?,last_detected_at=CURRENT_TIMESTAMP WHERE id=?`,args:[s.signal_type,s.category,s.severity,s.branch_id||null,s.employee_id||null,s.product_id||null,s.source_type||null,s.source_id||null,s.title,r2(s.estimated_loss),r2(s.at_risk_value),JSON.stringify(s.evidence||{}),s.recommended_action||null,existing.id]});return existing.id;}
  const r=await db.execute({sql:`INSERT INTO loss_control_cases(signal_key,signal_type,category,severity,branch_id,employee_id,product_id,source_type,source_id,title,estimated_loss,at_risk_value,evidence_json,recommended_action) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:[s.signal_key,s.signal_type,s.category,s.severity,s.branch_id||null,s.employee_id||null,s.product_id||null,s.source_type||null,s.source_id||null,s.title,r2(s.estimated_loss),r2(s.at_risk_value),JSON.stringify(s.evidence||{}),s.recommended_action||null]});
  const id=Number(r.lastInsertRowid);await db.execute({sql:'INSERT INTO loss_control_case_events(case_id,event_type,employee_id,details) VALUES(?,?,?,?)',args:[id,'detected',employeeId||null,'Inventory write-off loss-control signal created from system evidence.']});return id;
}
router.get('/writeoff-signals',async(req,res)=>{try{const p=period(req),signals=await collect(p);res.json({period:p,count:signals.length,signals,warning:'Write-off signals support management review and do not establish employee misconduct.'});}catch(e){res.status(500).json({error:e.message});}});
router.post('/writeoff-scan',async(req,res)=>{try{const p=period(req),signals=await collect(p),ids=[];for(const s of signals)ids.push(await upsert(s,req.employee?.id));res.json({period:p,detected:signals.length,case_ids:ids,message:'Inventory write-off cases recorded for review. No inventory, accounting, employee or approval record was changed automatically.'});}catch(e){res.status(500).json({error:e.message});}});
module.exports=router;
