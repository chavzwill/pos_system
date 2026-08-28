'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {can}=require('../lib/permissions');
const normalize=v=>String(v||'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'');
const money=v=>Number(Number(v||0).toFixed(2));
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
  {sql:'CREATE INDEX IF NOT EXISTS idx_supplier_payment_override_ref ON supplier_payment_override_events(supplier_id,normalized_reference,created_at)'},
  {sql:`CREATE TABLE IF NOT EXISTS supplier_payment_similarity_override_events(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payment_id INTEGER NOT NULL UNIQUE REFERENCES supplier_payments(id),
    supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
    payment_date DATE NOT NULL,
    amount REAL NOT NULL,
    trigger_type TEXT NOT NULL,
    prior_payment_ids TEXT NOT NULL,
    authorizer_employee_id INTEGER NOT NULL REFERENCES employees(id),
    reason TEXT NOT NULL,
    evidence_json TEXT NOT NULL DEFAULT '{}',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`},
  {sql:'CREATE INDEX IF NOT EXISTS idx_supplier_payment_similarity ON supplier_payment_similarity_override_events(supplier_id,payment_date,amount,created_at)'}
],'write').catch(e=>{readyPromise=null;throw e;});return readyPromise;}
router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Supplier-payment loss-prevention initialization failed',detail:e.message});}});
async function authorize(req,message){
  const reason=String(req.body?.duplicate_payment_override_reason||req.body?.payment_similarity_override_reason||'').trim();
  const pin=String(req.body?.duplicate_payment_override_pin||req.body?.payment_similarity_override_pin||'').trim();
  if(!pin)throw Object.assign(new Error(message),{status:409});
  if(reason.length<5)throw Object.assign(new Error('A meaningful supplier-payment override reason is required.'),{status:400});
  const {rows:employees}=await db.execute({sql:`SELECT e.id,e.first_name,e.last_name,e.pin,sg.permissions FROM employees e LEFT JOIN security_groups sg ON sg.id=e.security_group_id WHERE e.active=1`,args:[]});
  const authorizer=employees.find(e=>String(e.pin)===pin&&(()=>{let p={};try{p=JSON.parse(e.permissions||'{}');}catch{}return can(p,'reports_financial')||can(p,'security_manage');})());
  if(!authorizer)throw Object.assign(new Error('Invalid supervisor PIN or insufficient supplier-payment approval authority.'),{status:403});
  if(req.employee&&String(req.employee.id)===String(authorizer.id))throw Object.assign(new Error('Independent supervisor authorization is required for a suspicious supplier payment.'),{status:403});
  return {authorizer,reason};
}
router.post('/payments',async(req,res,next)=>{
  try{
    const supplierId=Number(req.body?.supplier_id),normalized=normalize(req.body?.reference),amount=money(req.body?.amount),paymentDate=String(req.body?.payment_date||'').trim();
    if(!supplierId||!(amount>0)||!paymentDate)return next();
    const {rows:all}=await db.execute({sql:`SELECT id,payment_number,reference,amount,payment_date,payment_method,recorded_by,created_at FROM supplier_payments WHERE supplier_id=? ORDER BY id`,args:[supplierId]});
    const exactReference=normalized?all.filter(x=>normalize(x.reference)===normalized):[];
    const sameDayAmount=all.filter(x=>String(x.payment_date)===paymentDate&&Math.abs(money(x.amount)-amount)<=0.009);
    const priorMap=new Map();for(const p of [...exactReference,...sameDayAmount])priorMap.set(Number(p.id),p);const prior=[...priorMap.values()];
    if(!prior.length)return next();
    const triggers=[];if(exactReference.length)triggers.push('duplicate_reference');if(sameDayAmount.length)triggers.push('same_supplier_amount_date');
    const message=exactReference.length
      ?`Payment reference ${req.body?.reference} has already been recorded for this supplier. Independent approval is required before another payment can use it.`
      :`A payment of ${amount.toFixed(2)} is already recorded for this supplier on ${paymentDate}. Independent approval is required before posting another same-day payment for the same amount.`;
    const ev=await authorize(req,message);
    delete req.body.duplicate_payment_override_pin;delete req.body.duplicate_payment_override_reason;delete req.body.payment_similarity_override_pin;delete req.body.payment_similarity_override_reason;
    const originalJson=res.json.bind(res);let handled=false;
    res.json=function(payload){
      if(handled)return originalJson(payload);handled=true;
      if(res.statusCode>=200&&res.statusCode<300&&payload?.id)return (async()=>{
        if(exactReference.length)await db.execute({sql:`INSERT INTO supplier_payment_override_events(payment_id,supplier_id,normalized_reference,prior_payment_ids,authorizer_employee_id,reason) VALUES(?,?,?,?,?,?)`,args:[payload.id,supplierId,normalized,JSON.stringify(exactReference.map(x=>x.id)),ev.authorizer.id,ev.reason]});
        await db.execute({sql:`INSERT INTO supplier_payment_similarity_override_events(payment_id,supplier_id,payment_date,amount,trigger_type,prior_payment_ids,authorizer_employee_id,reason,evidence_json) VALUES(?,?,?,?,?,?,?,?,?)`,args:[payload.id,supplierId,paymentDate,amount,triggers.join('+'),JSON.stringify(prior.map(x=>x.id)),ev.authorizer.id,ev.reason,JSON.stringify({reference:req.body?.reference||null,normalized_reference:normalized||null,prior:prior.map(x=>({id:x.id,payment_number:x.payment_number,reference:x.reference,amount:money(x.amount),payment_date:x.payment_date,payment_method:x.payment_method}))})]});
        return originalJson({...payload,supplier_payment_similarity_override_recorded:true,override_triggers:triggers});
      })().catch(err=>{if(!res.headersSent){res.status(500);return originalJson({error:'Supplier payment posted but duplicate/similarity override evidence failed to persist; reconciliation required',payment_id:payload.id,detail:err.message});}});
      return originalJson(payload);
    };
    next();
  }catch(e){res.status(e.status||500).json({error:e.message});}
});
module.exports=router;
module.exports.ensureSchema=ensureSchema;
