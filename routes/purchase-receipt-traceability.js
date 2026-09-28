'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');
const {syncBinQty}=require('../lib/binSync');
const {ensureInventoryTraceability,validateReceiptIdentity,recordReceiptIdentity,getTrackingProfile}=require('../lib/inventory-traceability');
const {ensurePurchaseReceivingControls,getReceivingControl,evaluateReceiptLine,recordReceiptControls,isPoItemClosed}=require('../lib/purchase-receiving-controls');
const {ensureInventoryCostLayers}=require('../lib/inventory-cost-layers');
const {snapshot}=require('../lib/unit-of-measure');
const {normalizeInventoryQuantity}=require('../lib/inventory-quantity-precision');
const {ensureRentalAssetReceiving,registerRentalAssetsFromReceipt}=require('../lib/rental-asset-receiving');

router.use(require('./purchase-receipt-uom-guard'));
router.use('/receiving-controls',require('./purchase-receiving-controls'));
router.use(require('./purchase-order-variation-authority'));

async function ensureColumn(table,column,definition){const {rows}=await db.execute({sql:`PRAGMA table_info(${table})`,args:[]});if(!rows.some(x=>x.name===column))await db.execute({sql:`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`,args:[]})}
async function ensureReceiptEvidence(){
  await ensureInventoryTraceability();await ensurePurchaseReceivingControls();
  await db.batch([
    {sql:`CREATE TABLE IF NOT EXISTS purchase_receipts(id INTEGER PRIMARY KEY AUTOINCREMENT,receipt_number TEXT NOT NULL UNIQUE,po_id INTEGER NOT NULL REFERENCES purchase_orders(id),supplier_id INTEGER REFERENCES suppliers(id),branch_id INTEGER REFERENCES branches(id),received_by_employee_id INTEGER REFERENCES employees(id),received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,total_cost REAL NOT NULL DEFAULT 0)`},
    {sql:`CREATE TABLE IF NOT EXISTS purchase_receipt_items(id INTEGER PRIMARY KEY AUTOINCREMENT,receipt_id INTEGER NOT NULL REFERENCES purchase_receipts(id),po_item_id INTEGER NOT NULL REFERENCES purchase_order_items(id),product_id INTEGER REFERENCES products(id),variation_id INTEGER REFERENCES product_variations(id),product_name TEXT,sku TEXT,quantity_received REAL NOT NULL,unit_cost REAL NOT NULL,line_cost REAL NOT NULL)`},
    {sql:`CREATE TABLE IF NOT EXISTS branch_variation_inventory(product_id INTEGER NOT NULL REFERENCES products(id),variation_id INTEGER NOT NULL REFERENCES product_variations(id),branch_id INTEGER NOT NULL REFERENCES branches(id),stock_qty REAL NOT NULL DEFAULT 0,updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(product_id,variation_id,branch_id))`},
    {sql:'CREATE INDEX IF NOT EXISTS idx_purchase_receipts_po ON purchase_receipts(po_id)'},{sql:'CREATE INDEX IF NOT EXISTS idx_purchase_receipt_items_receipt ON purchase_receipt_items(receipt_id)'},{sql:'CREATE INDEX IF NOT EXISTS idx_branch_variation_inventory_branch ON branch_variation_inventory(branch_id,product_id,variation_id)'}
  ],'write');
  await ensureColumn('purchase_order_items','variation_id','INTEGER REFERENCES product_variations(id)');
  await ensureColumn('purchase_receipt_items','variation_id','INTEGER REFERENCES product_variations(id)');
  await db.execute({sql:'CREATE INDEX IF NOT EXISTS idx_purchase_order_items_variation ON purchase_order_items(product_id,variation_id)',args:[]});
  await ensureInventoryCostLayers();await ensureRentalAssetReceiving();
}
function actor(req){return req.employee?.id||null}
function sameVariation(a,b){return Number(a||0)===Number(b||0)}

