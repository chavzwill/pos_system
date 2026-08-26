'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {ensureUomSchema,resolveProductUom,toBaseQuantity,snapshot}=require('../lib/unit-of-measure');

router.patch('/:id/receive',async(req,res,next)=>{
  try{
    await ensureUomSchema();
    const lines=Array.isArray(req.body?.items)?req.body.items:[];
    if(!lines.length)return next();
    const evidence=[];
    for(const line of lines){
      const itemId=Number(line.item_id);if(!itemId)continue;
      const {rows:[poLine]}=await db.execute({sql:'SELECT product_id,quantity_ordered,quantity_received FROM purchase_order_items WHERE id=? AND po_id=?',args:[itemId,req.params.id]});
      if(!poLine||!poLine.product_id)continue;
      let enteredQuantity=Number(line.entered_quantity??line.quantity_received);
      let requestedUom=line.uom_code||line.entered_uom||null;
      if(!requestedUom){
        const {rows:[prior]}=await db.execute({sql:`SELECT entered_uom FROM uom_usage_snapshots WHERE source_type='purchase_order' AND source_id=? AND source_line_id=? ORDER BY id DESC LIMIT 1`,args:[String(req.params.id),String(itemId)]});
        requestedUom=prior?.entered_uom||null;
      }
      const resolved=await resolveProductUom(db,Number(poLine.product_id),requestedUom,'purchase');
      const baseQuantity=toBaseQuantity(enteredQuantity,resolved);
      const remaining=Math.max(0,Number(poLine.quantity_ordered||0)-Number(poLine.quantity_received||0));
      if(baseQuantity-remaining>1e-9)throw new Error(`Receiving ${enteredQuantity} ${resolved.uom_code} converts to ${baseQuantity} ${resolved.profile.base_uom}, but only ${remaining} ${resolved.profile.base_uom} remain open on this PO line`);
      line.entered_quantity=enteredQuantity;line.entered_uom=resolved.uom_code;line.uom_factor_to_base=Number(resolved.factor_to_base);line.base_uom=resolved.profile.base_uom;line.quantity_received=baseQuantity;
      evidence.push({itemId,productId:Number(poLine.product_id),enteredQuantity,resolved,baseQuantity});
    }
    req.receiptUomEvidence=evidence;
  }catch(e){return res.status(409).json({error:e.message});}
  const originalJson=res.json.bind(res);let handled=false;
  res.json=function(payload){
    if(handled)return originalJson(payload);handled=true;
    if(res.statusCode>=200&&res.statusCode<300&&payload?.receipt_id&&req.receiptUomEvidence?.length){
      return (async()=>{
        const tx=await db.transaction('write');let committed=false;
        try{
          for(const e of req.receiptUomEvidence)await snapshot(tx,{sourceType:'purchase_receipt',sourceId:payload.receipt_id,sourceLineId:e.itemId,productId:e.productId,enteredQuantity:e.enteredQuantity,resolved:e.resolved,baseQuantity:e.baseQuantity});
          await tx.commit();committed=true;
          payload.uom_evidence=req.receiptUomEvidence.map(e=>({po_item_id:e.itemId,product_id:e.productId,entered_quantity:e.enteredQuantity,entered_uom:e.resolved.uom_code,factor_to_base:Number(e.resolved.factor_to_base),base_quantity:e.baseQuantity,base_uom:e.resolved.profile.base_uom}));
          return originalJson(payload);
        }catch(err){if(!committed)await tx.rollback();if(!res.headersSent){res.status(500);return originalJson({error:'Receipt posted but UOM evidence finalization failed; reconciliation required',receipt_id:payload.receipt_id,detail:err.message});}}
      })();
    }
    return originalJson(payload);
  };
  next();
});

module.exports=router;
