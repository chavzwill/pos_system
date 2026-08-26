'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');
const {ensureUomSchema,resolveProductUom,resolveSellEconomics,toBaseQuantity,snapshot}=require('../lib/unit-of-measure');

async function normalize(req){
  await ensureUomSchema();
  if(req.body?.quote_type==='rental')return;
  const items=Array.isArray(req.body?.items)?req.body.items:[];
  const evidence=[];
  for(const line of items){
    const productId=Number(line.product_id);if(!productId)continue;
    const {rows:[product]}=await db.execute({sql:'SELECT id,name,sku,price,tax_rate FROM products WHERE id=?',args:[productId]});if(!product)throw new Error(`Product ${productId} not found`);
    const enteredQuantity=Number(line.quantity||1);const resolved=await resolveProductUom(db,productId,line.uom_code||line.unit||null,'sell');
    const baseQuantity=toBaseQuantity(enteredQuantity,resolved);const economics=resolveSellEconomics(product.price,resolved);const factor=Number(resolved.factor_to_base);
    if(Array.isArray(line.sources)&&line.sources.length){
      line.sources=line.sources.map(src=>({...src,quantity:Number((Number(src.quantity||0)*factor).toFixed(6))}));
    }
    line.entered_quantity=enteredQuantity;line.entered_uom=resolved.uom_code;line.uom_factor_to_base=factor;line.base_uom=resolved.profile.base_uom;
    line.uom_entered_unit_price=economics.entered_unit_price;line.uom_base_unit_price=economics.base_unit_price;line.uom_pricing_mode=economics.pricing_mode;
    line.quantity=baseQuantity;line.unit_price=economics.base_unit_price;
    evidence.push({productId,enteredQuantity,resolved,baseQuantity,enteredUnitPrice:economics.entered_unit_price,baseUnitPrice:economics.base_unit_price});
  }
  req.quoteUomEvidence=evidence;
}
async function save(req,payload){
  if(!payload?.id||!req.quoteUomEvidence?.length)return;
  const rows=Array.isArray(payload.items)?payload.items:[];const tx=await db.transaction('write');let committed=false;
  try{
    for(let i=0;i<req.quoteUomEvidence.length;i++){
      const e=req.quoteUomEvidence[i];const match=rows.find(x=>Number(x.product_id)===e.productId&&!req.quoteUomEvidence.slice(0,i).some((prev,j)=>prev.productId===e.productId&&String(rows[j]?.id)===String(x.id)))||rows[i]||null;
      await snapshot(tx,{sourceType:'quotation',sourceId:payload.id,sourceLineId:match?.id||null,productId:e.productId,enteredQuantity:e.enteredQuantity,resolved:e.resolved,baseQuantity:e.baseQuantity,enteredUnitPrice:e.enteredUnitPrice,baseUnitPrice:e.baseUnitPrice});
    }
    await tx.commit();committed=true;
  }catch(e){if(!committed)await tx.rollback();throw e;}
}
function guard(){return async(req,res,next)=>{
  try{await normalize(req);}catch(e){return res.status(409).json({error:e.message});}
  const originalJson=res.json.bind(res);let handled=false;
  res.json=function(payload){
    if(handled)return originalJson(payload);handled=true;
    if(res.statusCode>=200&&res.statusCode<300&&payload?.id&&req.quoteUomEvidence?.length){
      return save(req,payload).then(()=>originalJson(payload)).catch(e=>{if(!res.headersSent){res.status(500);return originalJson({error:'Quotation posted but UOM evidence finalization failed; reconciliation required',quotation_id:payload.id,detail:e.message});}});
    }
    return originalJson(payload);
  };
  next();
};}
router.post('/',requirePermission('quotations'),guard());
router.put('/:id',requirePermission('quotations'),async(req,res,next)=>{
  try{if(req.body?.quote_type==null){const {rows:[q]}=await db.execute({sql:'SELECT quote_type FROM quotations WHERE id=?',args:[req.params.id]});if(q?.quote_type==='rental')return next();}}
  catch(e){return res.status(500).json({error:e.message});}
  return guard()(req,res,next);
});
module.exports=router;
