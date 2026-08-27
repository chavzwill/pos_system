'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');
const {ensureUomSchema,resolveProductUom,resolveSellEconomics,toBaseQuantity,snapshot}=require('../lib/unit-of-measure');

async function normalize(req){
  await ensureUomSchema();
  const items=Array.isArray(req.body?.items)?req.body.items:[];
  const evidence=[];
  for(const line of items){
    const productId=Number(line.product_id);if(!productId)continue;
    const {rows:[product]}=await db.execute({sql:'SELECT id,name,sku,price,tax_rate FROM products WHERE id=?',args:[productId]});if(!product)throw new Error(`Product ${productId} not found`);
    const enteredQuantity=Number(line.quantity);const resolved=await resolveProductUom(db,productId,line.uom_code||line.unit||null,'sell');
    if(line.variation_id&&Number(resolved.factor_to_base)!==1)throw new Error('Alternate selling units are not supported together with product variations; use the base unit for this variation');
    const baseQuantity=toBaseQuantity(enteredQuantity,resolved);
    const serverBundlePrice=line._bundle_server_price===true?Number(line.uom_base_unit_price):null;
    if(line._bundle_server_price!==undefined&&line._bundle_server_price!==true)throw new Error('Invalid internal bundle price marker');
    if(line._bundle_server_price===true&&(!Number.isFinite(serverBundlePrice)||serverBundlePrice<0))throw new Error('Server-authoritative bundle allocation price is invalid');
    const economics=line._bundle_server_price===true?{entered_unit_price:Number((serverBundlePrice*Number(resolved.factor_to_base||1)).toFixed(6)),base_unit_price:serverBundlePrice,pricing_mode:'virtual_bundle_allocation'}:resolveSellEconomics(product.price,resolved);
    evidence.push({productId,enteredQuantity,resolved,baseQuantity,enteredUnitPrice:economics.entered_unit_price,baseUnitPrice:economics.base_unit_price,line});
    line.entered_quantity=enteredQuantity;line.entered_uom=resolved.uom_code;line.uom_factor_to_base=Number(resolved.factor_to_base);line.base_uom=resolved.profile.base_uom;
    line.uom_entered_unit_price=economics.entered_unit_price;line.uom_base_unit_price=economics.base_unit_price;line.uom_pricing_mode=economics.pricing_mode;
    line.product_name=product.name;line.sku=product.sku||'';line.tax_rate=Number(product.tax_rate||0);line.unit_price=economics.base_unit_price;line.quantity=baseQuantity;
  }
  req.uomEvidence=evidence;
}
async function saveEvidence(req,payload,sourceType){
  if(!payload?.id||!req.uomEvidence?.length)return;
  const savedItems=Array.isArray(payload.items)?payload.items:[];
  const tx=await db.transaction('write');let committed=false;
  try{
    for(let i=0;i<req.uomEvidence.length;i++){
      const e=req.uomEvidence[i],saved=savedItems[i]||null;
      await snapshot(tx,{sourceType,sourceId:payload.id,sourceLineId:saved?.id||null,productId:e.productId,enteredQuantity:e.enteredQuantity,resolved:e.resolved,baseQuantity:e.baseQuantity,enteredUnitPrice:e.enteredUnitPrice,baseUnitPrice:e.baseUnitPrice});
    }
    await tx.commit();committed=true;
  }catch(err){if(!committed)await tx.rollback();throw err;}
}
function guard(sourceType){return async(req,res,next)=>{
  try{await normalize(req);}catch(e){return res.status(409).json({error:e.message});}
  const originalJson=res.json.bind(res);let handled=false;
  res.json=function(payload){
    if(handled)return originalJson(payload);handled=true;
    if(res.statusCode>=200&&res.statusCode<300&&payload?.id){
      return saveEvidence(req,payload,sourceType).then(()=>originalJson(payload)).catch(e=>{if(!res.headersSent){res.status(500);return originalJson({error:'Transaction posted but UOM evidence finalization failed; reconciliation required',transaction_id:payload.id,detail:e.message});}});
    }
    return originalJson(payload);
  };
  next();
};}
router.post('/',requirePermission('pos'),guard('transaction'));
router.post('/hold',requirePermission('pos_hold'),guard('held_transaction'));
module.exports=router;
