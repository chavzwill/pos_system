'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {can,requirePermission}=require('../lib/permissions');

let readyPromise=null;
async function ensureTaxControl(){
  if(readyPromise)return readyPromise;
  readyPromise=db.batch([
    {sql:`CREATE TABLE IF NOT EXISTS retail_tax_exemption_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id INTEGER NOT NULL UNIQUE REFERENCES transactions(id),
      transaction_number TEXT,
      customer_id INTEGER REFERENCES customers(id),
      branch_id INTEGER REFERENCES branches(id),
      cashier_employee_id INTEGER REFERENCES employees(id),
      authorizer_employee_id INTEGER NOT NULL REFERENCES employees(id),
      exemption_number TEXT NOT NULL,
      reason TEXT NOT NULL,
      taxable_subtotal REAL NOT NULL DEFAULT 0,
      tax_avoided_estimate REAL NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`},
    {sql:'CREATE INDEX IF NOT EXISTS idx_tax_exemption_authorizer ON retail_tax_exemption_events(authorizer_employee_id,created_at)'},
    {sql:'CREATE INDEX IF NOT EXISTS idx_tax_exemption_customer ON retail_tax_exemption_events(customer_id,created_at)'}
  ],'write').catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
async function settingBool(key,fallback=false){const {rows:[r]}=await db.execute({sql:'SELECT value FROM settings WHERE key=?',args:[key]});const v=String(r?.value??(fallback?'true':'false')).toLowerCase();return ['1','true','yes','on'].includes(v);}
async function authorize(req){
  const b=req.body||{};if(!b.tax_exempt)return null;
  const exemption=String(b.tax_exemption_number||'').trim(),reason=String(b.tax_exemption_reason||'').trim(),pin=String(b.tax_exemption_override_pin||'').trim();
  if(exemption.length<4)throw Object.assign(new Error('A valid tax exemption/certificate number is required.'),{status:400});
  if(!b.customer_id)throw Object.assign(new Error('Tax-exempt sales must be attached to a customer record so exemption evidence remains traceable.'),{status:409});
  if(reason.length<5)throw Object.assign(new Error('A meaningful tax-exemption reason is required.'),{status:400});
  if(!pin)throw Object.assign(new Error('Supervisor authorization is required for a tax-exempt POS sale.'),{status:409});
  const {rows:employees}=await db.execute({sql:`SELECT e.id,e.first_name,e.last_name,e.pin,sg.permissions FROM employees e LEFT JOIN security_groups sg ON sg.id=e.security_group_id WHERE e.active=1`,args:[]});
  const authorizer=employees.find(e=>String(e.pin)===pin&&(()=>{let p={};try{p=JSON.parse(e.permissions||'{}');}catch{}return can(p,'reports_financial')||can(p,'security_manage')||can(p,'settings_tax');})());
  if(!authorizer)throw Object.assign(new Error('Invalid supervisor PIN or insufficient tax-control authority.'),{status:403});
  if(!await settingBool('loss_control_tax_exemption_allow_self_approval',false)&&req.employee&&String(req.employee.id)===String(authorizer.id))throw Object.assign(new Error('Independent supervisor authorization is required for tax-exempt sales.'),{status:403});
  const items=Array.isArray(b.items)?b.items:[];let subtotal=0,taxAvoided=0;
  for(const line of items){const qty=Number(line.quantity||0),price=Number(line.uom_base_unit_price??line.unit_price??0),taxRate=Number(line.tax_rate||0);if(qty>0&&price>=0){const lineValue=qty*price;subtotal+=lineValue;taxAvoided+=lineValue*taxRate/100;}}
  return {authorizer,exemption,reason,subtotal:Number(subtotal.toFixed(2)),taxAvoided:Number(taxAvoided.toFixed(2))};
}
async function persist(req,payload,ev){
  if(!ev||!payload?.id)return;
  await db.execute({sql:`INSERT INTO retail_tax_exemption_events(transaction_id,transaction_number,customer_id,branch_id,cashier_employee_id,authorizer_employee_id,exemption_number,reason,taxable_subtotal,tax_avoided_estimate) VALUES(?,?,?,?,?,?,?,?,?,?)`,args:[payload.id,payload.transaction_number||null,req.body?.customer_id||null,req.body?.branch_id||null,req.employee?.id||payload.employee_id||null,ev.authorizer.id,ev.exemption,ev.reason,ev.subtotal,ev.taxAvoided]});
}
router.use(async(req,res,next)=>{try{await ensureTaxControl();next();}catch(e){res.status(500).json({error:'Tax-exemption control initialization failed',detail:e.message});}});
router.post('/',requirePermission('pos'),async(req,res,next)=>{
  let ev;try{ev=await authorize(req);}catch(e){return res.status(e.status||500).json({error:e.message});}
  if(!ev)return next();
  delete req.body.tax_exemption_override_pin;delete req.body.tax_exemption_reason;
  req.retailTaxExemptionEvidence=ev;
  const originalJson=res.json.bind(res);let handled=false;
  res.json=function(payload){if(handled)return originalJson(payload);handled=true;if(res.statusCode>=200&&res.statusCode<300&&payload?.id)return persist(req,payload,ev).then(()=>originalJson({...payload,tax_exemption_control_recorded:true})).catch(err=>{if(!res.headersSent){res.status(500);return originalJson({error:'Sale posted but tax-exemption control evidence failed to persist; reconciliation required',transaction_id:payload.id,detail:err.message});}});return originalJson(payload);};
  next();
});
module.exports=router;
module.exports.ensureTaxControl=ensureTaxControl;
