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
    for(const item of items){
      const productId=Number(item.product_id);if(!productId)continue;
      const enteredQuantity=Number(item.quantity_ordered??item.quantity??1);
      const enteredUnitCost=Number(item.unit_cost||0);
      const resolved=await resolveProductUom(db,productId,item.uom_code||item.unit||null,'purchase');
      const baseQuantity=toBaseQuantity(enteredQuantity,resolved);
      const factor=Number(resolved.factor_to_base);
      const baseUnitCost=enteredUnitCost>0?Number((enteredUnitCost/factor).toFixed(6)):enteredUnitCost;
      evidence.push({productId,enteredQuantity,resolved,baseQuantity});
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
          for(const e of req.purchaseUomEvidence)await snapshot(tx,{sourceType:'purchase_order',sourceId:payload.id,sourceLineId:null,productId:e.productId,enteredQuantity:e.enteredQuantity,resolved:e.resolved,baseQuantity:e.baseQuantity});
          await tx.commit();committed=true;return originalJson(payload);
        }catch(err){if(!committed)await tx.rollback();if(!res.headersSent){res.status(500);return originalJson({error:'Purchase order posted but UOM evidence finalization failed; reconciliation required',purchase_order_id:payload.id,detail:err.message});}}
      })();
    }
    return originalJson(payload);
  };
  next();
});
module.exports=router;
