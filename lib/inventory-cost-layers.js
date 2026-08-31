const { db } = require('../database');
const { ensurePurchaseReceiptBaseSchema } = require('./purchase-receipt-base-schema');

let readyPromise = null;

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Number(n.toFixed(4)) : 0;
}

async function ensureInventoryCostLayers() {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    // Cost-layer tables and triggers reference immutable purchase receipt and
    // landed-cost evidence. Establish those shared prerequisites explicitly so
    // valuation can cold-start from Rental, Repairs, write-offs, or reporting
    // without depending on a Purchasing route having been visited first.
    await ensurePurchaseReceiptBaseSchema();
    await db.batch([
      { sql: `CREATE TABLE IF NOT EXISTS inventory_cost_pools (
        product_id INTEGER NOT NULL REFERENCES products(id),
        branch_key INTEGER NOT NULL DEFAULT 0,
        legacy_unlayered_qty REAL NOT NULL DEFAULT 0,
        tracked_qty REAL NOT NULL DEFAULT 0,
        tracked_value REAL NOT NULL DEFAULT 0,
        initialized_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(product_id,branch_key)
      )` },
      { sql: `CREATE TABLE IF NOT EXISTS inventory_cost_layers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL REFERENCES products(id),
        branch_key INTEGER NOT NULL DEFAULT 0,
        purchase_receipt_item_id INTEGER NOT NULL UNIQUE REFERENCES purchase_receipt_items(id),
        receipt_id INTEGER NOT NULL REFERENCES purchase_receipts(id),
        quantity_original REAL NOT NULL,
        base_unit_cost REAL NOT NULL,
        base_value REAL NOT NULL,
        landed_cost_total REAL NOT NULL DEFAULT 0,
        adjusted_unit_cost REAL NOT NULL,
        received_at DATETIME NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )` },
      { sql: `CREATE TABLE IF NOT EXISTS inventory_cost_consumptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transaction_item_id INTEGER NOT NULL UNIQUE REFERENCES transaction_items(id),
        transaction_id INTEGER NOT NULL REFERENCES transactions(id),
        product_id INTEGER NOT NULL REFERENCES products(id),
        branch_key INTEGER NOT NULL DEFAULT 0,
        quantity REAL NOT NULL,
        tracked_quantity REAL NOT NULL DEFAULT 0,
        legacy_quantity REAL NOT NULL DEFAULT 0,
        untracked_shortage_qty REAL NOT NULL DEFAULT 0,
        unit_cost_snapshot REAL,
        tracked_unit_cost REAL,
        valuation_method TEXT NOT NULL DEFAULT 'moving_weighted_average',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )` },
      { sql: `CREATE TABLE IF NOT EXISTS inventory_cost_evidence_gaps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        product_id INTEGER,
        branch_key INTEGER NOT NULL DEFAULT 0,
        gap_type TEXT NOT NULL,
        quantity REAL,
        amount REAL,
        details TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(source_type,source_id,gap_type)
      )` },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_inventory_cost_layers_product_branch ON inventory_cost_layers(product_id,branch_key,received_at,id)' },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_inventory_cost_consumptions_product_branch ON inventory_cost_consumptions(product_id,branch_key,created_at)' },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_inventory_cost_gaps_type ON inventory_cost_evidence_gaps(gap_type,created_at)' },
    ], 'write');

    await db.execute({
      sql: `INSERT OR IGNORE INTO inventory_cost_pools(product_id,branch_key,legacy_unlayered_qty,tracked_qty,tracked_value)
            SELECT bi.product_id,bi.branch_id,MAX(0,bi.stock_qty),0,0 FROM branch_inventory bi`,
      args: []
    });
    await db.execute({
      sql: `INSERT OR IGNORE INTO inventory_cost_pools(product_id,branch_key,legacy_unlayered_qty,tracked_qty,tracked_value)
            SELECT p.id,0,MAX(0,p.stock_qty),0,0 FROM products p
            WHERE NOT EXISTS(SELECT 1 FROM branch_inventory bi WHERE bi.product_id=p.id)`,
      args: []
    });

    await db.execute({ sql: 'DROP TRIGGER IF EXISTS trg_transaction_item_cost_snapshot', args: [] });

    await db.execute({ sql: `CREATE TRIGGER IF NOT EXISTS trg_inventory_cost_receipt_layer
      AFTER INSERT ON purchase_receipt_items
      WHEN NEW.product_id IS NOT NULL
      BEGIN
        INSERT OR IGNORE INTO inventory_cost_pools(product_id,branch_key,legacy_unlayered_qty,tracked_qty,tracked_value)
        SELECT NEW.product_id,COALESCE(pr.branch_id,0),
          CASE WHEN pr.branch_id IS NULL
            THEN COALESCE((SELECT stock_qty FROM products WHERE id=NEW.product_id),0)
            ELSE COALESCE((SELECT stock_qty FROM branch_inventory WHERE product_id=NEW.product_id AND branch_id=pr.branch_id),0)
          END,0,0
        FROM purchase_receipts pr WHERE pr.id=NEW.receipt_id;

        INSERT OR IGNORE INTO inventory_cost_layers(product_id,branch_key,purchase_receipt_item_id,receipt_id,quantity_original,base_unit_cost,base_value,landed_cost_total,adjusted_unit_cost,received_at)
        SELECT NEW.product_id,COALESCE(pr.branch_id,0),NEW.id,NEW.receipt_id,NEW.quantity_received,NEW.unit_cost,NEW.line_cost,0,NEW.unit_cost,pr.received_at
        FROM purchase_receipts pr WHERE pr.id=NEW.receipt_id;

        UPDATE inventory_cost_pools
        SET tracked_qty=ROUND(tracked_qty+NEW.quantity_received,4),
            tracked_value=ROUND(tracked_value+NEW.line_cost,4),
            updated_at=CURRENT_TIMESTAMP
        WHERE product_id=NEW.product_id
          AND branch_key=COALESCE((SELECT branch_id FROM purchase_receipts WHERE id=NEW.receipt_id),0);
      END`, args: [] });

    await db.execute({ sql: `CREATE TRIGGER IF NOT EXISTS trg_inventory_cost_landed_adjustment
      AFTER INSERT ON landed_cost_allocation_items
      BEGIN
        INSERT OR IGNORE INTO inventory_cost_evidence_gaps(source_type,source_id,product_id,branch_key,gap_type,quantity,amount,details)
        SELECT 'landed_cost_allocation_item',CAST(NEW.id AS TEXT),l.product_id,l.branch_key,'late_landed_cost_after_consumption',
          NEW.quantity_received,NEW.allocated_amount,
          'Landed cost was allocated after tracked inventory consumption began. The allocation remains auditable, but inventory valuation requires a COGS/inventory split rather than silently adding the full amount to remaining inventory.'
        FROM inventory_cost_layers l
        WHERE l.purchase_receipt_item_id=NEW.purchase_receipt_item_id
          AND EXISTS(SELECT 1 FROM inventory_cost_consumptions c WHERE c.product_id=l.product_id AND c.branch_key=l.branch_key AND c.created_at>=l.received_at);

        UPDATE inventory_cost_layers
        SET landed_cost_total=ROUND(landed_cost_total+NEW.allocated_amount,4),
            adjusted_unit_cost=ROUND(base_unit_cost+(landed_cost_total+NEW.allocated_amount)/NULLIF(quantity_original,0),4)
        WHERE purchase_receipt_item_id=NEW.purchase_receipt_item_id;

        UPDATE inventory_cost_pools
        SET tracked_value=ROUND(tracked_value+NEW.allocated_amount,4),updated_at=CURRENT_TIMESTAMP
        WHERE product_id=NEW.product_id
          AND branch_key=COALESCE((SELECT pr.branch_id FROM purchase_receipts pr WHERE pr.id=NEW.receipt_id),0)
          AND NOT EXISTS(
            SELECT 1 FROM inventory_cost_layers l
            JOIN inventory_cost_consumptions c ON c.product_id=l.product_id AND c.branch_key=l.branch_key AND c.created_at>=l.received_at
            WHERE l.purchase_receipt_item_id=NEW.purchase_receipt_item_id
          );
      END`, args: [] });

    await db.execute({ sql: `CREATE TRIGGER IF NOT EXISTS trg_transaction_item_cost_pool_snapshot
      AFTER INSERT ON transaction_items
      WHEN NEW.product_id IS NOT NULL
       AND COALESCE((SELECT status FROM transactions WHERE id=NEW.transaction_id),'completed')='completed'
      BEGIN
        INSERT OR IGNORE INTO inventory_cost_pools(product_id,branch_key,legacy_unlayered_qty,tracked_qty,tracked_value)
        SELECT NEW.product_id,COALESCE(t.branch_id,0),
          CASE WHEN t.branch_id IS NULL
            THEN COALESCE((SELECT stock_qty FROM products WHERE id=NEW.product_id),0)
            ELSE COALESCE((SELECT stock_qty FROM branch_inventory WHERE product_id=NEW.product_id AND branch_id=t.branch_id),0)
          END,0,0
        FROM transactions t WHERE t.id=NEW.transaction_id;

        INSERT OR IGNORE INTO inventory_cost_evidence_gaps(source_type,source_id,product_id,branch_key,gap_type,quantity,details)
        SELECT 'transaction_item',CAST(NEW.id AS TEXT),NEW.product_id,p.branch_key,'legacy_opening_inventory_cost_unknown',
          MIN(NEW.quantity,p.legacy_unlayered_qty),
          'This sale consumed inventory that existed before auditable cost pools were initialized. The sale keeps a fallback catalog-cost snapshot and is excluded from evidence-backed COGS valuation.'
        FROM inventory_cost_pools p
        WHERE p.product_id=NEW.product_id
          AND p.branch_key=COALESCE((SELECT branch_id FROM transactions WHERE id=NEW.transaction_id),0)
          AND p.legacy_unlayered_qty>0;

        INSERT OR IGNORE INTO inventory_cost_evidence_gaps(source_type,source_id,product_id,branch_key,gap_type,quantity,details)
        SELECT 'transaction_item',CAST(NEW.id AS TEXT),NEW.product_id,p.branch_key,'tracked_cost_pool_shortage',
          MAX(0,NEW.quantity-p.legacy_unlayered_qty-p.tracked_qty),
          'Physical stock consumption exceeded the auditable cost-pool quantity. Accounting will not invent the missing inventory value.'
        FROM inventory_cost_pools p
        WHERE p.product_id=NEW.product_id
          AND p.branch_key=COALESCE((SELECT branch_id FROM transactions WHERE id=NEW.transaction_id),0)
          AND NEW.quantity>p.legacy_unlayered_qty+p.tracked_qty;

        UPDATE transaction_items
        SET unit_cost_at_sale=CASE
          WHEN (SELECT legacy_unlayered_qty FROM inventory_cost_pools WHERE product_id=NEW.product_id AND branch_key=COALESCE((SELECT branch_id FROM transactions WHERE id=NEW.transaction_id),0))<=0
           AND (SELECT tracked_qty FROM inventory_cost_pools WHERE product_id=NEW.product_id AND branch_key=COALESCE((SELECT branch_id FROM transactions WHERE id=NEW.transaction_id),0))>=NEW.quantity
          THEN ROUND(
            (SELECT tracked_value FROM inventory_cost_pools WHERE product_id=NEW.product_id AND branch_key=COALESCE((SELECT branch_id FROM transactions WHERE id=NEW.transaction_id),0)) /
            NULLIF((SELECT tracked_qty FROM inventory_cost_pools WHERE product_id=NEW.product_id AND branch_key=COALESCE((SELECT branch_id FROM transactions WHERE id=NEW.transaction_id),0)),0),4)
          ELSE (SELECT cost FROM products WHERE id=NEW.product_id)
        END
        WHERE id=NEW.id;

        INSERT OR IGNORE INTO inventory_cost_consumptions(transaction_item_id,transaction_id,product_id,branch_key,quantity,tracked_quantity,legacy_quantity,untracked_shortage_qty,unit_cost_snapshot,tracked_unit_cost)
        SELECT NEW.id,NEW.transaction_id,NEW.product_id,p.branch_key,NEW.quantity,
          MIN(p.tracked_qty,MAX(0,NEW.quantity-p.legacy_unlayered_qty)),
          MIN(NEW.quantity,p.legacy_unlayered_qty),
          MAX(0,NEW.quantity-p.legacy_unlayered_qty-p.tracked_qty),
          (SELECT unit_cost_at_sale FROM transaction_items WHERE id=NEW.id),
          CASE WHEN p.tracked_qty>0 THEN ROUND(p.tracked_value/p.tracked_qty,4) ELSE NULL END
        FROM inventory_cost_pools p
        WHERE p.product_id=NEW.product_id
          AND p.branch_key=COALESCE((SELECT branch_id FROM transactions WHERE id=NEW.transaction_id),0);

        UPDATE inventory_cost_pools
        SET tracked_value=ROUND(MAX(0,tracked_value-(CASE WHEN tracked_qty>0 THEN tracked_value/tracked_qty ELSE 0 END)*MIN(tracked_qty,MAX(0,NEW.quantity-legacy_unlayered_qty))),4),
            tracked_qty=ROUND(MAX(0,tracked_qty-MIN(tracked_qty,MAX(0,NEW.quantity-legacy_unlayered_qty))),4),
            legacy_unlayered_qty=ROUND(MAX(0,legacy_unlayered_qty-NEW.quantity),4),
            updated_at=CURRENT_TIMESTAMP
        WHERE product_id=NEW.product_id
          AND branch_key=COALESCE((SELECT branch_id FROM transactions WHERE id=NEW.transaction_id),0);
      END`, args: [] });
  })().catch(e => { readyPromise = null; throw e; });
  return readyPromise;
}

async function getInventoryValuationSummary() {
  await ensureInventoryCostLayers();
  const { rows:[summary] } = await db.execute({ sql: `SELECT
    COUNT(*) pool_count,
    ROUND(COALESCE(SUM(tracked_qty),0),4) tracked_units,
    ROUND(COALESCE(SUM(tracked_value),0),2) tracked_inventory_value,
    ROUND(COALESCE(SUM(legacy_unlayered_qty),0),4) legacy_unlayered_units
    FROM inventory_cost_pools`, args: [] });
  const { rows:[gaps] } = await db.execute({ sql: `SELECT COUNT(*) gap_count FROM inventory_cost_evidence_gaps`, args: [] });
  return { ...summary, evidence_gap_count:Number(gaps?.gap_count||0), valuation_method:'perpetual_moving_weighted_average', basis:'Only inventory entering after cost-pool initialization is automatically valued from immutable receipt evidence. Pre-existing stock remains explicitly unlayered until consumed.' };
}

module.exports = { ensureInventoryCostLayers, getInventoryValuationSummary, money };
