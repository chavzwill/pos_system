'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {can,requirePermission}=require('../lib/permissions');

let readyPromise=null;
const r2=v=>Number(Number(v||0).toFixed(2));
async function ensureSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=db.batch([
    {sql:`CREATE TABLE IF NOT EXISTS retail_credit_override_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id INTEGER NOT NULL UNIQUE REFERENCES transactions(id),
      transaction_number TEXT,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      branch_id INTEGER REFERENCES branches(id),
      cashier_employee_id INTEGER REFERENCES employees(id),
      authorizer_employee_id INTEGER NOT NULL REFERENCES employees(id),
      reason TEXT NOT NULL,
      aged_balance REAL NOT NULL DEFAULT 0,
      aged_days_threshold INTEGER NOT NULL,
      prior_account_balance REAL NOT NULL DEFAULT 0,
      credit_limit REAL NOT NULL DEFAULT 0,
      projected_charge REAL NOT NULL DEFAULT 0,
      projected_account_balance REAL NOT NULL DEFAULT 0,
      override_type TEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`},
    {sql:'CREATE INDEX IF NOT EXISTS idx_credit_override_customer ON retail_credit_override_events(customer_id,created_at)'},
    {sql:'CREATE INDEX IF NOT EXISTS idx_credit_override_authorizer ON retail_credit_override_events(authorizer_employee_id,created_at)'}
  ],'write').catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
