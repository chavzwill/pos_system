const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission } = require('../lib/permissions');

function normalizePromotion(body={}) {
  const name=String(body.name||'').trim();
  const type=String(body.type||'').trim();
  const appliesTo=String(body.applies_to||'all').trim();
  const value=Number(body.value??0);
  const minPurchase=Number(body.min_purchase??0);
  const startDate=body.start_date?String(body.start_date):null;
  const endDate=body.end_date?String(body.end_date):null;
  if(!name)return {error:'Name required'};
  if(!['percentage','fixed'].includes(type))return {error:'Invalid type'};
  if(!Number.isFinite(value)||value<0)return {error:'Promotion value must be zero or greater'};
  if(type==='percentage'&&value>100)return {error:'Percentage promotions cannot exceed 100%'};
  if(!Number.isFinite(minPurchase)||minPurchase<0)return {error:'Minimum purchase must be zero or greater'};
  if(!['all','specific','categories','items'].includes(appliesTo))return {error:'Invalid applies_to scope'};
  if(startDate&&endDate&&startDate>endDate)return {error:'Promotion end date cannot be before its start date'};
  return {value:{name,description:String(body.description||'').trim()||null,type,value,min_purchase:minPurchase,applies_to:appliesTo,start_date:startDate,end_date:endDate,active:body.active!==false?1:0}};
}
function normalizeUsageLimit(value){
  if(value===null||value===undefined||value==='')return {value:null};
  const n=Number(value);if(!Number.isInteger(n)||n<=0)return {error:'Usage limit must be a positive whole number'};return {value:n};
}

