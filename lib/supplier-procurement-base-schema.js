'use strict';
const {db}=require('../database');

let readyPromise=null;

async function ensureSupplierProcurementBaseSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=db.batch([
    {sql:`CREATE TABLE IF NOT EXISTS supplier_product_offers(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      supplier_sku TEXT,
      purchase_uom TEXT NOT NULL DEFAULT 'EA',
      units_per_purchase_uom REAL NOT NULL DEFAULT 1,
      unit_cost_per_purchase_uom REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'JMD',
      minimum_order_qty REAL NOT NULL DEFAULT 1,
      order_multiple REAL NOT NULL DEFAULT 1,
      lead_time_days INTEGER,
      freight_per_order REAL NOT NULL DEFAULT 0,
      freight_per_purchase_uom REAL NOT NULL DEFAULT 0,
      duty_rate REAL NOT NULL DEFAULT 0,
      availability_qty REAL,
      valid_from TEXT,
      valid_until TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      updated_by_employee_id INTEGER REFERENCES employees(id),
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(supplier_id,product_id,supplier_sku)
    )`},
    {sql:`CREATE TABLE IF NOT EXISTS supplier_price_breaks(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      offer_id INTEGER NOT NULL REFERENCES supplier_product_offers(id) ON DELETE CASCADE,
      min_purchase_qty REAL NOT NULL,
      unit_cost_per_purchase_uom REAL NOT NULL,
      UNIQUE(offer_id,min_purchase_qty)
    )`},
    {sql:'CREATE INDEX IF NOT EXISTS idx_supplier_offers_product ON supplier_product_offers(product_id,active,supplier_id)'},
    {sql:'CREATE INDEX IF NOT EXISTS idx_supplier_breaks_offer ON supplier_price_breaks(offer_id,min_purchase_qty)'}
  ],'write').catch(error=>{readyPromise=null;throw error;});
  return readyPromise;
}

module.exports={ensureSupplierProcurementBaseSchema};