async function settingNumber(k,d){const {rows:[r]}=await db.execute({sql:'SELECT value FROM settings WHERE key=?',args:[k]});const n=Number(r?.value);return Number.isFinite(n)?n:d;}
async function settingBool(k,d=false){const {rows:[r]}=await db.execute({sql:'SELECT value FROM settings WHERE key=?',args:[k]});return ['1','true','yes','on'].includes(String(r?.value??(d?'true':'false')).toLowerCase());}
function isCredit(body){if(String(body?.payment_method||'').toLowerCase()==='credit')return true;const t=Array.isArray(body?.tenders)?body.tenders:[];return t.some(x=>String(x.method||'').toLowerCase()==='credit');}
async function agedBalance(customerId,days){
  const {rows:[row]}=await db.execute({sql:`SELECT COALESCE(SUM(MAX(0,t.total-COALESCE(pa.paid,0)-COALESCE(ca.adjusted,0))),0) aged
    FROM transactions t
    LEFT JOIN (SELECT transaction_id,SUM(amount) paid FROM payment_allocations GROUP BY transaction_id) pa ON pa.transaction_id=t.id
    LEFT JOIN (SELECT transaction_id,SUM(amount) adjusted FROM customer_account_adjustments WHERE adjustment_type='credit_note' GROUP BY transaction_id) ca ON ca.transaction_id=t.id
    WHERE t.customer_id=? AND t.status='completed' AND t.payment_method='credit' AND julianday('now')-julianday(t.created_at)>?`,args:[customerId,days]});return r2(row?.aged||0);
}
function projectedCharge(body){const items=Array.isArray(body?.items)?body.items:[];let sub=0,tax=0;for(const x of items){const q=Number(x.quantity||0),p=Number(x.uom_base_unit_price??x.unit_price??0),tr=Number(x.tax_rate||0);if(q>0&&p>=0){const v=q*p;sub+=v;if(!body.tax_exempt)tax+=v*tr/100;}}return r2(sub+tax-Number(body.discount_amount||0)-Number(body.store_credit_applied||0)-Number(body.cash_back_applied||0));}
async function authorize(req,details){
  const pin=String(req.body?.credit_override_pin||'').trim(),reason=String(req.body?.credit_override_reason||'').trim();
  if(!pin)throw Object.assign(new Error('Management authorization is required before extending this customer additional credit.'),{status:409,details});
  if(reason.length<5)throw Object.assign(new Error('A meaningful credit override reason is required.'),{status:400});
  const {rows:employees}=await db.execute({sql:`SELECT e.id,e.first_name,e.last_name,e.pin,sg.permissions FROM employees e LEFT JOIN security_groups sg ON sg.id=e.security_group_id WHERE e.active=1`,args:[]});
  const authorizer=employees.find(e=>String(e.pin)===pin&&(()=>{let p={};try{p=JSON.parse(e.permissions||'{}');}catch{}return can(p,'accounts')||can(p,'reports_financial')||can(p,'security_manage');})());
  if(!authorizer)throw Object.assign(new Error('Invalid supervisor PIN or insufficient credit-control authority.'),{status:403});
  if(!await settingBool('loss_control_credit_allow_self_approval',false)&&req.employee&&String(req.employee.id)===String(authorizer.id))throw Object.assign(new Error('Independent management authorization is required for this credit exception.'),{status:403});
  return {authorizer,reason};
}
async function evaluate(req){
  const b=req.body||{};if(!isCredit(b))return null;
  const customerId=Number(b.customer_id);if(!customerId)throw Object.assign(new Error('Charge Account sales require a customer.'),{status:400});
  const {rows:[c]}=await db.execute({sql:'SELECT id,customer_type,credit_enabled,account_blocked,account_balance,credit_limit,active FROM customers WHERE id=?',args:[customerId]});
  if(!c||!c.active)throw Object.assign(new Error('Customer is unavailable for credit sale.'),{status:409});
  if(c.customer_type!=='credit'&&!c.credit_enabled)throw Object.assign(new Error('Customer does not have an active credit account.'),{status:409});
  if(c.account_blocked)throw Object.assign(new Error('Customer account is blocked and cannot receive additional credit.'),{status:409});
  const age=Math.max(30,await settingNumber('loss_control_credit_override_age_days',90));
  const aged=await agedBalance(customerId,age),charge=projectedCharge(b),prior=r2(c.account_balance),limit=r2(c.credit_limit),projected=r2(prior+charge);
  const agedThreshold=Math.max(0,await settingNumber('loss_control_credit_override_aged_balance',0));
  const agedRisk=aged>Math.max(0.01,agedThreshold),limitRisk=limit>0&&projected>limit+0.01;
  if(!agedRisk&&!limitRisk)return {requires_override:false};
  const type=agedRisk&&limitRisk?'aged_debt_and_limit':'aged_debt';
  const finalType=limitRisk&&!agedRisk?'credit_limit':type;
  const details={aged_balance:aged,aged_days_threshold:age,prior_account_balance:prior,credit_limit:limit,projected_charge:charge,projected_account_balance:projected,override_type:finalType};
  const auth=await authorize(req,details);
  return {requires_override:true,customerId,aged,age,prior,limit,charge,projected,type:finalType,authorizer:auth.authorizer,reason:auth.reason};
}
async function persist(req,payload,ev){if(!ev?.requires_override||!payload?.id)return;await db.execute({sql:`INSERT INTO retail_credit_override_events(transaction_id,transaction_number,customer_id,branch_id,cashier_employee_id,authorizer_employee_id,reason,aged_balance,aged_days_threshold,prior_account_balance,credit_limit,projected_charge,projected_account_balance,override_type)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:[payload.id,payload.transaction_number||null,ev.customerId,req.body?.branch_id||null,req.employee?.id||payload.employee_id||null,ev.authorizer.id,ev.reason,ev.aged,ev.age,ev.prior,ev.limit,ev.charge,ev.projected,ev.type]});}
router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Credit-control initialization failed',detail:e.message});}});
router.post('/',requirePermission('pos'),async(req,res,next)=>{
  let ev;try{ev=await evaluate(req);}catch(e){return res.status(e.status||500).json({error:e.message,...(e.details||{})});}
  if(!ev||!ev.requires_override)return next();
  delete req.body.credit_override_pin;delete req.body.credit_override_reason;
  const originalJson=res.json.bind(res);let handled=false;
  res.json=function(payload){if(handled)return originalJson(payload);handled=true;if(res.statusCode>=200&&res.statusCode<300&&payload?.id)return persist(req,payload,ev).then(()=>originalJson({...payload,credit_override_recorded:true})).catch(err=>{if(!res.headersSent){res.status(500);return originalJson({error:'Credit sale posted but override evidence failed to persist; reconciliation required',transaction_id:payload.id,detail:err.message});}});return originalJson(payload);};
  next();
});
module.exports=router;
module.exports.ensureSchema=ensureSchema;