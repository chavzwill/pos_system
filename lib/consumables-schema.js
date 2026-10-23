'use strict';
const {db}=require('../database');
const {ensureApprovalRoutingSchema}=require('./approval-routing');
let ready=null;
async function ensureConsumablesSchema(){
 if(ready)return ready;
 ready=(async()=>{
  await ensureApprovalRoutingSchema();
  const statements=[
   "CREATE TABLE IF NOT EXISTS consumable_catalog(id INTEGER PRIMARY KEY AUTOINCREMENT,sku TEXT NOT NULL UNIQUE,name TEXT NOT NULL,uom TEXT NOT NULL DEFAULT 'each',active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,CHECK(active IN(0,1)))",
   "CREATE TABLE IF NOT EXISTS consumable_purchase_orders(id INTEGER PRIMARY KEY AUTOINCREMENT,po_number TEXT NOT NULL UNIQUE,supplier_id INTEGER NOT NULL REFERENCES suppliers(id),branch_id INTEGER NOT NULL REFERENCES branches(id),requested_by INTEGER REFERENCES employees(id),approved_by INTEGER REFERENCES employees(id),status TEXT NOT NULL DEFAULT 'draft',reason TEXT NOT NULL,requested_for TEXT NOT NULL,allocation_type TEXT NOT NULL DEFAULT 'branch',allocation_id INTEGER,unit_reference TEXT,notes TEXT,expected_date TEXT,total_cents INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,approved_at TEXT,received_at TEXT,CHECK(status IN('draft','submitted','approved','partial','received','cancelled')),CHECK(allocation_type IN('branch','department','rental')),CHECK(total_cents>=0))",
   "CREATE TABLE IF NOT EXISTS consumable_po_lines(id INTEGER PRIMARY KEY AUTOINCREMENT,po_id INTEGER NOT NULL REFERENCES consumable_purchase_orders(id),consumable_id INTEGER NOT NULL REFERENCES consumable_catalog(id),quantity_ordered INTEGER NOT NULL,quantity_received INTEGER NOT NULL DEFAULT 0,unit_cost_cents INTEGER NOT NULL,CHECK(quantity_ordered>0),CHECK(quantity_received>=0 AND quantity_received<=quantity_ordered),CHECK(unit_cost_cents>=0))",
   "CREATE TABLE IF NOT EXISTS consumable_balances(consumable_id INTEGER NOT NULL REFERENCES consumable_catalog(id),branch_id INTEGER NOT NULL REFERENCES branches(id),qty_on_hand INTEGER NOT NULL DEFAULT 0,value_cents INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(consumable_id,branch_id),CHECK(qty_on_hand>=0),CHECK(value_cents>=0))",
   "CREATE TABLE IF NOT EXISTS consumable_movements(id INTEGER PRIMARY KEY AUTOINCREMENT,consumable_id INTEGER NOT NULL REFERENCES consumable_catalog(id),branch_id INTEGER NOT NULL REFERENCES branches(id),action TEXT NOT NULL CHECK(action IN('receive','issue')),quantity INTEGER NOT NULL CHECK(quantity>0),value_cents INTEGER NOT NULL CHECK(value_cents>=0),po_id INTEGER REFERENCES consumable_purchase_orders(id),po_line_id INTEGER REFERENCES consumable_po_lines(id),department_id INTEGER REFERENCES departments(id),rental_product_id INTEGER REFERENCES products(id),rental_unit_reference TEXT,purpose TEXT,actor_employee_id INTEGER REFERENCES employees(id),created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
   "CREATE TABLE IF NOT EXISTS consumable_order_events(id INTEGER PRIMARY KEY AUTOINCREMENT,po_id INTEGER NOT NULL REFERENCES consumable_purchase_orders(id),event_type TEXT NOT NULL,actor_employee_id INTEGER REFERENCES employees(id),details TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
   "CREATE TABLE IF NOT EXISTS consumable_operations(idempotency_key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,response_json TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
   "CREATE TRIGGER IF NOT EXISTS trg_consumable_movements_no_update BEFORE UPDATE ON consumable_movements BEGIN SELECT RAISE(ABORT,'Consumable movements are append-only'); END",
   "CREATE TRIGGER IF NOT EXISTS trg_consumable_movements_no_delete BEFORE DELETE ON consumable_movements BEGIN SELECT RAISE(ABORT,'Consumable movements cannot be deleted'); END",
   "CREATE TRIGGER IF NOT EXISTS trg_consumable_order_events_no_update BEFORE UPDATE ON consumable_order_events BEGIN SELECT RAISE(ABORT,'Consumable approval events are append-only'); END",
   "CREATE TRIGGER IF NOT EXISTS trg_consumable_order_events_no_delete BEFORE DELETE ON consumable_order_events BEGIN SELECT RAISE(ABORT,'Consumable approval events cannot be deleted'); END",
   "CREATE INDEX IF NOT EXISTS idx_consumable_po_lines_po ON consumable_po_lines(po_id)",
   "CREATE INDEX IF NOT EXISTS idx_consumable_po_supplier ON consumable_purchase_orders(supplier_id,created_at)",
   "CREATE INDEX IF NOT EXISTS idx_consumable_movement_target ON consumable_movements(branch_id,department_id,rental_product_id,created_at)",
   "CREATE INDEX IF NOT EXISTS idx_consumable_movement_item ON consumable_movements(consumable_id,created_at)"
  ];
  await db.batch(statements.map(sql=>({sql,args:[]})));
 })().catch(e=>{ready=null;throw e;});
 return ready;
}
module.exports={ensureConsumablesSchema};
