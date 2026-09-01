'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {can,requirePermission}=require('../lib/permissions');
const {findEmployeeByPin}=require('../lib/pinAuth');

let readyPromise=null;
const r2=v=>Number(Number(v||0).toFixed(2));
async function ensureMarginProtection(){
  if(readyPromise)return readyPromise;
  readyPromise=db.batch([
    {sql:`CREATE TABLE IF NOT EXISTS retail_margin_override_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id INTEGER REFERENCES transactions(id),
      transaction_number TEXT,
      branch_id INTEGER REFERENCES branches(id),
      cashier_employee_id INTEGER REFERENCES employees(id),
      authorizer_employee_id INTEGER NOT NULL REFERENCES employees(id),
      reason TEXT NOT NULL,
      gross_revenue REAL NOT NULL,
      discount_amount REAL NOT NULL DEFAULT 0,
      projected_net_revenue REAL NOT NULL,
      projected_inventory_cost REAL NOT NULL,
      projected_gross_margin REAL NOT NULL,
      projected_gross_margin_pct REAL,
      required_margin_pct REAL NOT NULL DEFAULT 0,
      evidence_json TEXT NOT NULL DEFAULT '{}',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`},
    {sql:'CREATE INDEX IF NOT EXISTS idx_margin_override_tx ON retail_margin_override_events(transaction_id,id)'},
    {sql:'CREATE INDEX IF NOT EXISTS idx_margin_override_authorizer ON retail_margin_override_events(authorizer_employee_id,created_at)'}
  ],'write').catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
async function setting(key,fallback){const {rows:[r]}=await db.execute({sql:'SELECT value FROM settings WHERE key=?',args:[key]});return r?.value==null?fallback:r.value;}
async function settingNumber(key,fallback){const n=Number(await setting(key,fallback));return Number.isFinite(n)?n:fallback;}
async function settingBool(key,fallback=false){const v=String(await setting(key,fallback?'true':'false')).trim().toLowerCase();return ['1','true','yes','on'].includes(v);}
function canOperateCrossBranch(employee){return !!employee&&(can(employee.permissions,'branches')||can(employee.permissions,'security_manage'));}
function branchAccessError(req){
  if(req.apiKey||!req.employee)return null;
  const branchId=Number(req.body?.branch_id)||null,home=Number(req.employee.default_branch_id)||null;
  if(branchId&&home&&branchId!==home&&!canOperateCrossBranch(req.employee))return 'You cannot complete a sale for another branch. Switch to your assigned branch or ask an authorized cross-branch administrator.';
  return null;
}
async function unitCostEvidence(productId,branchId,product){
  if(branchId){
    try{const {rows:[pool]}=await db.execute({sql:'SELECT * FROM inventory_cost_pools WHERE product_id=? AND branch_key=?',args:[productId,branchId]});if(pool&&Number(pool.legacy_unlayered_qty||0)<=1e-9&&Number(pool.tracked_qty||0)>0&&Number(pool.tracked_value||0)>=0)return {unit_cost:Number(pool.tracked_value)/Number(pool.tracked_qty),basis:'current_tracked_inventory_pool'};}catch(e){}
  }
  return {unit_cost:Number(product.cost||0),basis:'catalog_cost_fallback'};
}
function marginPct(revenue,cost){return revenue>0?Number((100*(revenue-cost)/revenue).toFixed(2)):null;}
async function authorizeOverride(req){
  const pin=String(req.body?.margin_override_pin||'').trim(),reason=String(req.body?.margin_override_reason||'').trim();
  if(!pin)return {error:'Supervisor authorization is required because this sale falls below the configured gross-margin floor.'};
  if(reason.length<5)return {error:'A meaningful margin override reason is required.'};
  const {rows:employees}=await db.execute({sql:`SELECT e.id,e.first_name,e.last_name,e.pin,sg.permissions FROM employees e LEFT JOIN security_groups sg ON sg.id=e.security_group_id WHERE e.active=1`,args:[]});
  const authorizer=await findEmployeeByPin(employees,pin,e=>{let p={};try{p=JSON.parse(e.permissions||'{}');}catch{}return can(p,'reports_financial')||can(p,'security_manage');});
  if(!authorizer)return {error:'Invalid supervisor PIN or insufficient margin-override authority.'};
  if(!await settingBool('loss_control_margin_override_allow_self',false)&&req.employee&&String(authorizer.id)===String(req.employee.id))return {error:'Independent supervisor authorization is required for a below-floor margin sale.'};
  return {authorizer,reason};
}
async function evaluate(req){
  await ensureMarginProtection();
  const body=req.body||{},items=Array.isArray(body.items)?body.items:[];if(!items.length)return null;
  const discount=Number(body.discount_amount||0);if(!Number.isFinite(discount)||discount<0)return null;
  if(discount>0&&!req.apiKey&&(!req.employee||!can(req.employee.permissions,'pos_discounts'))){const e=new Error('This employee is not authorized to apply POS discounts.');e.status=403;throw e;}
  const branchId=Number(body.branch_id)||null,lines=[];let gross=0,cost=0;
  for(const line of items){const pid=Number(line.product_id),qty=Number(line.quantity);if(!(pid>0&&qty>0))continue;const {rows:[product]}=await db.execute({sql:'SELECT id,name,sku,price,cost FROM products WHERE id=?',args:[pid]});if(!product)continue;const unitPrice=line.uom_base_unit_price!=null?Number(line.uom_base_unit_price):Number(product.price||0);if(!Number.isFinite(unitPrice)||unitPrice<0)continue;const costEvidence=await unitCostEvidence(pid,branchId,product),lineGross=unitPrice*qty,lineCost=Number(costEvidence.unit_cost||0)*qty;gross+=lineGross;cost+=lineCost;lines.push({product_id:pid,sku:product.sku,name:product.name,quantity:qty,unit_price:unitPrice,line_gross:r2(lineGross),unit_cost:r2(costEvidence.unit_cost),line_cost:r2(lineCost),cost_basis:costEvidence.basis});}
  gross=r2(gross);cost=r2(cost);const net=r2(gross-discount),margin=r2(net-cost),pct=marginPct(net,cost),floor=Math.max(0,await settingNumber('loss_control_min_gross_margin_pct',0));
  const belowCost=margin< -0.009,belowFloor=pct!=null&&pct+1e-9<floor;
  if(!belowCost&&!belowFloor)return {requires_override:false,gross,discount,net,cost,margin,pct,floor,lines};
  const auth=await authorizeOverride(req);if(auth.error){const e=new Error(auth.error);e.status=409;e.details={projected_net_revenue:net,projected_inventory_cost:cost,projected_gross_margin:margin,projected_gross_margin_pct:pct,required_margin_pct:floor};throw e;}
  return {requires_override:true,gross,discount,net,cost,margin,pct,floor,lines,authorizer:auth.authorizer,reason:auth.reason};
}
async function persistOverride(req,payload,ev){
  if(!ev?.requires_override||!payload?.id)return;
  await db.execute({sql:`INSERT INTO retail_margin_override_events(transaction_id,transaction_number,branch_id,cashier_employee_id,authorizer_employee_id,reason,gross_revenue,discount_amount,projected_net_revenue,projected_inventory_cost,projected_gross_margin,projected_gross_margin_pct,required_margin_pct,evidence_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:[payload.id,payload.transaction_number||null,req.body?.branch_id||null,req.employee?.id||payload.employee_id||null,ev.authorizer.id,ev.reason,ev.gross,ev.discount,ev.net,ev.cost,ev.margin,ev.pct,ev.floor,JSON.stringify({lines:ev.lines,authorizer_name:`${ev.authorizer.first_name||''} ${ev.authorizer.last_name||''}`.trim(),evaluated_at:new Date().toISOString()})]});
}
router.use(async(req,res,next)=>{try{await ensureMarginProtection();next();}catch(e){res.status(500).json({error:'Retail margin protection initialization failed',detail:e.message});}});
router.post('/',requirePermission('pos'),async(req,res,next)=>{
  // This router is reached through both the UOM commercial-control chain and
  // checkout hardening. Evaluate exactly once per request: an approved override
  // deliberately removes the raw PIN before downstream processing, so a second
  // evaluation must reuse the first decision rather than demand the secret again.
  if(req.retailMarginEvidence)return next();
  const accessError=branchAccessError(req);if(accessError)return res.status(403).json({error:accessError,control:'retail_branch_access'});
  let ev;try{ev=await evaluate(req);}catch(e){return res.status(e.status||500).json({error:e.message,...(e.details||{})});}
  if(!ev)return next();
  req.retailMarginEvidence=ev;
  if(!ev.requires_override)return next();
  delete req.body.margin_override_pin;delete req.body.margin_override_reason;
  const originalJson=res.json.bind(res);let handled=false;
  res.json=function(payload){if(handled)return originalJson(payload);handled=true;if(res.statusCode>=200&&res.statusCode<300&&payload?.id)return persistOverride(req,payload,ev).then(()=>originalJson({...payload,margin_override_recorded:true})).catch(err=>{if(!res.headersSent){res.status(500);return originalJson({error:'Sale posted but margin override evidence failed to persist; reconciliation required',transaction_id:payload.id,detail:err.message});}});return originalJson(payload);};
  next();
});
module.exports=router;
module.exports.ensureMarginProtection=ensureMarginProtection;
module.exports.evaluateMargin=evaluate;
