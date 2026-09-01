'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {ensureUomSchema,resolveProductUom,toBaseQuantity}=require('../lib/unit-of-measure');

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
      const enteredQuantity=Number(line.entered_quantity??line.quantity_received);
      let requestedUom=line.uom_code||line.entered_uom||null;
      if(!requestedUom){
        const {rows:[prior]}=await db.execute({sql:`SELECT entered_uom FROM uom_usage_snapshots WHERE source_type='purchase_order' AND source_id=? AND source_line_id=? ORDER BY id DESC LIMIT 1`,args:[String(req.params.id),String(itemId)]});
        requestedUom=prior?.entered_uom||null;
      }
      const resolved=await resolveProductUom(db,Number(poLine.product_id),requestedUom,'purchase');
      const baseQuantity=toBaseQuantity(enteredQuantity,resolved);
      if(!Number.isFinite(baseQuantity)||baseQuantity<=0)throw new Error('Received quantity must convert to a positive base quantity');
      line.entered_quantity=enteredQuantity;line.entered_uom=resolved.uom_code;line.uom_factor_to_base=Number(resolved.factor_to_base);line.base_uom=resolved.profile.base_uom;line.quantity_received=baseQuantity;
      evidence.push({itemId,productId:Number(poLine.product_id),enteredQuantity,resolved,baseQuantity});
    }
    req.receiptUomEvidence=evidence;
    next();
  }catch(e){return res.status(409).json({error:e.message});}
});

module.exports=router;