router.patch('/:id/items/:itemId/variation',requirePermission('purchasing_receive'),async(req,res)=>{
  try{
    await ensureReceiptEvidence();const poId=Number(req.params.id),itemId=Number(req.params.itemId),variationId=Number(req.body?.variation_id);
    if(!poId||!itemId||!variationId)return res.status(400).json({error:'A valid purchase order item and variation_id are required'});
    const tx=await db.transaction('write');let committed=false;
    try{
      const {rows:[item]}=await tx.execute({sql:'SELECT * FROM purchase_order_items WHERE id=? AND po_id=?',args:[itemId,poId]});
      if(!item)throw Object.assign(new Error('Purchase order item not found'),{status:404});
      if(!item.product_id)throw Object.assign(new Error('The PO line must be linked to a product before a variation can be bound'),{status:409});
      if(Number(item.quantity_received||0)>0)throw Object.assign(new Error('Variation provenance cannot change after receiving has started for this PO line'),{status:409,control:'po_variation_after_receiving'});
      const {rows:[variation]}=await tx.execute({sql:'SELECT id,product_id,active FROM product_variations WHERE id=? AND product_id=?',args:[variationId,item.product_id]});
      if(!variation||Number(variation.active)===0)throw Object.assign(new Error('Selected variation does not belong to the PO line product or is inactive'),{status:409,control:'po_variation_invalid'});
      const changed=await tx.execute({sql:'UPDATE purchase_order_items SET variation_id=? WHERE id=? AND po_id=? AND COALESCE(quantity_received,0)=0',args:[variationId,itemId,poId]});
      if(Number(changed.rowsAffected||0)!==1)throw Object.assign(new Error('Receiving changed this PO line before the variation could be bound'),{status:409,control:'po_variation_receive_race'});
      await tx.commit();committed=true;
      const {rows:[updated]}=await db.execute({sql:'SELECT * FROM purchase_order_items WHERE id=?',args:[itemId]});res.json(updated);
    }catch(e){if(!committed)await tx.rollback();res.status(e.status||400).json({error:e.message,control:e.control})}
  }catch(e){res.status(e.status||500).json({error:e.message,control:e.control})}
});

