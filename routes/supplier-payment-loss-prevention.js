'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {can}=require('../lib/permissions');
const normalize=v=>String(v||'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'');
let readyPromise=null;
async function ensureSchema(){if(readyPromise)return readyPromise;readyPromise=db.batch([
  {sql:`CREATE TABLE IF NOT EXISTS supplier_payment_override_events(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payment_id INTEGER NOT NULL UNIQUE REFERENCES supplier_payments(id),
    supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
    normalized_reference TEXT NOT NULL,
    prior_payment_ids TEXT NOT NULL,
    authorizer_employee_id INTEGER NOT NULL REFERENCES employees(id),
    reason TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`},
  {sql:'CREATE INDEX IF NOT EXISTS idx_supplier_payment_override_ref ON supplier_payment_override_events(supplier_id,normalized_reference,created_at)'}
],'write').catch(e=>{readyPromise=null;throw e;});return readyPromise;}
router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Supplier-payment loss-prevention initialization failed',detail:e.message});}});
async function authorize(req,prior,normalized){
  const reason=String(req.body?.duplicate_payment_override_reason||'').trim(),pin=String(req.body?.duplicate_payment_override_pin||'').trim();
  if(!pin)throw Object.assign(new Error(`Payment reference ${req.body?.reference} has already been recorded for this supplier. Independent approval is required before another payment can use it.`),{status:409});
  if(reason.length<5)throw Object.assign(new Error('A meaningful duplicate-payment override reason is required.'),{status:400});
  const {rows:employees}=await db.execute({sql:`SELECT e.id,e.first_name,e.last_name,e.pin,sg.permissions FROM employees e LEFT JOIN security_groups sg ON sg.id=e.security_group_id WHERE e.active=1`,args:[]});
  const authorizer=employees.find(e=>String(e.pin)===pin&&(()=>{let p={};try{p=JSON.parse(e.permissions||'{}');}catch{}return can(p,'reports_financial')||can(p,'security_manage');})());
  if(!authorizer)throw Object.assign(new Error('Invalid supervisor PIN or insufficient supplier-payment approval authority.'),{status:403});
  if(req.employee&&String(req.employee.id)===String(authorizer.id))throw Object.assign(new Error('Independent supervisor authorization is required when reusing a supplier payment reference.'),{status:403});
  return {authorizer,reason,prior,normalized};
}
router.post('/payments',async(req,res,next)=>{
  try{
    const supplierId=Number(req.body?.supplier_id),normalized=normalize(req.body?.reference);if(!supplierId||!normalized)return next();
    const {rows:all}=await db.execute({sql:`SELECT id,payment_number,reference,amount,payment_date FROM supplier_payments WHERE supplier_id=? AND TRIM(COALESCE(reference,''))!='' ORDER BY id`,args:[supplierId]});
    const prior=all.filter(x=>normalize(x.reference)===normalized);if(!prior.length)return next();
    const ev=await authorize(req,prior,normalized);delete req.body.duplicate_payment_override_pin;delete req.body.duplicate_payment_override_reason;
    const originalJson=res.json.bind(res);let handled=false;
    res.json=function(payload){if(handled)return originalJson(payload);handled=true;if(res.statusCode>=200&&res.statusCode<300&&payload?.id)return db.execute({sql:`INSERT INTO supplier_payment_override_events(payment_id,supplier_id,normalized_reference,prior_payment_ids,authorizer_employee_id,reason) VALUES(?,?,?,?,?,?)`,args:[payload.id,supplierId,normalized,JSON.stringify(prior.map(x=>x.id)),ev.authorizer.id,ev.reason]}).then(()=>originalJson({...payload,duplicate_payment_reference_override_recorded:true})).catch(err=>{if(!res.headersSent){res.status(500);return originalJson({error:'Supplier payment posted but duplicate-reference override evidence failed to persist; reconciliation required',payment_id:payload.id,detail:err.message});}});return originalJson(payload);};
    next();
  }catch(e){res.status(e.status||500).json({error:e.message});}
});
module.exports=router;