router.get('/', requirePermission('promotions'), async (req, res) => {
  try { const { rows } = await db.execute({ sql: `SELECT p.*,(SELECT COUNT(*) FROM promotion_codes WHERE promotion_id=p.id) code_count,(SELECT COUNT(*) FROM promotion_items WHERE promotion_id=p.id) item_count FROM promotions p ORDER BY p.created_at DESC`, args: [] }); res.json(rows); }
  catch(e){res.status(500).json({error:e.message});}
});
router.get('/product-assignments', requirePermission('promotions'), async (req,res)=>{
  try{const {rows}=await db.execute({sql:`SELECT pi.item_id,pi.item_type,pi.promotion_id,p.name promotion_name FROM promotion_items pi JOIN promotions p ON pi.promotion_id=p.id WHERE p.active=1`,args:[]});res.json(rows);}catch(e){res.status(500).json({error:e.message});}
});
router.get('/:id', requirePermission('promotions'), async (req,res)=>{
  try{const {rows:[promo]}=await db.execute({sql:'SELECT * FROM promotions WHERE id=?',args:[req.params.id]});if(!promo)return res.status(404).json({error:'Not found'});const {rows:items}=await db.execute({sql:'SELECT * FROM promotion_items WHERE promotion_id=?',args:[req.params.id]});const {rows:codes}=await db.execute({sql:'SELECT * FROM promotion_codes WHERE promotion_id=? ORDER BY created_at DESC',args:[req.params.id]});promo.items=items;promo.codes=codes;res.json(promo);}catch(e){res.status(500).json({error:e.message});}
});
router.post('/', requirePermission('promotions'), async (req,res)=>{
  const normalized=normalizePromotion(req.body);if(normalized.error)return res.status(400).json({error:normalized.error});const p=normalized.value;
  try{const result=await db.execute({sql:`INSERT INTO promotions(name,description,type,value,min_purchase,applies_to,start_date,end_date,active) VALUES(?,?,?,?,?,?,?,?,?)`,args:[p.name,p.description,p.type,p.value,p.min_purchase,p.applies_to,p.start_date,p.end_date,p.active]});res.status(201).json({id:Number(result.lastInsertRowid)});}catch(e){res.status(400).json({error:e.message});}
});
router.put('/:id', requirePermission('promotions'), async (req,res)=>{
  const normalized=normalizePromotion(req.body);if(normalized.error)return res.status(400).json({error:normalized.error});const p=normalized.value;
  try{await db.execute({sql:`UPDATE promotions SET name=?,description=?,type=?,value=?,min_purchase=?,applies_to=?,start_date=?,end_date=?,active=? WHERE id=?`,args:[p.name,p.description,p.type,p.value,p.min_purchase,p.applies_to,p.start_date,p.end_date,p.active,req.params.id]});res.json({success:true});}catch(e){res.status(400).json({error:e.message});}
});
router.delete('/:id', requirePermission('promotions'), async (req,res)=>{try{await db.execute({sql:'DELETE FROM promotions WHERE id=?',args:[req.params.id]});res.json({success:true});}catch(e){res.status(500).json({error:e.message});}});
router.post('/:id/items', requirePermission('promotions'), async (req,res)=>{
  try{const {item_type,item_id}=req.body;if(!['product','category'].includes(item_type))return res.status(400).json({error:'item_type must be product or category'});const numeric=Number(item_id);if(!Number.isInteger(numeric)||numeric<=0)return res.status(400).json({error:'A valid product/category id is required'});const {rows:conflicts}=await db.execute({sql:`SELECT p.name FROM promotion_items pi JOIN promotions p ON pi.promotion_id=p.id WHERE pi.item_type=? AND pi.item_id=? AND pi.promotion_id!=? AND p.active=1`,args:[item_type,numeric,req.params.id]});if(conflicts.length)return res.status(409).json({error:`Already assigned to active promotion "${conflicts[0].name}"`});await db.execute({sql:'INSERT OR IGNORE INTO promotion_items(promotion_id,item_type,item_id) VALUES(?,?,?)',args:[req.params.id,item_type,numeric]});res.json({success:true});}catch(e){res.status(400).json({error:e.message});}
});
router.delete('/:id/items/:itemId', requirePermission('promotions'), async (req,res)=>{try{await db.execute({sql:'DELETE FROM promotion_items WHERE promotion_id=? AND id=?',args:[req.params.id,req.params.itemId]});res.json({success:true});}catch(e){res.status(500).json({error:e.message});}});
router.post('/:id/codes', requirePermission('promotions'), async (req,res)=>{
  const code=String(req.body?.code||'').trim().toUpperCase();if(!code)return res.status(400).json({error:'Code required'});if(code.length>80)return res.status(400).json({error:'Promotion code is too long'});const limit=normalizeUsageLimit(req.body?.usage_limit);if(limit.error)return res.status(400).json({error:limit.error});
  try{const {rows:[promo]}=await db.execute({sql:'SELECT id FROM promotions WHERE id=?',args:[req.params.id]});if(!promo)return res.status(404).json({error:'Promotion not found'});const result=await db.execute({sql:'INSERT INTO promotion_codes(promotion_id,code,usage_limit) VALUES(?,?,?)',args:[req.params.id,code,limit.value]});res.status(201).json({id:Number(result.lastInsertRowid)});}catch(e){res.status(400).json({error:'Code already exists'});}
});
router.put('/:id/codes/:codeId', requirePermission('promotions'), async (req,res)=>{
  const limit=normalizeUsageLimit(req.body?.usage_limit);if(limit.error)return res.status(400).json({error:limit.error});
  try{const active=req.body?.active===false||req.body?.active===0?0:1;const result=await db.execute({sql:'UPDATE promotion_codes SET usage_limit=?,active=? WHERE id=? AND promotion_id=?',args:[limit.value,active,req.params.codeId,req.params.id]});res.json({success:true,updated:Number(result.rowsAffected||0)});}catch(e){res.status(500).json({error:e.message});}
});
router.delete('/:id/codes/:codeId', requirePermission('promotions'), async (req,res)=>{try{await db.execute({sql:'DELETE FROM promotion_codes WHERE id=? AND promotion_id=?',args:[req.params.codeId,req.params.id]});res.json({success:true});}catch(e){res.status(500).json({error:e.message});}});