router.patch('/:id/receive',requirePermission('purchasing_receive'),async(req,res)=>{try{
  await ensureReceiptEvidence();const requested=Array.isArray(req.body?.items)?req.body.items:[];if(!requested.length)return res.status(400).json({error:'At least one received quantity is required'});
  const {rows:[po]}=await db.execute({sql:'SELECT * FROM purchase_orders WHERE id=?',args:[req.params.id]});if(!po)return res.status(404).json({error:'Not found'});if(!['approved','partial'].includes(po.status))return res.status(400).json({error:`PO must be approved before receiving; current status is ${po.status}`});if(!po.branch_id)return res.status(409).json({error:'A receiving branch is required before inventory can be received'});
  const seen=new Set(),validated=[];
  for(const line of requested){
    const itemId=Number(line.item_id);if(!itemId)return res.status(400).json({error:'Each receipt line requires a valid item'});if(seen.has(itemId))return res.status(400).json({error:`PO item ${itemId} appears more than once in this receipt`});seen.add(itemId);
    const {rows:[item]}=await db.execute({sql:'SELECT * FROM purchase_order_items WHERE id=? AND po_id=?',args:[itemId,req.params.id]});if(!item)return res.status(400).json({error:`PO item ${itemId} does not belong to this purchase order`});
    const normalized=item.product_id?await normalizeInventoryQuantity(db,item.product_id,line.quantity_received,{label:`Received quantity for ${item.product_name}`}):{quantity:Number(line.quantity_received),base_uom:'unit'};const qty=normalized.quantity;if(!Number.isFinite(qty)||qty<=0)return res.status(400).json({error:'Each receipt line requires a positive quantity'});
    const unitCost=Number(item.unit_cost||0);if(!Number.isFinite(unitCost)||unitCost<0)return res.status(409).json({error:`Invalid unit cost evidence for ${item.product_name}`});
    if(item.product_id){
      const profile=await getTrackingProfile(db,item.product_id);
      if(profile.tracking_mode!=='none'&&line.variation_id&&Number(line.variation_id)!==Number(item.variation_id||0))return res.status(409).json({error:`${item.product_name} receipt variation must match the variation bound to the purchase-order line`,control:'receipt_variation_authority_mismatch'});
      if(profile.tracking_mode!=='none'&&line.variation_id&&!item.variation_id)return res.status(409).json({error:`Bind variation ${line.variation_id} to the purchase-order line before receiving tracked inventory`,control:'receipt_variation_binding_required'});
    }
    const control=await getReceivingControl(db,item.product_id);const evaluation=evaluateReceiptLine({req,item,quantity:qty,control,line});
    const identity=item.product_id?await validateReceiptIdentity(db,{productId:item.product_id,variationId:item.variation_id||null,branchId:po.branch_id,quantity:qty,line}):null;
    validated.push({item,qty,unitCost,lineCost:Number((qty*unitCost).toFixed(2)),identity,line,evaluation,normalized,startingReceived:Number(item.quantity_received||0)});
  }
  const tx=await db.transaction('write');let committed=false,receiptId=null,receiptNumber=null;const rentalAssetsCreated=[];
  try{
    const {rows:[currentPo]}=await tx.execute({sql:'SELECT status,branch_id FROM purchase_orders WHERE id=?',args:[po.id]});
    if(!currentPo||!['approved','partial'].includes(currentPo.status)||Number(currentPo.branch_id)!==Number(po.branch_id))throw Object.assign(new Error('Purchase order changed before receipt commit'),{status:409,control:'po_receive_stale_header'});
    const receiptTotal=Number(validated.reduce((s,x)=>s+x.lineCost,0).toFixed(2));receiptNumber=`RCV-${po.id}-${Date.now()}`;
    const rr=await tx.execute({sql:`INSERT INTO purchase_receipts(receipt_number,po_id,supplier_id,branch_id,received_by_employee_id,total_cost) VALUES(?,?,?,?,?,?)`,args:[receiptNumber,po.id,po.supplier_id||null,po.branch_id,actor(req),receiptTotal]});receiptId=Number(rr.lastInsertRowid);
    for(const x of validated){
      const {item,qty,unitCost,lineCost,identity,line,evaluation,startingReceived}=x;
      const {rows:[currentItem]}=await tx.execute({sql:'SELECT quantity_received,variation_id,product_id FROM purchase_order_items WHERE id=? AND po_id=?',args:[item.id,po.id]});
      if(!currentItem||Number(currentItem.quantity_received||0)!==startingReceived||!sameVariation(currentItem.variation_id,item.variation_id)||Number(currentItem.product_id||0)!==Number(item.product_id||0))throw Object.assign(new Error(`${item.product_name} changed before receipt commit; reload the PO before receiving`),{status:409,control:'po_receive_stale_line'});
      const pri=await tx.execute({sql:`INSERT INTO purchase_receipt_items(receipt_id,po_item_id,product_id,variation_id,product_name,sku,quantity_received,unit_cost,line_cost) VALUES(?,?,?,?,?,?,?,?,?)`,args:[receiptId,item.id,item.product_id||null,item.variation_id||null,item.product_name||null,item.sku||null,qty,unitCost,lineCost]});const receiptItemId=Number(pri.lastInsertRowid);
      const updatedQty=await tx.execute({sql:'UPDATE purchase_order_items SET quantity_received=quantity_received+? WHERE id=? AND po_id=? AND COALESCE(quantity_received,0)=? AND COALESCE(variation_id,0)=?',args:[qty,item.id,po.id,startingReceived,Number(item.variation_id||0)]});
      if(Number(updatedQty.rowsAffected||0)!==1)throw Object.assign(new Error(`${item.product_name} was received or rebound concurrently; no duplicate receipt was posted`),{status:409,control:'po_receive_cas_conflict'});
      if(item.product_id){
        if(identity){
          await recordReceiptIdentity(tx,{productId:item.product_id,variationId:item.variation_id||null,branchId:po.branch_id,supplierId:po.supplier_id,receiptItemId,unitCost,employeeId:actor(req),identity});
          const created=await registerRentalAssetsFromReceipt(tx,{productId:item.product_id,branchId:po.branch_id,receiptId,receiptNumber,receiptItemId,poId:po.id,supplierId:po.supplier_id,unitCost,employeeId:actor(req),identity});for(const asset of created)rentalAssetsCreated.push({...asset,po_item_id:Number(item.id),receipt_item_id:receiptItemId,product_id:Number(item.product_id)})
        }
        await tx.execute({sql:'UPDATE products SET stock_qty=stock_qty+? WHERE id=?',args:[qty,item.product_id]});if(unitCost>0)await tx.execute({sql:'UPDATE products SET cost=? WHERE id=?',args:[unitCost,item.product_id]});
        if(item.variation_id){
          const variationStock=await tx.execute({sql:'UPDATE product_variations SET stock_qty=COALESCE(stock_qty,0)+?,cost=CASE WHEN ?>0 THEN ? ELSE cost END WHERE id=? AND product_id=?',args:[qty,unitCost,unitCost,item.variation_id,item.product_id]});
          if(Number(variationStock.rowsAffected||0)!==1)throw Object.assign(new Error(`Variation ${item.variation_id} no longer belongs to ${item.product_name}`),{status:409,control:'receipt_variation_stale'});
          await tx.execute({sql:`INSERT INTO branch_variation_inventory(product_id,variation_id,branch_id,stock_qty,updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(product_id,variation_id,branch_id) DO UPDATE SET stock_qty=stock_qty+excluded.stock_qty,updated_at=CURRENT_TIMESTAMP`,args:[item.product_id,item.variation_id,po.branch_id,qty]});
        }
        await tx.execute({sql:`INSERT INTO branch_inventory(product_id,branch_id,stock_qty,min_stock,updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(product_id,branch_id) DO UPDATE SET stock_qty=stock_qty+excluded.stock_qty,updated_at=CURRENT_TIMESTAMP`,args:[item.product_id,po.branch_id,qty,0]});await syncBinQty(tx,item.product_id,po.branch_id,qty);
        await tx.execute({sql:'INSERT INTO stock_movements(product_id,branch_id,quantity_change,type,reference,reason) VALUES(?,?,?,?,?,?)',args:[item.product_id,po.branch_id,qty,'purchase_receive',receiptNumber,`Received against ${po.po_number}${item.variation_id?` / variation ${item.variation_id}`:''}`]});
        const evidence=(req.receiptUomEvidence||[]).find(e=>Number(e.itemId)===Number(item.id));if(evidence)await snapshot(tx,{sourceType:'purchase_receipt',sourceId:receiptId,sourceLineId:receiptItemId,productId:evidence.productId,enteredQuantity:evidence.enteredQuantity,resolved:evidence.resolved,baseQuantity:evidence.baseQuantity});
      }
      await recordReceiptControls(tx,{req,po,receiptId,receiptItemId,item,qty,line,evaluation});
    }
    const {rows:items}=await tx.execute({sql:'SELECT * FROM purchase_order_items WHERE po_id=?',args:[po.id]});const closure=await Promise.all(items.map(i=>isPoItemClosed(tx,i))),allClosed=closure.every(Boolean),newStatus=allClosed?'received':'partial';
    const poChange=await tx.execute({sql:'UPDATE purchase_orders SET status=?,received_at=? WHERE id=? AND status IN (\'approved\',\'partial\')',args:[newStatus,allClosed?new Date().toISOString():po.received_at,po.id]});if(Number(poChange.rowsAffected||0)!==1)throw Object.assign(new Error('Purchase order status changed before receipt commit'),{status:409,control:'po_receive_status_race'});if(allClosed)await tx.execute({sql:`UPDATE purchase_requests SET status='received' WHERE converted_to_po_id=? AND status!='received'`,args:[po.id]});
    await tx.commit();committed=true;
  }catch(e){if(!committed)await tx.rollback();return res.status(e.status||400).json({error:e.message,control:e.control})}
  const {rows:[updated]}=await db.execute({sql:`SELECT po.*,s.name supplier_name,b.name branch_name FROM purchase_orders po LEFT JOIN suppliers s ON s.id=po.supplier_id LEFT JOIN branches b ON b.id=po.branch_id WHERE po.id=?`,args:[po.id]});const {rows:items}=await db.execute({sql:`SELECT poi.*,pv.name variation_name,pv.sku variation_sku FROM purchase_order_items poi LEFT JOIN product_variations pv ON pv.id=poi.variation_id WHERE poi.po_id=? ORDER BY poi.id`,args:[po.id]});updated.items=items;updated.receipt_id=receiptId;updated.receipt_number=receiptNumber;updated.rental_assets_created=rentalAssetsCreated;updated.rental_assets_created_count=rentalAssetsCreated.filter(x=>!x.already_registered).length;res.json(updated);
}catch(e){res.status(e.status||500).json({error:e.message,control:e.control})}});
module.exports=router;
module.exports.ensureReceiptEvidence=ensureReceiptEvidence;
