'use strict';
const {db}=require('../database');
const {ensureTransactionCostEvidenceSchema}=require('./transaction-cost-evidence-schema');

let readyPromise=null;
async function ensurePurchaseReceiptBaseSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    // Inventory valuation installs transaction-item cost triggers after these
    // receipt tables exist. Guarantee the shared transaction cost column first
    // so a cold-start from any valuation consumer cannot create an invalid trigger.
    await ensureTransactionCostEvidenceSchema();
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS purchase_receipts(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        receipt_number TEXT NOT NULL UNIQUE,
        po_id INTEGER NOT NULL REFERENCES purchase_orders(id),
        supplier_id INTEGER REFERENCES suppliers(id),
        branch_id INTEGER REFERENCES branches(id),
        received_by_employee_id INTEGER REFERENCES employees(id),
        received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        total_cost REAL NOT NULL DEFAULT 0
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS purchase_receipt_items(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        receipt_id INTEGER NOT NULL REFERENCES purchase_receipts(id),
        po_item_id INTEGER NOT NULL REFERENCES purchase_order_items(id),
        product_id INTEGER REFERENCES products(id),
        product_name TEXT,
        sku TEXT,
        quantity_received REAL NOT NULL,
        unit_cost REAL NOT NULL,
        line_cost REAL NOT NULL
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS landed_cost_allocations(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        allocation_number TEXT NOT NULL UNIQUE,
        supplier_invoice_id INTEGER NOT NULL UNIQUE REFERENCES supplier_invoices(id),
        po_id INTEGER NOT NULL REFERENCES purchase_orders(id),
        branch_id INTEGER REFERENCES branches(id),
        allocation_basis TEXT NOT NULL,
        capitalizable_amount REAL NOT NULL,
        allocated_by_employee_id INTEGER REFERENCES employees(id),
        allocated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        notes TEXT
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS landed_cost_allocation_items(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        allocation_id INTEGER NOT NULL REFERENCES landed_cost_allocations(id),
        purchase_receipt_item_id INTEGER NOT NULL REFERENCES purchase_receipt_items(id),
        receipt_id INTEGER NOT NULL REFERENCES purchase_receipts(id),
        product_id INTEGER NOT NULL REFERENCES products(id),
        quantity_received REAL NOT NULL,
        original_unit_cost REAL NOT NULL,
        original_line_cost REAL NOT NULL,
        basis_value REAL NOT NULL,
        allocated_amount REAL NOT NULL,
        landed_cost_per_unit REAL NOT NULL,
        adjusted_unit_cost REAL NOT NULL,
        UNIQUE(allocation_id,purchase_receipt_item_id)
      )`},
      {sql:'CREATE INDEX IF NOT EXISTS idx_purchase_receipts_po ON purchase_receipts(po_id)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_purchase_receipt_items_receipt ON purchase_receipt_items(receipt_id)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_landed_cost_allocations_po ON landed_cost_allocations(po_id)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_landed_cost_items_allocation ON landed_cost_allocation_items(allocation_id)'}
    ],'write');
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}

module.exports={ensurePurchaseReceiptBaseSchema};
