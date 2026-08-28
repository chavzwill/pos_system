'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {can}=require('../lib/permissions');

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
async function settingNumber(key,fallback){const {rows:[x]}=await db.execute({sql:'SELECT value FROM settings WHERE key=?',args:[key]});const n=Number(x?.value);return Number.isFinite(n)?n:fallback;}
async function estimate(writeoff){
  const {rows:[p]}=await db.execute({sql:'SELECT id,cost FROM products WHERE id=?',args:[writeoff.product_id]});
  let unitCost=Number(p?.cost||0),basis='catalog_cost_fallback';
  try{
    const {rows:[pool]}=await db.execute({sql:'SELECT tracked_qty,tracked_value,legacy_unlayered_qty FROM inventory_cost_pools WHERE product_id=? AND branch_key=?',args:[writeoff.product_id,writeoff.branch_id]});
    if(pool&&Number(pool.tracked_qty||0)>0&&Number(pool.tracked_value||0)>=0&&Number(pool.legacy_unlayered_qty||0)<=1e-9){unitCost=Number(pool.tracked_value)/Number(pool.tracked_qty);basis='current_tracked_inventory_pool';}
  }catch(e){}
  return {unit_cost:r2(unitCost),estimated_value:r2(unitCost*Number(writeoff.quantity||0)),basis};
}
async function authorize(req,writeoff,valuation,threshold){
  const pin=String(req.body?.writeoff_financial_pin||'').trim();
  const reason=String(req.body?.writeoff_financial_reason||'').trim();
  const evidence=String(req.body?.writeoff_evidence_reference||writeoff.reference||'').trim();
  if(!pin)return {error:`This write-off represents approximately ${valuation.estimated_value.toFixed(2)} of inventory value and requires independent financial authorization.`};
  if(reason.length<5)return {error:'A meaningful financial-approval reason is required for this write-off.'};
  if(['theft','destruction'].includes(String(writeoff.reason_code||'').toLowerCase())&&evidence.length<3)return {error:'Theft/destruction write-offs require an evidence or incident/disposal reference before approval.'};
  const {rows:employees}=await db.execute({sql:'SELECT e.id,e.first_name,e.last_name,e.pin,sg.permissions FROM employees e LEFT JOIN security_groups sg ON sg.id=e.security_group_id WHERE e.active=1',args:[]});
  const auth=employees.find(e=>String(e.pin)===pin&&(()=>{let p={};try{p=JSON.parse(e.permissions||'{}')}catch{}return can(p,'reports_financial')||can(p,'security_manage');})());
  if(!auth)return {error:'Invalid financial-authorizer PIN or insufficient authority.'};
  if(req.employee&&String(auth.id)===String(req.employee.id))return {error:'High-value inventory write-offs require a second, independent financial authorizer.'};
  if(writeoff.created_by_employee_id&&String(auth.id)===String(writeoff.created_by_employee_id))return {error:'The employee who created the write-off cannot provide its high-value financial authorization.'};
  return {auth,reason,evidence,threshold};
}
router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Write-off financial controls failed to initialize',detail:e.message});}});
router.post('/:id/approve',async(req,res,next)=>{
  try{
    const {rows:[w]}=await db.execute({sql:'SELECT * FROM inventory_writeoffs WHERE id=?',args:[req.params.id]});
    if(!w||w.status!=='pending_approval')return next();
    const valuation=await estimate(w),threshold=Math.max(0,await settingNumber('loss_control_high_value_writeoff_threshold',100000));
    const highRiskReason=['theft','destruction'].includes(String(w.reason_code||'').toLowerCase());
    if(valuation.estimated_value+0.009<threshold&&!highRiskReason)return next();
    const approval=await authorize(req,w,valuation,threshold);
    if(approval.error)return res.status(409).json({error:approval.error,control:'high_value_writeoff',estimated_value:valuation.estimated_value,threshold_value:threshold,valuation_basis:valuation.basis});
    delete req.body.writeoff_financial_pin;delete req.body.writeoff_financial_reason;delete req.body.writeoff_evidence_reference;
    const originalJson=res.json.bind(res);let handled=false;
    res.json=function(payload){
      if(handled)return originalJson(payload);handled=true;
      if(res.statusCode>=200&&res.statusCode<300&&payload)return db.execute({sql:`INSERT INTO inventory_writeoff_financial_approvals(writeoff_id,estimated_value,valuation_basis,threshold_value,approving_employee_id,financial_authorizer_employee_id,reason,evidence_reference,reason_code) VALUES(?,?,?,?,?,?,?,?,?)`,args:[w.id,valuation.estimated_value,valuation.basis,threshold,req.employee?.id||null,approval.auth.id,approval.reason,approval.evidence||null,w.reason_code||null]}).then(()=>originalJson({...payload,financial_approval_recorded:true,estimated_writeoff_value:valuation.estimated_value})).catch(err=>{if(!res.headersSent){res.status(500);return originalJson({error:'Write-off approved but financial-control evidence failed to persist; reconciliation required',writeoff_id:w.id,detail:err.message});}});
      return originalJson(payload);
    };
    next();
  }catch(e){res.status(500).json({error:e.message});}
});
module.exports=router;
module.exports.ensureSchema=ensureSchema;
