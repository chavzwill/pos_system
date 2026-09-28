'use strict';
const { db } = require('../database');
const { randomUUID } = require('crypto');

let ready=false;
async function ensureSupplierRecoverablesSchema(){
  if(ready)return;
  await db.batch([
    {sql:`CREATE TABLE IF NOT EXISTS supplier_recoverable_claims(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      claim_number TEXT NOT NULL UNIQUE,
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
      branch_id INTEGER REFERENCES branches(id),
      claim_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'identified',
      source_type TEXT,
      source_id TEXT,
      source_reference TEXT,
      currency TEXT,
      identified_amount REAL NOT NULL DEFAULT 0,
      confirmed_amount REAL NOT NULL DEFAULT 0,
      recovered_amount REAL NOT NULL DEFAULT 0,
      obligation_date TEXT NOT NULL,
      due_date TEXT,
      supplier_document_number TEXT,
      owner_employee_id INTEGER REFERENCES employees(id),
      notes TEXT,
      evidence_json TEXT NOT NULL DEFAULT '{}',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      confirmed_at DATETIME,
      recovered_at DATETIME,
      UNIQUE(claim_type,source_type,source_id)
    )`},
    {sql:`CREATE TABLE IF NOT EXISTS supplier_recoverable_accounting_basis(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      claim_id INTEGER NOT NULL UNIQUE REFERENCES supplier_recoverable_claims(id),
      basis_type TEXT NOT NULL,
      recognized_amount REAL NOT NULL,
      source_invoice_id INTEGER REFERENCES supplier_invoices(id),
      evidence_json TEXT NOT NULL DEFAULT '{}',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`},
    {sql:`CREATE TABLE IF NOT EXISTS supplier_recoverable_ap_allocations(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      settlement_id INTEGER NOT NULL UNIQUE REFERENCES supplier_recoverable_settlements(id),
      claim_id INTEGER NOT NULL REFERENCES supplier_recoverable_claims(id),
      supplier_invoice_id INTEGER NOT NULL REFERENCES supplier_invoices(id),
      amount REAL NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(claim_id,supplier_invoice_id,settlement_id)
    )`},
    {sql:`CREATE TABLE IF NOT EXISTS supplier_recoverable_settlements(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      claim_id INTEGER NOT NULL REFERENCES supplier_recoverable_claims(id),
      settlement_type TEXT NOT NULL,
      amount REAL NOT NULL,
      reference TEXT,
      settlement_date TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '{}',
      recorded_by_employee_id INTEGER REFERENCES employees(id),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`},
    {sql:'CREATE INDEX IF NOT EXISTS idx_supplier_recoverable_status ON supplier_recoverable_claims(status,due_date,supplier_id)'},
    {sql:'CREATE INDEX IF NOT EXISTS idx_supplier_recoverable_supplier ON supplier_recoverable_claims(supplier_id,obligation_date)'},
    {sql:'CREATE INDEX IF NOT EXISTS idx_supplier_recoverable_settlement_claim ON supplier_recoverable_settlements(claim_id,settlement_date)'}
  ],'write');
  ready=true;
}
function money(v){const n=Number(v);return Number.isFinite(n)?Number(n.toFixed(2)):NaN;}
async function nextClaimNumber(){
  return 'SRC-'+randomUUID().replaceAll('-','').slice(0,12).toUpperCase();
}
async function createShortageClaim(conn,{po,ownerEmployeeId,reason}){
  const {rows:items}=await conn.execute({sql:`SELECT id,product_name,sku,quantity_ordered,quantity_received,unit_cost
    FROM purchase_order_items WHERE po_id=? ORDER BY id`,args:[po.id]});
  const missing=items.map(x=>{
    const qty=Math.max(0,Number(x.quantity_ordered||0)-Number(x.quantity_received||0));
    return {...x,missing_quantity:qty,missing_value:money(qty*Number(x.unit_cost||0))};
  }).filter(x=>x.missing_quantity>0);
  if(!missing.length)return null;
  const identified=money(missing.reduce((s,x)=>s+Number(x.missing_value||0),0));
  const {rows:[existing]}=await conn.execute({sql:`SELECT * FROM supplier_recoverable_claims
    WHERE claim_type='shorted_goods' AND source_type='purchase_order' AND source_id=?`,args:[String(po.id)]});
  if(existing)return existing;
  const {rows:[branch]}=po.branch_id?await conn.execute({sql:'SELECT currency FROM branches WHERE id=?',args:[po.branch_id]}):{rows:[]};
  const number=await nextClaimNumber(conn);
  const evidence={poNumber:po.po_number,reason,missingLines:missing.map(x=>({poItemId:x.id,productName:x.product_name,sku:x.sku,missingQuantity:x.missing_quantity,unitCost:Number(x.unit_cost||0),missingValue:x.missing_value}))};
  const r=await conn.execute({sql:`INSERT INTO supplier_recoverable_claims(
    claim_number,supplier_id,branch_id,claim_type,status,source_type,source_id,source_reference,currency,
    identified_amount,obligation_date,owner_employee_id,notes,evidence_json
  ) VALUES(?,?,?,?,?,?,?,?,?,? ,?,?,?,?)`,args:[
    number,po.supplier_id,po.branch_id||null,'shorted_goods','identified','purchase_order',String(po.id),po.po_number||null,
    branch?.currency||null,identified,new Date().toISOString(),ownerEmployeeId||null,reason||null,JSON.stringify(evidence)
  ]});
  const {rows:[claim]}=await conn.execute({sql:'SELECT * FROM supplier_recoverable_claims WHERE id=?',args:[Number(r.lastInsertRowid)]});
  return claim;
}
module.exports={ensureSupplierRecoverablesSchema,createShortageClaim,money,nextClaimNumber};
