const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { syncBinQty } = require('../lib/binSync');
const { requirePermission, can } = require('../lib/permissions');

let receiptSchemaReady = false;
async function ensureReceiptSchema() {
  if (receiptSchemaReady) return;
  await db.batch([
    { sql: `CREATE TABLE IF NOT EXISTS purchase_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_number TEXT NOT NULL UNIQUE,
      po_id INTEGER NOT NULL REFERENCES purchase_orders(id),
      supplier_id INTEGER REFERENCES suppliers(id),
      branch_id INTEGER REFERENCES branches(id),
      received_by_employee_id INTEGER REFERENCES employees(id),
      received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      total_cost REAL NOT NULL DEFAULT 0
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS purchase_receipt_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_id INTEGER NOT NULL REFERENCES purchase_receipts(id),
      po_item_id INTEGER NOT NULL REFERENCES purchase_order_items(id),
      product_id INTEGER REFERENCES products(id),
      product_name TEXT,
      sku TEXT,
      quantity_received INTEGER NOT NULL,
      unit_cost REAL NOT NULL,
      line_cost REAL NOT NULL
    )` },
    { sql: 'CREATE INDEX IF NOT EXISTS idx_purchase_receipts_po ON purchase_receipts(po_id)' },
    { sql: 'CREATE INDEX IF NOT EXISTS idx_purchase_receipt_items_receipt ON purchase_receipt_items(receipt_id)' },
  ], 'write');
  receiptSchemaReady = true;
}

// This router is mounted before routes/purchase-orders.js. It owns the
// lifecycle-sensitive paths and falls through to the legacy module for the
// rest, preserving the existing frontend contract while tightening integrity.
router.use(requirePermission('purchasing'));
router.use(async (req, res, next) => {
  try { await ensureReceiptSchema(); next(); }
  catch (e) { res.status(500).json({ error: 'Purchase receipt evidence initialization failed', detail: e.message }); }
});

const STATUS_TRANSITIONS = {
  draft: new Set(['sent', 'approved', 'cancelled']),
  sent: new Set(['approved', 'cancelled']),
  approved: new Set(['cancelled']),
  partial: new Set(),
  received: new Set(),
  cancelled: new Set(),
};

router.post('/', requirePermission('purchasing_create'), (req, res, next) => {
  const { supplier_id, branch_id, items } = req.body || {};
  if (!supplier_id) return res.status(400).json({ error: 'A supplier is required for a purchase order' });
  if (!branch_id) return res.status(400).json({ error: 'A receiving branch is required for a purchase order' });
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'No items in PO' });
  for (const item of items) {
    const qty = Number(item.quantity_ordered ?? item.quantity ?? 0);
    const cost = Number(item.unit_cost ?? 0);
    if (!Number.isInteger(qty) || qty <= 0) return res.status(400).json({ error: 'Every PO line requires a positive whole-number quantity' });
    if (!Number.isFinite(cost) || cost < 0) return res.status(400).json({ error: 'PO unit cost cannot be negative' });
  }
  next();
});

