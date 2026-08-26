'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');
const {ensureInventoryMovementValuation,valueStockAdjustment}=require('../lib/inventory-movement-valuation');
const {getAvailableQty}=require('../lib/inventory-stock-status');

router.patch('/:id/stock',requirePermission('inventory_adjust'),async(req,res)=>{
  try{
    await ensureInventoryMovementValuation();
    const productId=Number(req.params.id);
    const adjustment=Number(req.body?.adjustment);
    const branchId=req.body?.branch_id?Number(req.body.branch_id):0;
    const binId=req.body?.bin_id?Number(req.body.bin_id):null;
    const reason=String(req.body?.reason||'').trim();
    if(!productId||!Number.isInteger(adjustment)||adjustment===0)return res.status(400).json({error:'Stock adjustment must be a non-zero whole number'});
    if(!reason)return res.status(400).json({error:'A stock-adjustment reason is required'});
    const {rows:[product]}=await db.execute({sql:'SELECT * FROM products WHERE id=?',args:[productId]});
    if(!product)return res.status(404).json({error:'Product not found'});
    if(product.is_service||product.is_non_inventory)return res.status(409).json({error:'This item does not support physical stock adjustments'});

    const tx=await db.transaction('write');let committed=false;
    try{
      let currentQty;
      const {rows:branchRows}=await tx.execute({sql:'SELECT * FROM branch_inventory WHERE product_id=?',args:[productId]});
      if(!branchId&&branchRows.length)throw Object.assign(new Error('Select the branch whose physical stock is being adjusted; global stock cannot be edited independently of branch inventory'),{status:409});
      if(branchId){
        const {rows:[branch]}=await tx.execute({sql:'SELECT id FROM branches WHERE id=? AND active=1',args:[branchId]});
        if(!branch)throw Object.assign(new Error('Branch not found'),{status:400});
        const {rows:[existing]}=await tx.execute({sql:'SELECT * FROM branch_inventory WHERE product_id=? AND branch_id=?',args:[productId,branchId]});
        currentQty=Number(existing?.stock_qty||0);
        if(adjustment<0){
          const state=await getAvailableQty(tx,productId,branchId);
          if(state.available<Math.abs(adjustment))throw Object.assign(new Error(`Only ${state.available} unrestricted, unreserved units can be reduced; ${state.restricted} restricted and ${state.reserved||0} reserved units are protected`),{status:409});
        }
        const {rows:bins}=await tx.execute({sql:'SELECT * FROM product_bin_assignments WHERE product_id=? AND branch_id=? ORDER BY is_primary DESC,id',args:[productId,branchId]});
        let selectedBin=null;
        if(bins.length){
          if(binId)selectedBin=bins.find(x=>String(x.bin_id)===String(binId));
          else if(bins.length===1)selectedBin=bins[0];
          else throw Object.assign(new Error('This product is stored in multiple bins; select the exact bin being adjusted'),{status:409});
          if(!selectedBin)throw Object.assign(new Error('Selected bin does not contain this product at the branch'),{status:409});
          if(Number(selectedBin.quantity||0)+adjustment<0)throw Object.assign(new Error(`Adjustment would make the selected bin negative (${Number(selectedBin.quantity||0)} in bin)`),{status:409});
        }else if(binId){
          throw Object.assign(new Error('Selected product is not assigned to that bin'),{status:409});
        }
        const newQty=currentQty+adjustment;
        if(newQty<0)throw Object.assign(new Error(`Adjustment would make branch stock negative (${currentQty} on hand)`),{status:409});
        await tx.execute({sql:`INSERT INTO branch_inventory(product_id,branch_id,stock_qty,min_stock,updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP)
          ON CONFLICT(product_id,branch_id) DO UPDATE SET stock_qty=?,updated_at=CURRENT_TIMESTAMP`,args:[productId,branchId,newQty,existing?.min_stock??product.min_stock,newQty]});
        if(selectedBin)await tx.execute({sql:'UPDATE product_bin_assignments SET quantity=quantity+?,updated_at=CURRENT_TIMESTAMP WHERE id=?',args:[adjustment,selectedBin.id]});
      }else{
        currentQty=Number(product.stock_qty||0);
        if(currentQty+adjustment<0)throw Object.assign(new Error(`Adjustment would make global stock negative (${currentQty} available)`),{status:409});
      }
      const {rows:[sum]}=await tx.execute({sql:'SELECT COALESCE(SUM(stock_qty),0) qty,COUNT(*) rows_count FROM branch_inventory WHERE product_id=?',args:[productId]});
      const newGlobal=branchId?Number(sum?.qty||0):currentQty+adjustment;
      await tx.execute({sql:'UPDATE products SET stock_qty=? WHERE id=?',args:[newGlobal,productId]});
      const mov=await tx.execute({sql:`INSERT INTO stock_movements(product_id,branch_id,quantity_change,type,reason,reference) VALUES(?,?,?,?,?,?)`,args:[productId,branchId||null,adjustment,'adjustment',reason,`ADJ-${Date.now()}`]});
      const movementId=Number(mov.lastInsertRowid);
      await valueStockAdjustment(tx,{stockMovementId:movementId,productId,branchKey:branchId,quantityChange:adjustment,reason,physicalBefore:currentQty});
      await tx.commit();committed=true;
      res.json({stock_qty:branchId?currentQty+adjustment:newGlobal,global_stock_qty:newGlobal,branch_id:branchId||null,bin_id:selectedBin?.bin_id||null,movement_id:movementId});
    }catch(e){if(!committed)await tx.rollback();res.status(e.status||400).json({error:e.message});}
  }catch(e){res.status(500).json({error:e.message});}
});

module.exports=router;
