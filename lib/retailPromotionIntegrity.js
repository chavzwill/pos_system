'use strict';
const { db } = require('../database');

let usageReady=null;
const money=v=>Number.parseFloat(v||0);

async function ensureUsageIntegrity(){
  if(usageReady)return usageReady;
  usageReady=db.batch([{sql:`CREATE TRIGGER IF NOT EXISTS trg_transaction_promotion_usage
    AFTER INSERT ON transactions
    WHEN NEW.status='completed' AND NEW.promotion_code IS NOT NULL AND TRIM(NEW.promotion_code)<>''
    BEGIN
      UPDATE promotion_codes SET times_used=COALESCE(times_used,0)+1
      WHERE UPPER(code)=UPPER(NEW.promotion_code);
    END`}],'write').catch(error=>{usageReady=null;throw error;});
  return usageReady;
}

async function lockKeys(req){
  const code=String(req.body?.promotion_code||'').trim();
  if(!code)return [];
  const {rows:[row]}=await db.execute({sql:'SELECT id FROM promotion_codes WHERE code=? COLLATE NOCASE',args:[code]});
  return [`promotion-code:${row?.id||code.toUpperCase()}`];
}

function discountFor(promo,eligible){
  const value=Number(promo.value);
  if(!Number.isFinite(value)||value<0)throw new Error('Promotion value is invalid');
  if(promo.type==='percentage'){
    if(value>100)throw new Error('Promotion percentage cannot exceed 100%');
    return Number((eligible*value/100).toFixed(2));
  }
  if(promo.type==='fixed')return Number(Math.min(value,eligible).toFixed(2));
  throw new Error('Promotion type is invalid');
}

async function validate(body,authoritativeSubtotal,authoritativeLines){
  const code=String(body.promotion_code||'').trim();
  if(!code){
    if(String(body.promotion_name||'').trim())return {error:'Promotion name cannot be supplied without a promotion code'};
    return {discount:money(body.discount_amount),evidence:null};
  }
  const {rows:[promo]}=await db.execute({sql:`SELECT pc.id code_id,pc.code,pc.active code_active,pc.usage_limit,pc.times_used,
      p.id promotion_id,p.name,p.type,p.value,p.min_purchase,p.applies_to,p.start_date,p.end_date,p.active promotion_active
    FROM promotion_codes pc JOIN promotions p ON p.id=pc.promotion_id WHERE pc.code=? COLLATE NOCASE`,args:[code]});
  if(!promo)return {error:'Promotion code is invalid or no longer exists'};
  if(!promo.code_active||!promo.promotion_active)return {error:'Promotion code is inactive'};
  const today=new Date().toISOString().slice(0,10);
  if(promo.start_date&&today<promo.start_date)return {error:'Promotion has not started yet'};
  if(promo.end_date&&today>promo.end_date)return {error:'Promotion has expired'};
  if(promo.usage_limit!=null&&Number(promo.times_used||0)>=Number(promo.usage_limit))return {error:'Promotion code has reached its usage limit'};
  if(Number(promo.min_purchase||0)>authoritativeSubtotal+0.001)return {error:`Promotion requires a minimum merchandise subtotal of ${Number(promo.min_purchase).toFixed(2)}`};
  let eligible=authoritativeSubtotal;
  if(['specific','categories','items'].includes(String(promo.applies_to||''))){
    const {rows:assignments}=await db.execute({sql:'SELECT item_type,item_id FROM promotion_items WHERE promotion_id=?',args:[promo.promotion_id]});
    const products=new Set(assignments.filter(x=>x.item_type==='product').map(x=>Number(x.item_id)));
    const categories=new Set(assignments.filter(x=>x.item_type==='category').map(x=>Number(x.item_id)));
    eligible=authoritativeLines.reduce((sum,line)=>{
      const productMatch=promo.applies_to!=='categories'&&products.has(Number(line.product_id));
      const categoryMatch=promo.applies_to!=='items'&&categories.has(Number(line.category_id));
      return sum+(productMatch||categoryMatch?Number(line.lineTotal):0);
    },0);
    eligible=Number(eligible.toFixed(2));
    if(eligible<=0)return {error:'No item in the current cart qualifies for this promotion'};
  }
  let authoritativeDiscount;
  try{authoritativeDiscount=discountFor(promo,eligible);}catch(error){return {error:error.message};}
  const requested=money(body.discount_amount);
  if(!Number.isFinite(requested)||Math.abs(requested-authoritativeDiscount)>0.01)return {error:`Promotion pricing changed. Expected discount ${authoritativeDiscount.toFixed(2)}; refresh the promotion before completing the sale.`};
  body.promotion_code=String(promo.code).trim().toUpperCase();
  body.promotion_name=promo.name;
  body.discount_amount=authoritativeDiscount;
  return {discount:authoritativeDiscount,evidence:{code_id:Number(promo.code_id),promotion_id:Number(promo.promotion_id),code:body.promotion_code,name:promo.name,eligible_amount:eligible,discount_amount:authoritativeDiscount,usage_before:Number(promo.times_used||0),usage_limit:promo.usage_limit==null?null:Number(promo.usage_limit),validated_at:new Date().toISOString()}};
}

async function authoritativeCart(body){
  const items=Array.isArray(body?.items)?body.items:[];
  let subtotal=0;const lines=[];
  for(const line of items){
    const qty=Number(line.quantity);if(!Number.isInteger(qty)||qty<=0)throw new Error('Sale quantities must be positive whole numbers after UOM conversion');
    const {rows:[product]}=await db.execute({sql:'SELECT id,category_id,name,price,active,is_service,is_rental FROM products WHERE id=?',args:[line.product_id]});
    if(!product||!product.active)throw new Error(`Product ${line.product_id} is unavailable`);
    if(product.is_service||product.is_rental)throw new Error(`${product.name} cannot be sold through standard retail checkout`);
    let unitPrice=line.uom_base_unit_price!=null?Number(line.uom_base_unit_price):Number(product.price||0);
    if(line.variation_id){const {rows:[variation]}=await db.execute({sql:'SELECT price,price_modifier FROM product_variations WHERE id=? AND product_id=?',args:[line.variation_id,line.product_id]});if(!variation)throw new Error(`Variation ${line.variation_id} is unavailable`);unitPrice=variation.price!=null?Number(variation.price):Number(product.price||0)+Number(variation.price_modifier||0);}
    if(!Number.isFinite(unitPrice)||unitPrice<0)throw new Error(`Authoritative selling price is invalid for ${product.name}`);
    const lineTotal=Number((unitPrice*qty).toFixed(2));subtotal+=lineTotal;lines.push({product_id:product.id,category_id:product.category_id,quantity:qty,unit_price:unitPrice,lineTotal});
  }
  return {subtotal:Number(subtotal.toFixed(2)),lines};
}

module.exports={ensureUsageIntegrity,lockKeys,validate,authoritativeCart,discountFor};
