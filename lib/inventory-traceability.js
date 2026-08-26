'use strict';
const { db } = require('../database');

let readyPromise=null;
const MODES=new Set(['none','lot','serial']);

async function ensureInventoryTraceability(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS inventory_tracking_profiles(
        product_id INTEGER PRIMARY KEY REFERENCES products(id),
        tracking_mode TEXT NOT NULL DEFAULT 'none',
        expiry_required INTEGER NOT NULL DEFAULT 0,
        manufacture_date_required INTEGER NOT NULL DEFAULT 0,
        updated_by_employee_id INTEGER REFERENCES employees(id),
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS inventory_lots(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL REFERENCES products(id),
        branch_id INTEGER NOT NULL REFERENCES branches(id),
        bin_id INTEGER REFERENCES storage_bins(id),
        lot_number TEXT NOT NULL,
        manufacture_date TEXT,
        expiry_date TEXT,
        received_quantity INTEGER NOT NULL,
        available_quantity INTEGER NOT NULL,
        unit_cost REAL,
        purchase_receipt_item_id INTEGER REFERENCES purchase_receipt_items(id),
        supplier_id INTEGER REFERENCES suppliers(id),
        status TEXT NOT NULL DEFAULT 'available',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(product_id,branch_id,lot_number,purchase_receipt_item_id)
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS inventory_serials(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL REFERENCES products(id),
        branch_id INTEGER NOT NULL REFERENCES branches(id),
        bin_id INTEGER REFERENCES storage_bins(id),
        serial_number TEXT NOT NULL UNIQUE,
        lot_number TEXT,
        manufacture_date TEXT,
        expiry_date TEXT,
        unit_cost REAL,
        purchase_receipt_item_id INTEGER REFERENCES purchase_receipt_items(id),
        supplier_id INTEGER REFERENCES suppliers(id),
        status TEXT NOT NULL DEFAULT 'available',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS inventory_identity_events(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL REFERENCES products(id),
        branch_id INTEGER REFERENCES branches(id),
        lot_id INTEGER REFERENCES inventory_lots(id),
        serial_id INTEGER REFERENCES inventory_serials(id),
        event_type TEXT NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 1,
        reference_type TEXT,
        reference_id TEXT,
        employee_id INTEGER REFERENCES employees(id),
        details TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:'CREATE INDEX IF NOT EXISTS idx_inventory_lots_product_branch ON inventory_lots(product_id,branch_id,status,expiry_date)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_inventory_serials_product_branch ON inventory_serials(product_id,branch_id,status)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_inventory_identity_events_product ON inventory_identity_events(product_id,branch_id,created_at,id)'}
    ],'write');
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}

async function getTrackingProfile(executor,productId){
  await ensureInventoryTraceability();
  const {rows:[row]}=await executor.execute({sql:'SELECT * FROM inventory_tracking_profiles WHERE product_id=?',args:[productId]});
  return row||{product_id:Number(productId),tracking_mode:'none',expiry_required:0,manufacture_date_required:0};
}

function validDate(value){return !value||/^\d{4}-\d{2}-\d{2}$/.test(String(value));}
function normalizeLot(x){return {lot_number:String(x?.lot_number||'').trim(),quantity:Number(x?.quantity),manufacture_date:x?.manufacture_date||null,expiry_date:x?.expiry_date||null,bin_id:x?.bin_id?Number(x.bin_id):null};}

async function validateReceiptIdentity(executor,{productId,branchId,quantity,line}){
  const profile=await getTrackingProfile(executor,productId);
  if(!MODES.has(profile.tracking_mode))throw new Error(`Invalid tracking mode configured for product ${productId}`);
  if(profile.tracking_mode==='none')return {profile,serials:[],lots:[]};
  if(!branchId)throw new Error('Serial/lot tracked inventory requires a receiving branch');
  if(profile.tracking_mode==='serial'){
    const serials=Array.isArray(line?.serial_numbers)?line.serial_numbers.map(x=>typeof x==='string'?{serial_number:x}:x):[];
    if(serials.length!==quantity)throw new Error(`Serial-tracked receipt requires exactly ${quantity} serial numbers`);
    const normalized=serials.map(x=>({serial_number:String(x?.serial_number||'').trim(),lot_number:String(x?.lot_number||'').trim()||null,manufacture_date:x?.manufacture_date||null,expiry_date:x?.expiry_date||null,bin_id:x?.bin_id?Number(x.bin_id):null}));
    if(normalized.some(x=>!x.serial_number))throw new Error('Serial number cannot be blank');
    if(new Set(normalized.map(x=>x.serial_number.toLowerCase())).size!==normalized.length)throw new Error('Duplicate serial number supplied in the same receipt');
    if(normalized.some(x=>!validDate(x.expiry_date)||!validDate(x.manufacture_date)))throw new Error('Manufacture and expiry dates must use YYYY-MM-DD');
    if(Number(profile.expiry_required)&&normalized.some(x=>!x.expiry_date))throw new Error('Expiry date is required for every serial-controlled unit');
    if(Number(profile.manufacture_date_required)&&normalized.some(x=>!x.manufacture_date))throw new Error('Manufacture date is required for every serial-controlled unit');
    for(const s of normalized){const {rows:[existing]}=await executor.execute({sql:'SELECT id FROM inventory_serials WHERE lower(serial_number)=lower(?)',args:[s.serial_number]});if(existing)throw new Error(`Serial number ${s.serial_number} already exists in inventory history`);}
    return {profile,serials:normalized,lots:[]};
  }
  const lots=Array.isArray(line?.lots)?line.lots.map(normalizeLot):[];
  if(!lots.length)throw new Error('Lot-tracked receipt requires lot allocation');
  if(lots.some(x=>!x.lot_number||!Number.isInteger(x.quantity)||x.quantity<=0))throw new Error('Each lot requires a lot number and positive whole-number quantity');
  if(lots.reduce((s,x)=>s+x.quantity,0)!==quantity)throw new Error(`Lot allocations must total the received quantity of ${quantity}`);
  if(lots.some(x=>!validDate(x.expiry_date)||!validDate(x.manufacture_date)))throw new Error('Manufacture and expiry dates must use YYYY-MM-DD');
  if(Number(profile.expiry_required)&&lots.some(x=>!x.expiry_date))throw new Error('Expiry date is required for every received lot');
  if(Number(profile.manufacture_date_required)&&lots.some(x=>!x.manufacture_date))throw new Error('Manufacture date is required for every received lot');
  return {profile,serials:[],lots};
}

async function recordReceiptIdentity(executor,{productId,branchId,supplierId,receiptItemId,unitCost,employeeId,identity}){
  if(identity.profile.tracking_mode==='serial'){
    for(const s of identity.serials){
      const r=await executor.execute({sql:`INSERT INTO inventory_serials(product_id,branch_id,bin_id,serial_number,lot_number,manufacture_date,expiry_date,unit_cost,purchase_receipt_item_id,supplier_id) VALUES(?,?,?,?,?,?,?,?,?,?)`,args:[productId,branchId,s.bin_id,s.serial_number,s.lot_number,s.manufacture_date,s.expiry_date,unitCost,receiptItemId,supplierId||null]});
      const id=Number(r.lastInsertRowid);
      await executor.execute({sql:`INSERT INTO inventory_identity_events(product_id,branch_id,serial_id,event_type,quantity,reference_type,reference_id,employee_id,details) VALUES(?,?,?,?,?,?,?,?,?)`,args:[productId,branchId,id,'received',1,'purchase_receipt_item',String(receiptItemId),employeeId||null,`Serial ${s.serial_number} received` ]});
    }
  }else if(identity.profile.tracking_mode==='lot'){
    for(const l of identity.lots){
      const r=await executor.execute({sql:`INSERT INTO inventory_lots(product_id,branch_id,bin_id,lot_number,manufacture_date,expiry_date,received_quantity,available_quantity,unit_cost,purchase_receipt_item_id,supplier_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,args:[productId,branchId,l.bin_id,l.lot_number,l.manufacture_date,l.expiry_date,l.quantity,l.quantity,unitCost,receiptItemId,supplierId||null]});
      const id=Number(r.lastInsertRowid);
      await executor.execute({sql:`INSERT INTO inventory_identity_events(product_id,branch_id,lot_id,event_type,quantity,reference_type,reference_id,employee_id,details) VALUES(?,?,?,?,?,?,?,?,?)`,args:[productId,branchId,id,'received',l.quantity,'purchase_receipt_item',String(receiptItemId),employeeId||null,`Lot ${l.lot_number} received` ]});
    }
  }
}

module.exports={MODES,ensureInventoryTraceability,getTrackingProfile,validateReceiptIdentity,recordReceiptIdentity};
