'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {can}=require('../lib/permissions');
const {findEmployeeByPin}=require('../lib/pinAuth');
const {writeoffError,sendWriteoffError}=require('../lib/inventory-writeoff-errors');

let readyPromise=null;
const r2=v=>Number(Number(v||0).toFixed(2));
async function ensureSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=db.batch([
    {sql:`CREATE TABLE IF NOT EXISTS inventory_writeoff_financial_approvals(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      writeoff_id INTEGER NOT NULL UNIQUE REFERENCES inventory_writeoffs(id),
      estimated_value REAL NOT NULL DEFAULT 0,
      valuation_basis TEXT NOT NULL,
      threshold_value REAL NOT NULL DEFAULT 0,
      approving_employee_id INTEGER REFERENCES employees(id),
      financial_authorizer_employee_id INTEGER NOT NULL REFERENCES employees(id),
      reason TEXT NOT NULL,
      evidence_reference TEXT,
      reason_code TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`},
    {sql:'CREATE INDEX IF NOT EXISTS idx_writeoff_financial_authorizer ON inventory_writeoff_financial_approvals(financial_authorizer_employee_id,created_at)'}
  ],'write').catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
async function settingNumber(executor,key,fallback){const {rows:[x]}=await executor.execute({sql:'SELECT value FROM settings WHERE key=?',args:[key]});const n=Number(x?.value);return Number.isFinite(n)?n:fallback;}
async function estimate(executor,writeoff){
  const {rows:[p]}=await executor.execute({sql:'SELECT id,cost FROM products WHERE id=?',args:[writeoff.product_id]});
  let unitCost=Number(p?.cost||0),basis='catalog_cost_fallback';
  try{
    const {rows:[pool]}=await executor.execute({sql:'SELECT tracked_qty,tracked_value,legacy_unlayered_qty FROM inventory_cost_pools WHERE product_id=? AND branch_key=?',args:[writeoff.product_id,writeoff.branch_id]});
    if(pool&&Number(pool.tracked_qty||0)>0&&Number(pool.tracked_value||0)>=0&&Number(pool.legacy_unlayered_qty||0)<=1e-9){unitCost=Number(pool.tracked_value)/Number(pool.tracked_qty);basis='current_tracked_inventory_pool';}
  }catch(e){}
  return {unit_cost:r2(unitCost),estimated_value:r2(unitCost*Number(writeoff.quantity||0)),basis};
}
function meaningfulEvidence(v){const s=String(v||'').trim();if(s.length<3)return false;return !new Set(['NA','N/A','NONE','UNKNOWN','NO','NIL','TBD','NOT AVAILABLE']).has(s.toUpperCase());}
async function authorize(req,writeoff,valuation,threshold,evidenceThreshold){
  const pin=String(req.body?.writeoff_financial_pin||'').trim();
  const reason=String(req.body?.writeoff_financial_reason||'').trim();
  const evidence=String(req.body?.writeoff_evidence_reference||writeoff.reference||'').trim();
  const reasonCode=String(writeoff.reason_code||'').toLowerCase();
  const evidenceRequired=['theft','destruction','shrinkage'].includes(reasonCode)||valuation.estimated_value+0.009>=evidenceThreshold;
  if(!pin)throw writeoffError('WRITEOFF_FINANCIAL_AUTH_REQUIRED');
  if(reason.length<5)throw writeoffError('WRITEOFF_FINANCIAL_AUTH_REQUIRED');
  if(evidenceRequired&&!meaningfulEvidence(evidence))throw writeoffError('WRITEOFF_FINANCIAL_AUTH_REQUIRED');
  const {rows:employees}=await db.execute({sql:'SELECT e.id,e.first_name,e.last_name,e.pin,sg.permissions FROM employees e LEFT JOIN security_groups sg ON sg.id=e.security_group_id WHERE e.active=1',args:[]});
  const auth=await findEmployeeByPin(employees,pin,e=>{let p={};try{p=JSON.parse(e.permissions||'{}')}catch{}return can(p,'reports_financial')||can(p,'security_manage');});
  if(!auth)throw writeoffError('WRITEOFF_FINANCIAL_AUTH_FORBIDDEN');
  if(req.employee&&String(auth.id)===String(req.employee.id))throw writeoffError('WRITEOFF_FINANCIAL_AUTH_FORBIDDEN');
  if(writeoff.created_by_employee_id&&String(auth.id)===String(writeoff.created_by_employee_id))throw writeoffError('WRITEOFF_FINANCIAL_AUTH_FORBIDDEN');
  return {auth,reason,evidence,threshold,evidenceThreshold,evidenceRequired};
}
router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){sendWriteoffError(res,e,{operation:'financial_schema_init',employee_id:req.employee?.id||null});}});
router.post('/:id/approve',async(req,res,next)=>{
  try{
    const {rows:[w]}=await db.execute({sql:'SELECT * FROM inventory_writeoffs WHERE id=?',args:[req.params.id]});
    if(!w||w.status!=='pending_approval')return next();
    const valuation=await estimate(db,w);
    const threshold=Math.max(0,await settingNumber(db,'loss_control_high_value_writeoff_threshold',100000));
    const evidenceThreshold=Math.max(threshold,await settingNumber(db,'loss_control_writeoff_evidence_threshold',250000));
    const highRiskReason=['theft','destruction','shrinkage'].includes(String(w.reason_code||'').toLowerCase());
    if(valuation.estimated_value+0.009<threshold&&!highRiskReason)return next();
    const approval=await authorize(req,w,valuation,threshold,evidenceThreshold);
    req.writeoffFinancialAuthorization={required:true,authorizerEmployeeId:Number(approval.auth.id),reason:approval.reason,evidenceReference:approval.evidence||null,thresholdValue:threshold,evidenceThreshold,estimatedValue:valuation.estimated_value,valuationBasis:valuation.basis,evidenceRequired:approval.evidenceRequired};
    delete req.body.writeoff_financial_pin;delete req.body.writeoff_financial_reason;delete req.body.writeoff_evidence_reference;
    next();
  }catch(e){sendWriteoffError(res,e,{operation:'prepare_financial_authorization',writeoff_id:Number(req.params.id)||null,employee_id:req.employee?.id||null});}
});
module.exports=router;
module.exports.ensureSchema=ensureSchema;
module.exports.estimateWriteoff=estimate;
module.exports.settingNumber=settingNumber;
module.exports.meaningfulEvidence=meaningfulEvidence;
