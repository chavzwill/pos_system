'use strict';
const {db}=require('../database');

let schemaReady=null;
let lastTriggerSweep=0;
const TRIGGER_SWEEP_MS=30000;

async function tableExists(name){
  const {rows:[row]}=await db.execute({sql:"SELECT name FROM sqlite_master WHERE type='table' AND name=?",args:[name]});
  return !!row;
}

async function ensureCoreSchema(){
  if(schemaReady)return schemaReady;
  schemaReady=(async()=>{
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS branch_variation_inventory(
        product_id INTEGER NOT NULL REFERENCES products(id),
        variation_id INTEGER NOT NULL REFERENCES product_variations(id),
        branch_id INTEGER NOT NULL REFERENCES branches(id),
        stock_qty REAL NOT NULL DEFAULT 0,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(product_id,variation_id,branch_id)
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS branch_variation_inventory_events(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL REFERENCES products(id),
        variation_id INTEGER NOT NULL REFERENCES product_variations(id),
        branch_id INTEGER NOT NULL REFERENCES branches(id),
        event_type TEXT NOT NULL,
        quantity_change REAL NOT NULL,
        resulting_qty REAL,
        reference_type TEXT,
        reference_id TEXT,
        employee_id INTEGER REFERENCES employees(id),
        reason TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS branch_variation_migrations(
        product_id INTEGER NOT NULL REFERENCES products(id),
        branch_id INTEGER NOT NULL REFERENCES branches(id),
        status TEXT NOT NULL DEFAULT 'counted' CHECK(status IN ('counted','finalized')),
        baseline_total REAL NOT NULL,
        counted_by_employee_id INTEGER REFERENCES employees(id),
        counted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        finalized_at DATETIME,
        reason TEXT NOT NULL,
        PRIMARY KEY(product_id,branch_id)
      )`},
      {sql:'CREATE INDEX IF NOT EXISTS idx_branch_variation_inventory_branch ON branch_variation_inventory(branch_id,product_id,variation_id)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_branch_variation_events_lookup ON branch_variation_inventory_events(product_id,branch_id,variation_id,created_at,id)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_branch_variation_migration_status ON branch_variation_migrations(product_id,status,branch_id)'}
    ],'write');
  })().catch(error=>{schemaReady=null;throw error;});
  return schemaReady;
}

async function ensureTriggers(){
  await ensureCoreSchema();
  if(Date.now()-lastTriggerSweep<TRIGGER_SWEEP_MS)return;
  lastTriggerSweep=Date.now();
  if(await tableExists('transaction_items')){
    await db.batch([
      {sql:`CREATE TRIGGER IF NOT EXISTS trg_branch_variation_sale_guard
        BEFORE INSERT ON transaction_items
        WHEN NEW.variation_id IS NOT NULL
          AND EXISTS(SELECT 1 FROM transactions t WHERE t.id=NEW.transaction_id AND t.status='completed' AND t.branch_id IS NOT NULL)
          AND EXISTS(SELECT 1 FROM transactions t JOIN branch_variation_migrations m ON m.product_id=NEW.product_id AND m.branch_id=t.branch_id WHERE t.id=NEW.transaction_id)
        BEGIN
          SELECT CASE WHEN COALESCE((SELECT bvi.stock_qty FROM branch_variation_inventory bvi JOIN transactions t ON t.id=NEW.transaction_id WHERE bvi.product_id=NEW.product_id AND bvi.variation_id=NEW.variation_id AND bvi.branch_id=t.branch_id),0) < NEW.quantity
            THEN RAISE(ABORT,'Insufficient exact variation stock at this branch') END;
        END`},
      {sql:`CREATE TRIGGER IF NOT EXISTS trg_branch_variation_sale
        AFTER INSERT ON transaction_items
        WHEN NEW.variation_id IS NOT NULL
          AND EXISTS(SELECT 1 FROM transactions t WHERE t.id=NEW.transaction_id AND t.status='completed' AND t.branch_id IS NOT NULL)
          AND EXISTS(SELECT 1 FROM transactions t JOIN branch_variation_migrations m ON m.product_id=NEW.product_id AND m.branch_id=t.branch_id WHERE t.id=NEW.transaction_id)
        BEGIN
          UPDATE branch_variation_inventory SET stock_qty=stock_qty-NEW.quantity,updated_at=CURRENT_TIMESTAMP
            WHERE product_id=NEW.product_id AND variation_id=NEW.variation_id AND branch_id=(SELECT branch_id FROM transactions WHERE id=NEW.transaction_id);
          INSERT INTO branch_variation_inventory_events(product_id,variation_id,branch_id,event_type,quantity_change,resulting_qty,reference_type,reference_id,employee_id,reason)
            SELECT NEW.product_id,NEW.variation_id,t.branch_id,'sale',-NEW.quantity,b.stock_qty,'transaction',CAST(NEW.transaction_id AS TEXT),t.employee_id,'Exact variation sold through POS'
            FROM transactions t JOIN branch_variation_inventory b ON b.product_id=NEW.product_id AND b.variation_id=NEW.variation_id AND b.branch_id=t.branch_id WHERE t.id=NEW.transaction_id;
        END`},
      {sql:`CREATE TRIGGER IF NOT EXISTS trg_branch_variation_void
        AFTER UPDATE OF status ON transactions
        WHEN OLD.status='completed' AND NEW.status='voided' AND NEW.branch_id IS NOT NULL
        BEGIN
          UPDATE branch_variation_inventory
            SET stock_qty=stock_qty+COALESCE((SELECT SUM(ti.quantity) FROM transaction_items ti WHERE ti.transaction_id=NEW.id AND ti.product_id=branch_variation_inventory.product_id AND ti.variation_id=branch_variation_inventory.variation_id),0),updated_at=CURRENT_TIMESTAMP
            WHERE branch_id=NEW.branch_id AND EXISTS(SELECT 1 FROM branch_variation_migrations m WHERE m.product_id=branch_variation_inventory.product_id AND m.branch_id=NEW.branch_id)
              AND EXISTS(SELECT 1 FROM transaction_items ti WHERE ti.transaction_id=NEW.id AND ti.product_id=branch_variation_inventory.product_id AND ti.variation_id=branch_variation_inventory.variation_id);
          INSERT INTO branch_variation_inventory_events(product_id,variation_id,branch_id,event_type,quantity_change,resulting_qty,reference_type,reference_id,employee_id,reason)
            SELECT ti.product_id,ti.variation_id,NEW.branch_id,'void_restore',SUM(ti.quantity),b.stock_qty,'transaction',CAST(NEW.id AS TEXT),NEW.voided_by,'Completed sale void restored exact branch variation stock'
            FROM transaction_items ti JOIN branch_variation_inventory b ON b.product_id=ti.product_id AND b.variation_id=ti.variation_id AND b.branch_id=NEW.branch_id
            JOIN branch_variation_migrations m ON m.product_id=ti.product_id AND m.branch_id=NEW.branch_id
            WHERE ti.transaction_id=NEW.id AND ti.variation_id IS NOT NULL GROUP BY ti.product_id,ti.variation_id;
        END`}
    ],'write');
  }
  if(await tableExists('return_items')){
    await db.batch([
      {sql:`CREATE TRIGGER IF NOT EXISTS trg_branch_variation_return
        AFTER INSERT ON return_items
        WHEN EXISTS(SELECT 1 FROM returns r WHERE r.id=NEW.return_id AND r.resolution IN ('refund','credit_note') AND r.branch_id IS NOT NULL)
          AND EXISTS(SELECT 1 FROM transaction_items ti JOIN returns r ON r.id=NEW.return_id JOIN branch_variation_migrations m ON m.product_id=ti.product_id AND m.branch_id=r.branch_id WHERE ti.id=NEW.transaction_item_id AND ti.variation_id IS NOT NULL)
        BEGIN
          UPDATE branch_variation_inventory SET stock_qty=stock_qty+NEW.quantity,updated_at=CURRENT_TIMESTAMP
            WHERE product_id=NEW.product_id AND variation_id=(SELECT variation_id FROM transaction_items WHERE id=NEW.transaction_item_id) AND branch_id=(SELECT branch_id FROM returns WHERE id=NEW.return_id);
          INSERT INTO branch_variation_inventory_events(product_id,variation_id,branch_id,event_type,quantity_change,resulting_qty,reference_type,reference_id,employee_id,reason)
            SELECT NEW.product_id,ti.variation_id,r.branch_id,'return_restore',NEW.quantity,b.stock_qty,'return',CAST(NEW.return_id AS TEXT),r.employee_id,'Refund/credit-note return restored sellable exact variation stock'
            FROM transaction_items ti JOIN returns r ON r.id=NEW.return_id JOIN branch_variation_inventory b ON b.product_id=NEW.product_id AND b.variation_id=ti.variation_id AND b.branch_id=r.branch_id WHERE ti.id=NEW.transaction_item_id;
        END`}
    ],'write');
  }
  if(await tableExists('replacement_fulfillments')){
    await db.batch([
      {sql:`CREATE TRIGGER IF NOT EXISTS trg_branch_variation_replacement_guard
        BEFORE INSERT ON replacement_fulfillments
        WHEN NEW.variation_id IS NOT NULL AND NEW.branch_id IS NOT NULL
          AND EXISTS(SELECT 1 FROM branch_variation_migrations m WHERE m.product_id=NEW.product_id AND m.branch_id=NEW.branch_id)
        BEGIN
          SELECT CASE WHEN COALESCE((SELECT stock_qty FROM branch_variation_inventory WHERE product_id=NEW.product_id AND variation_id=NEW.variation_id AND branch_id=NEW.branch_id),0) < NEW.quantity
            THEN RAISE(ABORT,'Insufficient exact variation stock at this branch for replacement') END;
        END`},
      {sql:`CREATE TRIGGER IF NOT EXISTS trg_branch_variation_replacement
        AFTER INSERT ON replacement_fulfillments
        WHEN NEW.variation_id IS NOT NULL AND NEW.branch_id IS NOT NULL
          AND EXISTS(SELECT 1 FROM branch_variation_migrations m WHERE m.product_id=NEW.product_id AND m.branch_id=NEW.branch_id)
        BEGIN
          UPDATE branch_variation_inventory SET stock_qty=stock_qty-NEW.quantity,updated_at=CURRENT_TIMESTAMP WHERE product_id=NEW.product_id AND variation_id=NEW.variation_id AND branch_id=NEW.branch_id;
          INSERT INTO branch_variation_inventory_events(product_id,variation_id,branch_id,event_type,quantity_change,resulting_qty,reference_type,reference_id,employee_id,reason)
            SELECT NEW.product_id,NEW.variation_id,NEW.branch_id,'replacement_issue',-NEW.quantity,b.stock_qty,'return',CAST(NEW.return_id AS TEXT),NEW.issued_by_employee_id,'Like-for-like replacement issued from exact branch variation stock'
            FROM branch_variation_inventory b WHERE b.product_id=NEW.product_id AND b.variation_id=NEW.variation_id AND b.branch_id=NEW.branch_id;
        END`}
    ],'write');
  }
}

async function ensureBranchVariationInventory(){await ensureCoreSchema();await ensureTriggers();}
module.exports={ensureBranchVariationInventory,ensureCoreSchema,ensureTriggers};
