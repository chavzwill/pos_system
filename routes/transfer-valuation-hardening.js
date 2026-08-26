'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requireAuth,requirePermission}=require('../lib/permissions');
const {syncBinQty}=require('../lib/binSync');
const {nextNumber}=require('../lib/nextNumber');
const {ensureInventoryMovementValuation,reserveTransferValuation,receiveTransferValuation,cancelTransferValuation}=require('../lib/inventory-movement-valuation');
router.use(requireAuth);

router.post('/',requirePermission('transfers'),async(req,res)=>{
  try{
    await ensureInventoryMovementValuation();
    const from=Number(req.body?.from_branch_id),to=Number(req.body?.to_branch_id);
    const items=Array.isArray(req.body?.items)?req.body.items:[];
    if(!from||!to||from===to)return res.status(400).json({error:'Two different valid branches are required'});
    if(!items.length)return res.status(400).json({error:'No items in transfer'});
    const normalized=[];
    for(const x of items){const productId=Number(x.product_id),qty=Number(x.quantity);if(!productId||!Number.isInteger(qty)||qty<=0)return res.status(400).json({error:'Every transfer line requires a product and positive whole-number quantity'});normalized.push({product_id:productId,quantity:qty});}
    const tx=await db.transaction('write');let committed=false;
    try{
      const {rows:[fb]}=await tx.execute({sql:'SELECT id FROM branches WHERE id=?',args:[from]});
      const {rows:[tb]}=await tx.execute({sql:'SELECT id FROM branches WHERE id=?',args:[to]});
      if(!fb||!tb)throw new Error('Transfer branch not found');
      const number=await nextNumber(tx,'branch_transfers','transfer_number','TRF-',6);
      const tr=await tx.execute({sql:'INSERT INTO branch_transfers(transfer_number,from_branch_id,to_branch_id,employee_id,notes,quote_id) VALUES(?,?,?,?,?,NULL)',args:[number,from,to,req.employee?.id||null,req.body?.notes||null]});
      const transferId=Number(tr.lastInsertRowid);
      for(const line of normalized){
        const {rows:[p]}=await tx.execute({sql:'SELECT * FROM products WHERE id=? AND active=1',args:[line.product_id]});
        if(!p||p.is_service||p.is_non_inventory)throw new Error(`Product ${line.product_id} is not transferable inventory`);
        const {rows:[src]}=await tx.execute({sql:'SELECT stock_qty,min_stock FROM branch_inventory WHERE product_id=? AND branch_id=?',args:[line.product_id,from]});
        const available=Number(src?.stock_qty||0);if(available<line.quantity)throw new Error(`Insufficient stock for ${p.name} at source branch (${available} available)`);
        await tx.execute({sql:'UPDATE branch_inventory SET stock_qty=stock_qty-?,updated_at=CURRENT_TIMESTAMP WHERE product_id=? AND branch_id=?',args:[line.quantity,line.product_id,from]});
        await syncBinQty(tx,line.product_id,from,-line.quantity);
        await tx.execute({sql:'UPDATE products SET stock_qty=MAX(0,stock_qty-?) WHERE id=?',args:[line.quantity,line.product_id]});
        const ir=await tx.execute({sql:'INSERT INTO branch_transfer_items(transfer_id,product_id,product_name,sku,quantity_requested) VALUES(?,?,?,?,?)',args:[transferId,line.product_id,p.name,p.sku,line.quantity]});
        const transferItemId=Number(ir.lastInsertRowid);
        await reserveTransferValuation(tx,{transferId,transferItemId,productId:line.product_id,fromBranchId:from,toBranchId:to,quantityRequested:line.quantity});
      }
      await tx.commit();committed=true;
      const {rows:[saved]}=await db.execute({sql:'SELECT * FROM branch_transfers WHERE id=?',args:[transferId]});
      const {rows:savedItems}=await db.execute({sql:'SELECT * FROM branch_transfer_items WHERE transfer_id=?',args:[transferId]});
      saved.items=savedItems;res.status(201).json(saved);
    }catch(e){if(!committed)await tx.rollback();res.status(400).json({error:e.message});}
  }catch(e){res.status(500).json({error:e.message});}
});