// Cart-time promotion endpoints are previews only. Checkout independently
// revalidates catalog prices, scope, dates, limits and discount while holding
// the promotion-code lifecycle lock.
router.post('/auto-apply', requirePermission('pos'), async (req,res)=>{
  try{const {cart_items=[],subtotal=0}=req.body;const today=new Date().toISOString().slice(0,10);const {rows:promos}=await db.execute({sql:`SELECT p.* FROM promotions p WHERE p.active=1 AND (p.start_date IS NULL OR p.start_date<=?) AND (p.end_date IS NULL OR p.end_date>=?) AND (SELECT COUNT(*) FROM promotion_codes WHERE promotion_id=p.id)=0`,args:[today,today]});const scoped=promos.filter(p=>['specific','categories','items'].includes(p.applies_to)).map(p=>p.id);const itemsByPromo={};if(scoped.length){const placeholders=scoped.map(()=>'?').join(',');const {rows}=await db.execute({sql:`SELECT * FROM promotion_items WHERE promotion_id IN (${placeholders})`,args:scoped});for(const item of rows)(itemsByPromo[item.promotion_id] ||= []).push(item);}const results=[];for(const promo of promos){if(Number(promo.min_purchase||0)>Number(subtotal||0))continue;let eligible=Number(subtotal||0);if(['specific','categories','items'].includes(promo.applies_to)){const assigned=itemsByPromo[promo.id]||[];const products=new Set(assigned.filter(x=>x.item_type==='product').map(x=>Number(x.item_id))),categories=new Set(assigned.filter(x=>x.item_type==='category').map(x=>Number(x.item_id)));eligible=cart_items.reduce((sum,ci)=>sum+((promo.applies_to!=='categories'&&products.has(Number(ci.product_id)))||(promo.applies_to!=='items'&&categories.has(Number(ci.category_id)))?Number(ci.price||0)*Number(ci.quantity||0):0),0);if(eligible<=0)continue;}const discount=promo.type==='percentage'?Number((eligible*Number(promo.value||0)/100).toFixed(2)):Number(Math.min(Number(promo.value||0),eligible).toFixed(2));results.push({...promo,discount_amount:discount,preview_only:true});}results.sort((a,b)=>b.discount_amount-a.discount_amount);res.json(results);}catch(e){res.status(500).json({error:e.message});}
});
router.post('/validate-code', requirePermission('pos'), async (req,res)=>{
  try{const code=String(req.body?.code||'').trim();if(!code)return res.status(400).json({error:'Code required'});const subtotal=Number(req.body?.subtotal||0),cart_items=Array.isArray(req.body?.cart_items)?req.body.cart_items:[];const {rows:[pc]}=await db.execute({sql:`SELECT pc.*,p.name promo_name,p.type,p.value,p.min_purchase,p.applies_to,p.start_date,p.end_date,p.active promo_active FROM promotion_codes pc JOIN promotions p ON p.id=pc.promotion_id WHERE pc.code=? COLLATE NOCASE`,args:[code]});if(!pc)return res.status(404).json({error:'Invalid promotion code'});if(!pc.active||!pc.promo_active)return res.status(400).json({error:'This promotion code is inactive'});const today=new Date().toISOString().slice(0,10);if(pc.start_date&&today<pc.start_date)return res.status(400).json({error:'Promotion has not started yet'});if(pc.end_date&&today>pc.end_date)return res.status(400).json({error:'Promotion has expired'});if(pc.usage_limit!=null&&Number(pc.times_used||0)>=Number(pc.usage_limit))return res.status(400).json({error:'This code has reached its usage limit'});if(Number(pc.min_purchase||0)>subtotal)return res.status(400).json({error:`Minimum purchase of ${pc.min_purchase} required`});let eligible=subtotal;if(['specific','categories','items'].includes(pc.applies_to)){const {rows:items}=await db.execute({sql:'SELECT * FROM promotion_items WHERE promotion_id=?',args:[pc.promotion_id]});const products=new Set(items.filter(i=>i.item_type==='product').map(i=>Number(i.item_id))),categories=new Set(items.filter(i=>i.item_type==='category').map(i=>Number(i.item_id)));eligible=cart_items.reduce((sum,ci)=>sum+((pc.applies_to!=='categories'&&products.has(Number(ci.product_id)))||(pc.applies_to!=='items'&&categories.has(Number(ci.category_id)))?Number(ci.price||0)*Number(ci.quantity||0):0),0);if(eligible<=0)return res.status(400).json({error:'No items in cart qualify for this promotion'});}const discount=pc.type==='percentage'?Number((eligible*Number(pc.value||0)/100).toFixed(2)):Number(Math.min(Number(pc.value||0),eligible).toFixed(2));res.json({code_id:pc.id,promotion_id:pc.promotion_id,promo_name:pc.promo_name,type:pc.type,value:pc.value,discount_amount:discount,preview_only:true});}catch(e){res.status(500).json({error:e.message});}
});

// Kept for older clients, but usage is no longer a client-controlled mutation.
// A successful completed transaction increments the matching code atomically
// through the checkout-owned database trigger.
router.post('/use-code', requirePermission('pos'), async (req,res)=>{
  try{const id=Number(req.body?.code_id);if(!id)return res.status(400).json({error:'code_id required'});const {rows:[code]}=await db.execute({sql:'SELECT id,code,times_used FROM promotion_codes WHERE id=?',args:[id]});if(!code)return res.status(404).json({error:'Promotion code not found'});res.json({success:true,accounted_at_checkout:true,code:code.code,times_used:Number(code.times_used||0)});}catch(e){res.status(500).json({error:e.message});}
});

module.exports = router;
module.exports.normalizePromotion=normalizePromotion;
