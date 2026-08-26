'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');
const {syncBinQty}=require('../lib/binSync');
const {ensureInventoryTraceability,validateReceiptIdentity,recordReceiptIdentity}=require('../lib/inventory-traceability');
const {ensurePurchaseReceivingControls,getReceivingControl,evaluateReceiptLine,recordReceiptControls,isPoItemClosed}=require('../lib/purchase-receiving-controls');

router.use(require('./purchase-receipt-uom-guard'));

async function ensureReceiptEvidence(){
  await ensureInventoryTraceability();
  await ensurePurchaseReceivingControls();
  await db.batch([
    {sql:`CREATE TABLE IF NOT EXISTS purchase_receipts(id INTEGER PRIMARY KEY AUTOINCREMENT,receipt_number TEXT NOT NULL UNIQUE,po_id INTEGER NOT NULL REFERENCES purchase_orders(id),supplier_id INTEGER REFERENCES suppliers(id),branch_id INTEGER REFERENCES branches(id),received_by_employee_id INTEGER REFERENCES employees(id),received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,total_cost REAL NOT NULL DEFAULT 0)`},
    {sql:`CREATE TABLE IF NOT EXISTS purchase_receipt_items(id INTEGER PRIMARY KEY AUTOINCREMENT,receipt_id INTEGER NOT NULL REFERENCES purchase_receipts(id),po_item_id INTEGER NOT NULL REFERENCES purchase_order_items(id),product_id INTEGER REFERENCES products(id),product_name TEXT,sku TEXT,quantity_received INTEGER NOT NULL,unit_cost REAL NOT NULL,line_cost REAL NOT NULL)`},
    {sql:'CREATE INDEX IF NOT EXISTS idx_purchase_receipts_po ON purchase_receipts(po_id)'},
    {sql:'CREATE INDEX IF NOT EXISTS idx_purchase_receipt_items_receipt ON purchase_receipt_items(receipt_id)'}
  ],'write');
}
function actor(req){return req.employee?.id||null;}