router.patch('/:id/receive',requirePermission('transfers_dropoff'),async(req,res)=>{
  try{
    await ensureInventoryMovementValuation();
    const {rows:[transfer]}=await db.execute({sql:'SELECT * FROM branch_transfers WHERE id=?',args:[req.params.id]});
    if(!transfer)return res.status(404).json({error:'Transfer not found'});
    if(transfer.status==='cancelled'||transfer.status==='received')return res.status(409).json({error:`Transfer is already ${transfer.status}`});
    const submitted=Array.isArray(req.body?.items)?req.body.items:[];if(!submitted.length)return res.status(400).json({error:'At least one received quantity is required'});
    const tx=await db.transaction('write');let committed=false;
    try{
      for(const s of submitted){
        const id=Number(s.item_id),qty=Number(s.quantity_received);if(!id||!Number.isInteger(qty)||qty<=0)throw new Error('Received quantities must be positive whole numbers');
        const {rows:[item]}=await tx.execute({sql:'SELECT * FROM branch_transfer_items WHERE id=? AND transfer_id=?',args:[id,transfer.id]});
        if(!item)throw new Error(`Transfer item ${id} not found`);
        const pending=Number(item.quantity_requested)-Number(item.quantity_received||0);if(qty>pending)throw new Error(`Received quantity exceeds pending quantity for ${item.product_name} (${pending} remaining)`);
        await tx.execute({sql:'UPDATE branch_transfer_items SET quantity_received=quantity_received+? WHERE id=?',args:[qty,id]});
        await tx.execute({sql:`INSERT INTO branch_inventory(product_id,branch_id,stock_qty,min_stock,updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP)
          ON CONFLICT(product_id,branch_id) DO UPDATE SET stock_qty=stock_qty+?,updated_at=CURRENT_TIMESTAMP`,args:[item.product_id,transfer.to_branch_id,qty,(await tx.execute({sql:'SELECT min_stock FROM products WHERE id=?',args:[item.product_id]})).rows[0]?.min_stock||0,qty]});
        await syncBinQty(tx,item.product_id,transfer.to_branch_id,qty);
        await tx.execute({sql:'UPDATE products SET stock_qty=stock_qty+? WHERE id=?',args:[qty,item.product_id]});
        await receiveTransferValuation(tx,{transferItemId:id,quantity:qty});
      }
      const {rows:all}=await tx.execute({sql:'SELECT * FROM branch_transfer_items WHERE transfer_id=?',args:[transfer.id]});
      const complete=all.every(x=>Number(x.quantity_received||0)>=Number(x.quantity_requested));
      const any=all.some(x=>Number(x.quantity_received||0)>0);
      const status=complete?'received':any?'in_transit':transfer.status;
      await tx.execute({sql:'UPDATE branch_transfers SET status=?,received_at=? WHERE id=?',args:[status,complete?new Date().toISOString():transfer.received_at,transfer.id]});
      await tx.commit();committed=true;
      const {rows:[saved]}=await db.execute({sql:'SELECT * FROM branch_transfers WHERE id=?',args:[transfer.id]});
      const {rows:items}=await db.execute({sql:'SELECT * FROM branch_transfer_items WHERE transfer_id=?',args:[transfer.id]});saved.items=items;res.json(saved);
    }catch(e){if(!committed)await tx.rollback();res.status(400).json({error:e.message});}
  }catch(e){res.status(500).json({error:e.message});}
});

router.patch('/:id/cancel',requirePermission('transfers'),async(req,res)=>{
  try{
    await ensureInventoryMovementValuation();
    const {rows:[transfer]}=await db.execute({sql:'SELECT * FROM branch_transfers WHERE id=?',args:[req.params.id]});
    if(!transfer)return res.status(404).json({error:'Transfer not found'});
    if(transfer.status==='received'||transfer.status==='cancelled')return res.status(409).json({error:`Cannot cancel a ${transfer.status} transfer`});
    const tx=await db.transaction('write');let committed=false;
    try{
      const {rows:items}=await tx.execute({sql:'SELECT * FROM branch_transfer_items WHERE transfer_id=?',args:[transfer.id]});
      for(const item of items){const qty=Number(item.quantity_requested)-Number(item.quantity_received||0);if(qty<=0)continue;
        await tx.execute({sql:`INSERT INTO branch_inventory(product_id,branch_id,stock_qty,min_stock,updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP)
          ON CONFLICT(product_id,branch_id) DO UPDATE SET stock_qty=stock_qty+?,updated_at=CURRENT_TIMESTAMP`,args:[item.product_id,transfer.from_branch_id,qty,(await tx.execute({sql:'SELECT min_stock FROM products WHERE id=?',args:[item.product_id]})).rows[0]?.min_stock||0,qty]});
        await syncBinQty(tx,item.product_id,transfer.from_branch_id,qty);await tx.execute({sql:'UPDATE products SET stock_qty=stock_qty+? WHERE id=?',args:[qty,item.product_id]});
        await cancelTransferValuation(tx,{transferItemId:item.id,quantity:qty});
      }
      await tx.execute({sql:"UPDATE branch_transfers SET status='cancelled' WHERE id=?",args:[transfer.id]});await tx.commit();committed=true;
      const {rows:[saved]}=await db.execute({sql:'SELECT * FROM branch_transfers WHERE id=?',args:[transfer.id]});res.json(saved);
    }catch(e){if(!committed)await tx.rollback();res.status(400).json({error:e.message});}
  }catch(e){res.status(500).json({error:e.message});}
});
module.exports=router;
