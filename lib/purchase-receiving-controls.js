'use strict';
const { db } = require('../database');
const { can } = require('./permissions');
const { ensureInventoryStockStatus, moveStockStatus } = require('./inventory-stock-status');

let readyPromise=null;
async function ensurePurchaseReceivingControls(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await ensureInventoryStockStatus();
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS product_receiving_controls(
        product_id INTEGER PRIMARY KEY REFERENCES products(id),
        inspection_required INTEGER NOT NULL DEFAULT 0,
        overreceipt_tolerance_pct REAL NOT NULL DEFAULT 0,
        updated_by_employee_id INTEGER REFERENCES employees(id),
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS purchase_receipt_exceptions(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        receipt_id INTEGER REFERENCES purchase_receipts(id),
        receipt_item_id INTEGER REFERENCES purchase_receipt_items(id),
        po_id INTEGER NOT NULL REFERENCES purchase_orders(id),
        po_item_id INTEGER NOT NULL REFERENCES purchase_order_items(id),
        product_id INTEGER REFERENCES products(id),
        exception_type TEXT NOT NULL,
        expected_quantity REAL NOT NULL DEFAULT 0,
        actual_quantity REAL NOT NULL DEFAULT 0,
        variance_quantity REAL NOT NULL DEFAULT 0,
        reason TEXT NOT NULL,
        approved_by_employee_id INTEGER REFERENCES employees(id),
        recorded_by_employee_id INTEGER REFERENCES employees(id),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS purchase_receipt_quality_holds(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        receipt_item_id INTEGER NOT NULL REFERENCES purchase_receipt_items(id),
        product_id INTEGER NOT NULL REFERENCES products(id),
        branch_id INTEGER NOT NULL REFERENCES branches(id),
        quantity REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'inspection',
        reason TEXT NOT NULL,
        created_by_employee_id INTEGER REFERENCES employees(id),
        released_by_employee_id INTEGER REFERENCES employees(id),
        released_at DATETIME,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:'CREATE INDEX IF NOT EXISTS idx_receipt_exceptions_po ON purchase_receipt_exceptions(po_id,po_item_id,created_at)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_receipt_quality_hold_item ON purchase_receipt_quality_holds(receipt_item_id,status)'}
    ],'write');
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}

async function getReceivingControl(executor,productId){
  await ensurePurchaseReceivingControls();
  if(!productId)return {inspection_required:0,overreceipt_tolerance_pct:0};
  const {rows:[row]}=await executor.execute({sql:'SELECT * FROM product_receiving_controls WHERE product_id=?',args:[productId]});
  return row||{product_id:Number(productId),inspection_required:0,overreceipt_tolerance_pct:0};
}

function hasApproval(req){return !!req.apiKey||can(req.employee?.permissions,'purchasing_approve');}

function evaluateReceiptLine({req,item,quantity,control,line}){
  const ordered=Number(item.quantity_ordered||0),already=Number(item.quantity_received||0),remaining=Math.max(0,ordered-already),qty=Number(quantity);
  const tolerance=Math.max(0,Number(control?.overreceipt_tolerance_pct||0));
  const maxWithoutOverride=ordered*(1+tolerance/100)-already;
  const overage=Math.max(0,qty-remaining);
  if(overage>1e-9){
    if(qty-maxWithoutOverride>1e-9&&!hasApproval(req)){
      const e=new Error(`Receiving ${qty} base units of ${item.product_name} exceeds the configured ${tolerance}% over-receipt tolerance and requires purchasing approval`);e.status=403;throw e;
    }
    if(!String(line?.exception_reason||'').trim()){
      const e=new Error(`Over-receipt of ${item.product_name} requires an exception reason`);e.status=400;throw e;
    }
  }
  const closeShort=!!line?.close_short;
  const shortage=closeShort?Math.max(0,remaining-Math.min(qty,remaining)):0;
  if(closeShort&&shortage>1e-9){
    if(!hasApproval(req)){const e=new Error(`Closing a shortage for ${item.product_name} requires purchasing approval`);e.status=403;throw e;}
    if(!String(line?.exception_reason||'').trim()){const e=new Error(`Closing a shortage for ${item.product_name} requires an exception reason`);e.status=400;throw e;}
  }
  const inspectionRequired=!!Number(control?.inspection_required)||String(line?.receiving_status||'').toLowerCase()==='inspection';
  return {ordered,already,remaining,overage,shortage,closeShort,inspectionRequired,tolerance};
}

async function recordReceiptControls(executor,{req,po,receiptId,receiptItemId,item,qty,line,evaluation}){
  const actor=req.employee?.id||null,reason=String(line?.exception_reason||'').trim();
  if(evaluation.overage>1e-9){
    await executor.execute({sql:`INSERT INTO purchase_receipt_exceptions(receipt_id,receipt_item_id,po_id,po_item_id,product_id,exception_type,expected_quantity,actual_quantity,variance_quantity,reason,approved_by_employee_id,recorded_by_employee_id)
      VALUES(?,?,?,?,?,'overage',?,?,?,?,?,?)`,args:[receiptId,receiptItemId,po.id,item.id,item.product_id||null,evaluation.remaining,qty,evaluation.overage,reason,hasApproval(req)?actor:null,actor]});
  }
  if(evaluation.shortage>1e-9){
    await executor.execute({sql:`INSERT INTO purchase_receipt_exceptions(receipt_id,receipt_item_id,po_id,po_item_id,product_id,exception_type,expected_quantity,actual_quantity,variance_quantity,reason,approved_by_employee_id,recorded_by_employee_id)
      VALUES(?,?,?,?,?,'shortage',?,?,?,?,?,?)`,args:[receiptId,receiptItemId,po.id,item.id,item.product_id||null,evaluation.remaining,qty,-evaluation.shortage,reason,actor,actor]});
  }
  if(item.product_id&&evaluation.inspectionRequired){
    const qualityReason=String(line?.inspection_reason||'').trim()||'Receipt held for required incoming inspection';
    await moveStockStatus(executor,{productId:item.product_id,branchId:po.branch_id,fromStatus:'available',toStatus:'inspection',quantity:qty,reason:qualityReason,employeeId:actor,reference:`purchase_receipt_item:${receiptItemId}`});
    await executor.execute({sql:`INSERT INTO purchase_receipt_quality_holds(receipt_item_id,product_id,branch_id,quantity,status,reason,created_by_employee_id) VALUES(?,?,?,?, 'inspection',?,?)`,args:[receiptItemId,item.product_id,po.branch_id,qty,qualityReason,actor]});
  }
}

async function isPoItemClosed(executor,item){
  const ordered=Number(item.quantity_ordered||0),received=Number(item.quantity_received||0);
  if(received>=ordered-1e-9)return true;
  const {rows:[row]}=await executor.execute({sql:`SELECT COALESCE(SUM(ABS(variance_quantity)),0) shortage_closed FROM purchase_receipt_exceptions WHERE po_item_id=? AND exception_type='shortage'`,args:[item.id]});
  return received+Number(row?.shortage_closed||0)>=ordered-1e-9;
}

module.exports={ensurePurchaseReceivingControls,getReceivingControl,evaluateReceiptLine,recordReceiptControls,isPoItemClosed};