router.patch('/:id/status', async (req, res) => {
  try {
    const target = String(req.body?.status || '');
    if (!['draft', 'sent', 'approved', 'cancelled'].includes(target)) return res.status(400).json({ error: 'Invalid status' });
    if (target === 'approved' && !req.apiKey && !can(req.employee.permissions, 'purchasing_approve')) {
      return res.status(403).json({ error: 'Missing permission: purchasing_approve' });
    }
    const { rows: [po] } = await db.execute({ sql: 'SELECT * FROM purchase_orders WHERE id = ?', args: [req.params.id] });
    if (!po) return res.status(404).json({ error: 'Not found' });
    if (po.status === target) return res.json(po);
    const allowed = STATUS_TRANSITIONS[po.status] || new Set();
    if (!allowed.has(target)) return res.status(400).json({ error: `Cannot move purchase order from ${po.status} to ${target}` });
    if (target === 'cancelled') {
      const { rows: [receipt] } = await db.execute({ sql: 'SELECT COALESCE(SUM(quantity_received),0) received FROM purchase_order_items WHERE po_id = ?', args: [req.params.id] });
      if (Number(receipt?.received) > 0) return res.status(400).json({ error: 'A partially received PO cannot be cancelled; use Close Short instead' });
    }
    await db.execute({ sql: 'UPDATE purchase_orders SET status = ? WHERE id = ?', args: [target, req.params.id] });
    const { rows: [updated] } = await db.execute({ sql: 'SELECT * FROM purchase_orders WHERE id = ?', args: [req.params.id] });
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/:id/receive', requirePermission('purchasing_receive'), async (req, res) => {
  try {
    const requested = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!requested.length) return res.status(400).json({ error: 'At least one received quantity is required' });
    const { rows: [po] } = await db.execute({ sql: 'SELECT * FROM purchase_orders WHERE id = ?', args: [req.params.id] });
    if (!po) return res.status(404).json({ error: 'Not found' });
    if (!['approved', 'partial'].includes(po.status)) return res.status(400).json({ error: `PO must be approved before receiving; current status is ${po.status}` });

    const seen = new Set();
    const validated = [];
    for (const line of requested) {
      const itemId = Number(line.item_id);
      const qty = Number(line.quantity_received);
      if (!itemId || !Number.isInteger(qty) || qty <= 0) return res.status(400).json({ error: 'Each receipt line requires an item and positive whole-number quantity' });
      if (seen.has(itemId)) return res.status(400).json({ error: `PO item ${itemId} appears more than once in this receipt` });
      seen.add(itemId);
      const { rows: [item] } = await db.execute({ sql: 'SELECT * FROM purchase_order_items WHERE id = ? AND po_id = ?', args: [itemId, req.params.id] });
      if (!item) return res.status(400).json({ error: `PO item ${itemId} does not belong to this purchase order` });
      const remaining = Math.max(0, Number(item.quantity_ordered) - Number(item.quantity_received || 0));
      if (qty > remaining) return res.status(400).json({ error: `Cannot receive ${qty} of ${item.product_name}; only ${remaining} remain open` });
      const unitCost = Number(item.unit_cost || 0);
      if (!Number.isFinite(unitCost) || unitCost < 0) return res.status(409).json({ error: `Invalid unit cost evidence for ${item.product_name}` });
      validated.push({ item, qty, unitCost, lineCost: Number((qty * unitCost).toFixed(2)) });
    }

    const tx = await db.transaction('write');
    let committed = false;
    let receiptId = null;
    let receiptNumber = null;
    try {
      const receiptTotal = Number(validated.reduce((sum, x) => sum + x.lineCost, 0).toFixed(2));
      receiptNumber = `RCV-${po.id}-${Date.now()}`;
      const receiptResult = await tx.execute({
        sql: `INSERT INTO purchase_receipts(receipt_number,po_id,supplier_id,branch_id,received_by_employee_id,total_cost)
              VALUES (?,?,?,?,?,?)`,
        args: [receiptNumber, po.id, po.supplier_id || null, po.branch_id || null, req.employee?.id || req.user?.employee_id || null, receiptTotal]
      });
      receiptId = Number(receiptResult.lastInsertRowid);

      for (const { item, qty, unitCost, lineCost } of validated) {
        await tx.execute({
          sql: `INSERT INTO purchase_receipt_items(receipt_id,po_item_id,product_id,product_name,sku,quantity_received,unit_cost,line_cost)
                VALUES (?,?,?,?,?,?,?,?)`,
          args: [receiptId, item.id, item.product_id || null, item.product_name || null, item.sku || null, qty, unitCost, lineCost]
        });
        await tx.execute({ sql: 'UPDATE purchase_order_items SET quantity_received = quantity_received + ? WHERE id = ?', args: [qty, item.id] });
        if (!item.product_id) continue;
        await tx.execute({ sql: 'UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?', args: [qty, item.product_id] });
        if (unitCost > 0) await tx.execute({ sql: 'UPDATE products SET cost = ? WHERE id = ?', args: [unitCost, item.product_id] });
        if (po.branch_id) {
          await tx.execute({
            sql: `INSERT INTO branch_inventory (product_id, branch_id, stock_qty, min_stock, updated_at)
                  VALUES (?, ?, ?, (SELECT min_stock FROM products WHERE id = ?), CURRENT_TIMESTAMP)
                  ON CONFLICT(product_id, branch_id) DO UPDATE SET stock_qty = stock_qty + ?, updated_at = CURRENT_TIMESTAMP`,
            args: [item.product_id, po.branch_id, qty, item.product_id, qty]
          });
          await syncBinQty(tx, item.product_id, po.branch_id, qty);
        }
        await tx.execute({
          sql: 'INSERT INTO stock_movements (product_id, branch_id, quantity_change, type, reference, reason) VALUES (?,?,?,?,?,?)',
          args: [item.product_id, po.branch_id || null, qty, 'purchase_receive', receiptNumber, `Received against ${po.po_number}`]
        });
      }

      const { rows: items } = await tx.execute({ sql: 'SELECT * FROM purchase_order_items WHERE po_id = ?', args: [req.params.id] });
      const allReceived = items.every(i => Number(i.quantity_received || 0) >= Number(i.quantity_ordered || 0));
      const newStatus = allReceived ? 'received' : 'partial';
      await tx.execute({ sql: 'UPDATE purchase_orders SET status = ?, received_at = ? WHERE id = ?', args: [newStatus, allReceived ? new Date().toISOString() : po.received_at, req.params.id] });
      if (allReceived) await tx.execute({ sql: `UPDATE purchase_requests SET status = 'received' WHERE converted_to_po_id = ? AND status != 'received'`, args: [req.params.id] });
      await tx.commit();
      committed = true;
    } catch (e) {
      if (!committed) await tx.rollback();
      return res.status(committed ? 500 : 400).json({ error: e.message });
    }

    const { rows: [updated] } = await db.execute({
      sql: `SELECT po.*, s.name supplier_name, b.name branch_name FROM purchase_orders po
            LEFT JOIN suppliers s ON s.id=po.supplier_id LEFT JOIN branches b ON b.id=po.branch_id WHERE po.id=?`, args: [req.params.id]
    });
    const { rows: items } = await db.execute({ sql: 'SELECT * FROM purchase_order_items WHERE po_id = ?', args: [req.params.id] });
    updated.items = items;
    updated.receipt_id = receiptId;
    updated.receipt_number = receiptNumber;
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/:id/close-short', requirePermission('purchasing_approve'), async (req, res) => {
  try {
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A reason is required to close a PO short' });
    const { rows: [po] } = await db.execute({ sql: 'SELECT * FROM purchase_orders WHERE id = ?', args: [req.params.id] });
    if (!po) return res.status(404).json({ error: 'Not found' });
    if (po.status !== 'partial') return res.status(400).json({ error: 'Only a partially received PO can be closed short' });
    const stamp = new Date().toISOString();
    const note = `${po.notes ? `${po.notes}\n` : ''}[Closed short ${stamp}] ${reason}`;
    const tx = await db.transaction('write');
    let committed = false;
    try {
      await tx.execute({ sql: `UPDATE purchase_orders SET status='received', received_at=CURRENT_TIMESTAMP, notes=? WHERE id=?`, args: [note, req.params.id] });
      await tx.execute({ sql: `UPDATE purchase_requests SET status='received' WHERE converted_to_po_id=? AND status!='received'`, args: [req.params.id] });
      await tx.commit(); committed = true;
    } catch (e) { if (!committed) await tx.rollback(); throw e; }
    const { rows: [updated] } = await db.execute({ sql: 'SELECT * FROM purchase_orders WHERE id=?', args: [req.params.id] });
    res.json(updated);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
module.exports.ensureReceiptSchema = ensureReceiptSchema;
