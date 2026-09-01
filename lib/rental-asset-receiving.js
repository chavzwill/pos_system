'use strict';

const {db}=require('../database');

let readyPromise=null;
async function ensureRentalAssetReceiving(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    // Keep this initializer self-contained because purchase receiving can run
    // before anyone has opened the rental economics endpoints in a process.
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS rental_assets(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_number TEXT NOT NULL UNIQUE,
        product_id INTEGER NOT NULL REFERENCES products(id),
        branch_id INTEGER NOT NULL REFERENCES branches(id),
        serial_id INTEGER REFERENCES inventory_serials(id),
        acquisition_cost REAL NOT NULL,
        acquisition_date DATE NOT NULL,
        acquisition_evidence_ref TEXT NOT NULL,
        acquisition_evidence_grade TEXT NOT NULL DEFAULT 'complete',
        status TEXT NOT NULL DEFAULT 'active',
        disposal_date DATE,
        disposal_value REAL NOT NULL DEFAULT 0,
        disposal_reason TEXT,
        created_by_employee_id INTEGER REFERENCES employees(id),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:'CREATE UNIQUE INDEX IF NOT EXISTS idx_rental_assets_serial ON rental_assets(serial_id) WHERE serial_id IS NOT NULL'},
      {sql:`CREATE TABLE IF NOT EXISTS rental_asset_acquisition_sources(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id INTEGER NOT NULL UNIQUE REFERENCES rental_assets(id),
        purchase_receipt_id INTEGER NOT NULL REFERENCES purchase_receipts(id),
        purchase_receipt_item_id INTEGER NOT NULL REFERENCES purchase_receipt_items(id),
        purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id),
        supplier_id INTEGER REFERENCES suppliers(id),
        serial_id INTEGER NOT NULL REFERENCES inventory_serials(id),
        unit_cost REAL NOT NULL,
        evidence_ref TEXT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(purchase_receipt_item_id,serial_id)
      )`},
      {sql:'CREATE INDEX IF NOT EXISTS idx_rental_asset_acq_receipt ON rental_asset_acquisition_sources(purchase_receipt_id,purchase_receipt_item_id)'}
    ],'write');
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}

function assetNumber(productId,serialId){return `RA-${Number(productId)}-${Number(serialId)}`;}
function acquisitionEvidence({receiptNumber,receiptItemId,serialNumber}){
  return `purchase_receipt:${receiptNumber}:item:${receiptItemId}:serial:${serialNumber}`;
}

async function registerRentalAssetsFromReceipt(executor,{productId,branchId,receiptId,receiptNumber,receiptItemId,poId,supplierId,unitCost,employeeId,identity}){
  if(!productId||!branchId||!receiptId||!receiptItemId)return [];
  if(!identity||String(identity.profile?.tracking_mode)!=='serial'||!Array.isArray(identity.serials)||!identity.serials.length)return [];

  const {rows:[product]}=await executor.execute({sql:'SELECT id,is_rental,active FROM products WHERE id=?',args:[productId]});
  // is_rental is the explicit fleet designation. Ordinary merchandise and
  // rental-capable concepts that are not flagged as rental inventory are not
  // silently converted into fixed rental assets.
  if(!product||!Number(product.active)||!Number(product.is_rental))return [];
  const cost=Number(unitCost);
  if(!Number.isFinite(cost)||cost<0)throw new Error('Rental fleet acquisition requires non-negative receipt unit-cost evidence');

  const {rows:serialRows}=await executor.execute({sql:`SELECT id,serial_number,product_id,branch_id,unit_cost,purchase_receipt_item_id
    FROM inventory_serials WHERE purchase_receipt_item_id=? AND product_id=? AND branch_id=? ORDER BY id`,args:[receiptItemId,productId,branchId]});
  if(serialRows.length!==identity.serials.length)throw new Error(`Rental asset registration expected ${identity.serials.length} received serial identities but found ${serialRows.length}`);

  const created=[];
  for(const serial of serialRows){
    const {rows:[existing]}=await executor.execute({sql:'SELECT id,asset_number FROM rental_assets WHERE serial_id=?',args:[serial.id]});
    if(existing){created.push({id:Number(existing.id),asset_number:existing.asset_number,serial_id:Number(serial.id),serial_number:serial.serial_number,already_registered:true});continue;}
    if(Number(serial.product_id)!==Number(productId)||Number(serial.branch_id)!==Number(branchId))throw new Error(`Received serial ${serial.serial_number} no longer matches the rental product and receiving branch`);
    const evidence=acquisitionEvidence({receiptNumber,receiptItemId,serialNumber:serial.serial_number});
    const number=assetNumber(productId,serial.id);
    const r=await executor.execute({sql:`INSERT INTO rental_assets(asset_number,product_id,branch_id,serial_id,acquisition_cost,acquisition_date,acquisition_evidence_ref,acquisition_evidence_grade,status,created_by_employee_id)
      VALUES(?,?,?,?,?,date('now'),?,'complete','active',?)`,args:[number,productId,branchId,serial.id,cost,evidence,employeeId||null]});
    const assetId=Number(r.lastInsertRowid);
    await executor.execute({sql:`INSERT INTO rental_asset_acquisition_sources(asset_id,purchase_receipt_id,purchase_receipt_item_id,purchase_order_id,supplier_id,serial_id,unit_cost,evidence_ref)
      VALUES(?,?,?,?,?,?,?,?)`,args:[assetId,receiptId,receiptItemId,poId,supplierId||null,serial.id,cost,evidence]});
    created.push({id:assetId,asset_number:number,serial_id:Number(serial.id),serial_number:serial.serial_number,acquisition_cost:cost,evidence_ref:evidence,already_registered:false});
  }
  return created;
}

module.exports={ensureRentalAssetReceiving,registerRentalAssetsFromReceipt};