router.patch('/:id/receive',requirePermission('purchasing_receive'),async(req,res)=>{
  try{
    await ensureReceiptEvidence();
    const requested=Array.isArray(req.body?.items)?req.body.items:[];
    if(!requested.length)return res.status(400).json({error:'At least one received quantity is required'});
    const {rows:[po]}=await db.execute({sql:'SELECT * FROM purchase_orders WHERE id=?',args:[req.params.id]});
    if(!po)return res.status(404).json({error:'Not found'});
    if(!['approved','partial'].includes(po.status))return res.status(400).json({error:`PO must be approved before receiving; current status is ${po.status}`});
    if(!po.branch_id)return res.status(409).json({error:'A receiving branch is required before inventory can be received'});

    const seen=new Set(),validated=[];
    for(const line of requested){
      const itemId=Number(line.item_id),qty=Number(line.quantity_received);
      if(!itemId||!Number.isInteger(qty)||qty<=0)return res.status(400).json({error:'Each receipt line requires an item and positive whole-number base quantity'});
      if(seen.has(itemId))return res.status(400).json({error:`PO item ${itemId} appears more than once in this receipt`});seen.add(itemId);
      const {rows:[item]}=await db.execute({sql:'SELECT * FROM purchase_order_items WHERE id=? AND po_id=?',args:[itemId,req.params.id]});
      if(!item)return res.status(400).json({error:`PO item ${itemId} does not belong to this purchase order`});
      const unitCost=Number(item.unit_cost||0);if(!Number.isFinite(unitCost)||unitCost<0)return res.status(409).json({error:`Invalid unit cost evidence for ${item.product_name}`});
      const control=await getReceivingControl(db,item.product_id);
      const evaluation=evaluateReceiptLine({req,item,quantity:qty,control,line});
      const identity=item.product_id?await validateReceiptIdentity(db,{productId:item.product_id,branchId:po.branch_id,quantity:qty,line}):null;
      validated.push({item,qty,unitCost,lineCost:Number((qty*unitCost).toFixed(2)),identity,line,evaluation});
    }

    const tx=await db.transaction('write');let committed=false,receiptId=null,receiptNumber=null;
    try{
      const receiptTotal=Number(validated.reduce((s,x)=>s+x.lineCost,0).toFixed(2));
      receiptNumber=`RCV-${po.id}-${Date.now()}`;
      const rr=await tx.execute({sql:`INSERT INTO purchase_receipts(receipt_number,po_id,supplier_id,branch_id,received_by_employee_id,total_cost) VALUES(?,?,?,?,?,?)`,args:[receiptNumber,po.id,po.supplier_id||null,po.branch_id,actor(req),receiptTotal]});
      receiptId=Number(rr.lastInsertRowid);
      for(const x of validated){
        const {item,qty,unitCost,lineCost,identity,line,evaluation}=x;
        const pri=await tx.execute({sql:`INSERT INTO purchase_receipt_items(receipt_id,po_item_id,product_id,product_name,sku,quantity_received,unit_cost,line_cost) VALUES(?,?,?,?,?,?,?,?)`,args:[receiptId,item.id,item.product_id||null,item.product_name||null,item.sku||null,qty,unitCost,lineCost]});
        const receiptItemId=Number(pri.lastInsertRowid);
        await tx.execute({sql:'UPDATE purchase_order_items SET quantity_received=quantity_received+? WHERE id=?',args:[qty,item.id]});
        if(item.product_id){
          if(identity)await recordReceiptIdentity(tx,{productId:item.product_id,branchId:po.branch_id,supplierId:po.supplier_id,receiptItemId,unitCost,employeeId:actor(req),identity});
          await tx.execute({sql:'UPDATE products SET stock_qty=stock_qty+? WHERE id=?',args:[qty,item.product_id]});
          if(unitCost>0)await tx.execute({sql:'UPDATE products SET cost=? WHERE id=?',args:[unitCost,item.product_id]});
          await tx.execute({sql:`INSERT INTO branch_inventory(product_id,branch_id,stock_qty,min_stock,updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(product_id,branch_id) DO UPDATE SET stock_qty=stock_qty+excluded.stock_qty,updated_at=CURRENT_TIMESTAMP`,args:[item.product_id,po.branch_id,qty,0]});
          await syncBinQty(tx,item.product_id,po.branch_id,qty);
          await tx.execute({sql:'INSERT INTO stock_movements(product_id,branch_id,quantity_change,type,reference,reason) VALUES(?,?,?,?,?,?)',args:[item.product_id,po.branch_id,qty,'purchase_receive',receiptNumber,`Received against ${po.po_number}`]});
        }
        await recordReceiptControls(tx,{req,po,receiptId,receiptItemId,item,qty,line,evaluation});
      }
      const {rows:items}=await tx.execute({sql:'SELECT * FROM purchase_order_items WHERE po_id=?',args:[po.id]});
      const closure=await Promise.all(items.map(i=>isPoItemClosed(tx,i)));
      const allClosed=closure.every(Boolean);
      const newStatus=allClosed?'received':'partial';
      await tx.execute({sql:'UPDATE purchase_orders SET status=?,received_at=? WHERE id=?',args:[newStatus,allClosed?new Date().toISOString():po.received_at,po.id]});
      if(allClosed)await tx.execute({sql:`UPDATE purchase_requests SET status='received' WHERE converted_to_po_id=? AND status!='received'`,args:[po.id]});
      await tx.commit();committed=true;
    }catch(e){if(!committed)await tx.rollback();return res.status(e.status||400).json({error:e.message});}
    const {rows:[updated]}=await db.execute({sql:`SELECT po.*,s.name supplier_name,b.name branch_name FROM purchase_orders po LEFT JOIN suppliers s ON s.id=po.supplier_id LEFT JOIN branches b ON b.id=po.branch_id WHERE po.id=?`,args:[po.id]});
    const {rows:items}=await db.execute({sql:'SELECT * FROM purchase_order_items WHERE po_id=?',args:[po.id]});
    updated.items=items;updated.receipt_id=receiptId;updated.receipt_number=receiptNumber;res.json(updated);
  }catch(e){res.status(e.status||500).json({error:e.message});}
});

module.exports=router;
