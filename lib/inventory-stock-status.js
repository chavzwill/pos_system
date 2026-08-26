'use strict';
const { db } = require('../database');

let readyPromise = null;
const STATUSES = new Set(['inspection','blocked','quarantine','damaged','expired']);

async function ensureInventoryStockStatus() {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    await db.batch([
      { sql: `CREATE TABLE IF NOT EXISTS inventory_stock_status_balances (
        product_id INTEGER NOT NULL REFERENCES products(id),
        branch_id INTEGER NOT NULL REFERENCES branches(id),
        status TEXT NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 0,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(product_id, branch_id, status)
      )` },
      { sql: `CREATE TABLE IF NOT EXISTS inventory_stock_status_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL REFERENCES products(id),
        branch_id INTEGER NOT NULL REFERENCES branches(id),
        from_status TEXT NOT NULL,
        to_status TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        reason TEXT NOT NULL,
        employee_id INTEGER REFERENCES employees(id),
        reference TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )` },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_inventory_status_branch_product ON inventory_stock_status_balances(branch_id,product_id,status)' },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_inventory_status_events_product ON inventory_stock_status_events(product_id,branch_id,created_at)' },
    ], 'write');
  })().catch(e => { readyPromise = null; throw e; });
  return readyPromise;
}

async function getRestrictedQty(executor, productId, branchId) {
  await ensureInventoryStockStatus();
  const { rows:[row] } = await executor.execute({
    sql: `SELECT COALESCE(SUM(quantity),0) restricted_qty
          FROM inventory_stock_status_balances
          WHERE product_id=? AND branch_id=? AND status IN ('inspection','blocked','quarantine','damaged','expired')`,
    args: [productId, branchId]
  });
  return Number(row?.restricted_qty || 0);
}

async function getAvailableQty(executor, productId, branchId) {
  await ensureInventoryStockStatus();
  const { rows:[inv] } = await executor.execute({
    sql: 'SELECT stock_qty FROM branch_inventory WHERE product_id=? AND branch_id=?',
    args: [productId, branchId]
  });
  const onHand = Number(inv?.stock_qty || 0);
  const restricted = await getRestrictedQty(executor, productId, branchId);
  return { on_hand: onHand, restricted, available: Math.max(0, onHand - restricted) };
}

async function moveStockStatus(executor, { productId, branchId, fromStatus='available', toStatus, quantity, reason, employeeId, reference }) {
  await ensureInventoryStockStatus();
  if (!Number.isInteger(Number(quantity)) || Number(quantity) <= 0) throw new Error('Status movement quantity must be a positive whole number');
  if (!String(reason || '').trim()) throw new Error('A stock-status movement reason is required');
  if (fromStatus !== 'available' && !STATUSES.has(fromStatus)) throw new Error('Invalid source stock status');
  if (toStatus !== 'available' && !STATUSES.has(toStatus)) throw new Error('Invalid destination stock status');
  if (fromStatus === toStatus) throw new Error('Source and destination stock status must differ');

  const qty = Number(quantity);
  const { rows:[inv] } = await executor.execute({ sql:'SELECT stock_qty FROM branch_inventory WHERE product_id=? AND branch_id=?', args:[productId,branchId] });
  if (!inv) throw new Error('Product is not stocked at the selected branch');

  if (fromStatus === 'available') {
    const state = await getAvailableQty(executor, productId, branchId);
    if (state.available < qty) throw new Error(`Only ${state.available} units are available for disposition`);
  } else {
    const { rows:[bal] } = await executor.execute({ sql:'SELECT quantity FROM inventory_stock_status_balances WHERE product_id=? AND branch_id=? AND status=?', args:[productId,branchId,fromStatus] });
    if (Number(bal?.quantity || 0) < qty) throw new Error(`Only ${Number(bal?.quantity || 0)} units are in ${fromStatus} status`);
    await executor.execute({ sql:`UPDATE inventory_stock_status_balances SET quantity=quantity-?,updated_at=CURRENT_TIMESTAMP WHERE product_id=? AND branch_id=? AND status=?`, args:[qty,productId,branchId,fromStatus] });
  }

  if (toStatus !== 'available') {
    await executor.execute({
      sql:`INSERT INTO inventory_stock_status_balances(product_id,branch_id,status,quantity)
           VALUES(?,?,?,?)
           ON CONFLICT(product_id,branch_id,status) DO UPDATE SET quantity=quantity+excluded.quantity,updated_at=CURRENT_TIMESTAMP`,
      args:[productId,branchId,toStatus,qty]
    });
  }

  await executor.execute({
    sql:`INSERT INTO inventory_stock_status_events(product_id,branch_id,from_status,to_status,quantity,reason,employee_id,reference)
         VALUES(?,?,?,?,?,?,?,?)`,
    args:[productId,branchId,fromStatus,toStatus,qty,String(reason).trim(),employeeId || null,reference || null]
  });
}

module.exports = { STATUSES, ensureInventoryStockStatus, getRestrictedQty, getAvailableQty, moveStockStatus };
