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
      const line=items[index],productId=Number(line.product_id);if(!productId)continue;
      const enteredQuantity=Number(line.entered_quantity??line.quantity);
      const resolved=await resolveProductUom(db,productId,line.uom_code||line.entered_uom||null,'movement');
      const baseQuantity=toBaseQuantity(enteredQuantity,resolved);
      evidence.push({index,productId,enteredQuantity,resolved,baseQuantity});
      line.entered_quantity=enteredQuantity;line.entered_uom=resolved.uom_code;line.uom_factor_to_base=Number(resolved.factor_to_base);line.base_uom=resolved.profile.base_uom;line.quantity=baseQuantity;
    }
    req.transferUomEvidence=evidence;
  }catch(e){return res.status(409).json({error:e.message});}
  const originalJson=res.json.bind(res);let handled=false;
  res.json=function(payload){
    if(handled)return originalJson(payload);handled=true;
    if(res.statusCode>=200&&res.statusCode<300&&payload?.id&&req.transferUomEvidence?.length){
      return (async()=>{
        const tx=await db.transaction('write');let committed=false;
        try{
          const responseItems=Array.isArray(payload.items)?payload.items:[];
          for(const e of req.transferUomEvidence){
            const line=responseItems[e.index];const lineId=line?.id??null;e.sourceLineId=lineId;
            await snapshot(tx,{sourceType:'branch_transfer',sourceId:payload.id,sourceLineId:lineId,productId:e.productId,enteredQuantity:e.enteredQuantity,resolved:e.resolved,baseQuantity:e.baseQuantity});
          }
          await tx.commit();committed=true;
          payload.uom_evidence=req.transferUomEvidence.map(e=>({source_line_id:e.sourceLineId,product_id:e.productId,entered_quantity:e.enteredQuantity,entered_uom:e.resolved.uom_code,factor_to_base:Number(e.resolved.factor_to_base),base_quantity:e.baseQuantity,base_uom:e.resolved.profile.base_uom}));
          return originalJson(payload);
        }catch(err){if(!committed)await tx.rollback();if(!res.headersSent){res.status(500);return originalJson({error:'Transfer posted but UOM evidence finalization failed; reconciliation required',transfer_id:payload.id,detail:err.message});}}
      })();
    }
    return originalJson(payload);
  };
  next();
});

module.exports=router;
