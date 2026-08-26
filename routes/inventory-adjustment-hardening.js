'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');
const {syncBinQty}=require('../lib/binSync');
const {ensureInventoryMovementValuation,valueStockAdjustment}=require('../lib/inventory-movement-valuation');

router.patch('/:id/stock',requirePermission('inventory'),async(req,res)=>{
  try{
    await ensureInventoryMovementValuation();
    const productId=Number(req.params.id);
    const adjustment=Number(req.body?.adjustment);
    const branchId=req.body?.branch_id?Number(req.body.branch_id):0;
    const reason=String(req.body?.reason||'').trim();
    if(!productId||!Number.isInteger(adjustment)||adjustment===0)return res.status(400).json({error:'Stock adjustment must be a non-zero whole number'});
    if(!reason)return res.status(400).json({error:'A stock-adjustment reason is required'});
    const {rows:[product]}=await db.execute({sql:'SELECT * FROM products WHERE id=?',args:[productId]});
    if(!product)return res.status(404).json({error:'Product not found'});
    if(product.is_service||product.is_non_inventory)return res.status(409).json({error:'This item does not support physical stock adjustments'});

    const tx=await db.transaction('write');let committed=false;
    try{
      let currentQty;
      if(branchId){
        const {rows:[branch]}=await tx.execute({sql:'SELECT id FROM branches WHERE id=?',args:[branchId]});
        if(!branch)throw new Error('Branch not found');
        const {rows:[existing]}=await tx.execute({sql:'SELECT * FROM branch_inventory WHERE product_id=? AND branch_id=?',args:[productId,branchId]});
        currentQty=Number(existing?.stock_qty||0);
        const newQty=currentQty+adjustment;
        if(newQty<0)throw new Error(`Adjustment would make branch stock negative (${currentQty} available)`);
        await tx.execute({sql:`INSERT INTO branch_inventory(product_id,branch_id,stock_qty,min_stock,updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP)
          ON CONFLICT(product_id,branch_id) DO UPDATE SET stock_qty=?,updated_at=CURRENT_TIMESTAMP`,args:[productId,branchId,newQty,existing?.min_stock??product.min_stock,newQty]});
        await syncBinQty(tx,productId,branchId,adjustment);
      }else{
        currentQty=Number(product.stock_qty||0);
        if(currentQty+adjustment<0)throw new Error(`Adjustment would make global stock negative (${currentQty} available)`);
      }
      const {rows:[sum]}=await tx.execute({sql:'SELECT COALESCE(SUM(stock_qty),0) qty FROM branch_inventory WHERE product_id=?',args:[productId]});
      const hasBranchRows=Number(sum?.qty||0)!==0||branchId>0;
      const newGlobal=branchId&&hasBranchRows?Number(sum?.qty||0):currentQty+adjustment;
      await tx.execute({sql:'UPDATE products SET stock_qty=? WHERE id=?',args:[newGlobal,productId]});
      const mov=await tx.execute({sql:`INSERT INTO stock_movements(product_id,branch_id,quantity_change,type,reason,reference) VALUES(?,?,?,?,?,?)`,args:[productId,branchId||null,adjustment,'adjustment',reason,`ADJ-${Date.now()}`]});
      const movementId=Number(mov.lastInsertRowid);
      await valueStockAdjustment(tx,{stockMovementId:movementId,productId,branchKey:branchId,quantityChange:adjustment,reason,physicalBefore:currentQty});
      await tx.commit();committed=true;
      res.json({stock_qty:branchId?currentQty+adjustment:newGlobal,global_stock_qty:newGlobal,branch_id:branchId||null,movement_id:movementId});
    }catch(e){if(!committed)await tx.rollback();res.status(400).json({error:e.message});}
  }catch(e){res.status(500).json({error:e.message});}
});

module.exports=router;
