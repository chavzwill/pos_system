'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');

let readyPromise=null;
const r2=v=>Number(Number(v||0).toFixed(2));
async function ensureSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=db.batch([
    {sql:`CREATE TABLE IF NOT EXISTS retail_promotion_control_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id INTEGER NOT NULL UNIQUE REFERENCES transactions(id),
      transaction_number TEXT,
      promotion_id INTEGER REFERENCES promotions(id),
      promotion_code_id INTEGER REFERENCES promotion_codes(id),
      promotion_code TEXT,
      promotion_name TEXT,
      branch_id INTEGER REFERENCES branches(id),
      employee_id INTEGER REFERENCES employees(id),
      eligible_amount REAL NOT NULL DEFAULT 0,
      authoritative_discount REAL NOT NULL DEFAULT 0,
      client_discount REAL NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`},
    {sql:'CREATE INDEX IF NOT EXISTS idx_retail_promotion_control_promo ON retail_promotion_control_events(promotion_id,created_at)'},
    {sql:'CREATE INDEX IF NOT EXISTS idx_retail_promotion_control_employee ON retail_promotion_control_events(employee_id,created_at)'}
  ],'write').catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
function lineValue(line){return Number(line.quantity||0)*Number(line.uom_base_unit_price??line.unit_price??0);}
async function evaluateCode(req){
  const b=req.body||{},code=String(b.promotion_code||'').trim();if(!code)return null;
  const {rows:[pc]}=await db.execute({sql:`SELECT pc.*,p.name promo_name,p.type,p.value,p.min_purchase,p.applies_to,p.start_date,p.end_date,p.active promo_active
    FROM promotion_codes pc JOIN promotions p ON p.id=pc.promotion_id WHERE pc.code=? COLLATE NOCASE`,args:[code]});
  if(!pc)throw Object.assign(new Error('Promotion code is not valid.'),{status:409});
  if(!pc.active||!pc.promo_active)throw Object.assign(new Error('Promotion code or promotion is inactive.'),{status:409});
  const today=new Date().toISOString().slice(0,10);
  if(pc.start_date&&today<pc.start_date)throw Object.assign(new Error('Promotion has not started yet.'),{status:409});
  if(pc.end_date&&today>pc.end_date)throw Object.assign(new Error('Promotion has expired.'),{status:409});
  if(pc.usage_limit!=null&&Number(pc.times_used||0)>=Number(pc.usage_limit))throw Object.assign(new Error('Promotion code usage limit has been reached.'),{status:409});
  const items=Array.isArray(b.items)?b.items:[];let subtotal=r2(items.reduce((s,x)=>s+lineValue(x),0));
  if(Number(pc.min_purchase||0)>0&&subtotal+0.001<Number(pc.min_purchase))throw Object.assign(new Error(`Promotion requires a minimum purchase of ${Number(pc.min_purchase).toFixed(2)}.`),{status:409});
  let eligible=subtotal;
  if(['specific','categories','items'].includes(String(pc.applies_to))){
    const {rows:scope}=await db.execute({sql:'SELECT item_type,item_id FROM promotion_items WHERE promotion_id=?',args:[pc.promotion_id]});
    const productIds=new Set(scope.filter(x=>x.item_type==='product').map(x=>Number(x.item_id)));
    const categoryIds=new Set(scope.filter(x=>x.item_type==='category').map(x=>Number(x.item_id)));
    const productCategory=new Map();
    const pids=[...new Set(items.map(x=>Number(x.product_id)).filter(Boolean))];
    if(pids.length){const marks=pids.map(()=>'?').join(',');const {rows:products}=await db.execute({sql:`SELECT id,category_id FROM products WHERE id IN (${marks})`,args:pids});for(const p of products)productCategory.set(Number(p.id),Number(p.category_id)||null);}
    eligible=r2(items.reduce((s,x)=>{const pid=Number(x.product_id),cat=productCategory.get(pid);return s+((productIds.has(pid)||categoryIds.has(cat))?lineValue(x):0);},0));
    if(eligible<=0)throw Object.assign(new Error('No items in this transaction qualify for the promotion code.'),{status:409});
  }
  const authoritative=pc.type==='percentage'?r2(eligible*Number(pc.value||0)/100):r2(Math.min(Number(pc.value||0),eligible));
  const client=r2(b.discount_amount||0);
  if(Math.abs(client-authoritative)>0.01)throw Object.assign(new Error(`Promotion discount does not match the authoritative promotion value. Expected ${authoritative.toFixed(2)}.`),{status:409});
  b.discount_amount=authoritative;b.promotion_code=String(pc.code);b.promotion_name=pc.promo_name;
  return {promotionId:Number(pc.promotion_id),codeId:Number(pc.id),code:String(pc.code),name:pc.promo_name,eligible,authoritative,client};
}
async function persist(req,payload,ev){
  if(!ev||!payload?.id)return;
  const tx=await db.transaction('write');let committed=false;
  try{
    const {rows:[pc]}=await tx.execute({sql:'SELECT times_used,usage_limit,active FROM promotion_codes WHERE id=?',args:[ev.codeId]});
    if(!pc||!pc.active||pc.usage_limit!=null&&Number(pc.times_used||0)>=Number(pc.usage_limit))throw new Error('Promotion usage changed during checkout; reconciliation required.');
    await tx.execute({sql:'UPDATE promotion_codes SET times_used=times_used+1 WHERE id=?',args:[ev.codeId]});
    await tx.execute({sql:`INSERT INTO retail_promotion_control_events(transaction_id,transaction_number,promotion_id,promotion_code_id,promotion_code,promotion_name,branch_id,employee_id,eligible_amount,authoritative_discount,client_discount)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`,args:[payload.id,payload.transaction_number||null,ev.promotionId,ev.codeId,ev.code,ev.name,req.body?.branch_id||null,req.employee?.id||payload.employee_id||null,ev.eligible,ev.authoritative,ev.client]});
    await tx.commit();committed=true;
  }catch(e){if(!committed)await tx.rollback();throw e;}
}
router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Promotion-control initialization failed',detail:e.message});}});
router.post('/',requirePermission('pos'),async(req,res,next)=>{
  let ev;try{ev=await evaluateCode(req);}catch(e){return res.status(e.status||500).json({error:e.message});}
  if(!ev)return next();
  req.retailPromotionEvidence=ev;
  const originalJson=res.json.bind(res);let handled=false;
  res.json=function(payload){if(handled)return originalJson(payload);handled=true;if(res.statusCode>=200&&res.statusCode<300&&payload?.id)return persist(req,payload,ev).then(()=>originalJson({...payload,promotion_control_recorded:true})).catch(err=>{if(!res.headersSent){res.status(500);return originalJson({error:'Sale posted but promotion usage evidence failed to persist; reconciliation required',transaction_id:payload.id,detail:err.message});}});return originalJson(payload);};
  next();
});
module.exports=router;
module.exports.ensureSchema=ensureSchema;