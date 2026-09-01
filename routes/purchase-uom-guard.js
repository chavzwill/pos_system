'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {ensureUomSchema,resolveProductUom,toBaseQuantity,snapshot}=require('../lib/unit-of-measure');

router.post('/',async(req,res,next)=>{
  try{
    await ensureUomSchema();
    const items=Array.isArray(req.body?.items)?req.body.items:[];
    const evidence=[];
    for(let index=0;index<items.length;index++){
      const item=items[index];
      const productId=Number(item.product_id);if(!productId)continue;
      const enteredQuantity=Number(item.quantity_ordered??item.quantity??1);
      const enteredUnitCost=Number(item.unit_cost||0);
      const resolved=await resolveProductUom(db,productId,item.uom_code||item.unit||null,'purchase');
      const baseQuantity=toBaseQuantity(enteredQuantity,resolved);
      const factor=Number(resolved.factor_to_base);
      const baseUnitCost=enteredUnitCost>0?Number((enteredUnitCost/factor).toFixed(6)):enteredUnitCost;
      evidence.push({index,productId,enteredQuantity,enteredUnitCost,resolved,baseQuantity,baseUnitCost});
      item.entered_quantity=enteredQuantity;item.entered_uom=resolved.uom_code;item.uom_factor_to_base=factor;item.base_uom=resolved.profile.base_uom;
      item.quantity_ordered=baseQuantity;item.quantity=baseQuantity;item.unit_cost=baseUnitCost;
    }
    req.purchaseUomEvidence=evidence;
  }catch(e){return res.status(409).json({error:e.message});}
  const originalJson=res.json.bind(res);let handled=false;
  res.json=function(payload){
    if(handled)return originalJson(payload);handled=true;
    if(res.statusCode>=200&&res.statusCode<300&&payload?.id&&req.purchaseUomEvidence?.length){
      return (async()=>{
        const tx=await db.transaction('write');let committed=false;
        try{
          const responseItems=Array.isArray(payload.items)?payload.items:[];
          for(const e of req.purchaseUomEvidence){
            const line=responseItems[e.index]||responseItems.find(x=>String(x.product_id)===String(e.productId)&&!req.purchaseUomEvidence.some(prior=>prior!==e&&String(prior.sourceLineId||'')===String(x.id)));
            const lineId=line?.id??null;e.sourceLineId=lineId;
            await snapshot(tx,{sourceType:'purchase_order',sourceId:payload.id,sourceLineId:lineId,productId:e.productId,enteredQuantity:e.enteredQuantity,resolved:e.resolved,baseQuantity:e.baseQuantity});
          }
          await tx.commit();committed=true;
          payload.uom_evidence=req.purchaseUomEvidence.map(e=>({source_line_id:e.sourceLineId,product_id:e.productId,entered_quantity:e.enteredQuantity,entered_uom:e.resolved.uom_code,factor_to_base:Number(e.resolved.factor_to_base),base_quantity:e.baseQuantity,base_uom:e.resolved.profile.base_uom,entered_unit_cost:e.enteredUnitCost,base_unit_cost:e.baseUnitCost}));
          return originalJson(payload);
        }catch(err){if(!committed)await tx.rollback();if(!res.headersSent){res.status(500);return originalJson({error:'Purchase order posted but UOM evidence finalization failed; reconciliation required',purchase_order_id:payload.id,detail:err.message});}}
      })();
    }
    return originalJson(payload);
  };
  next();
});
module.exports=router;
