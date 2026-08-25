const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission } = require('../lib/permissions');
const { nextNumber } = require('../lib/nextNumber');
const { syncBinQty } = require('../lib/binSync');

let readyPromise = null;
async function ensureSchema() {
  if (readyPromise) return readyPromise;
  readyPromise = db.batch([
    { sql: `CREATE TABLE IF NOT EXISTS replacement_fulfillments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      return_id INTEGER NOT NULL REFERENCES returns(id),
      return_item_id INTEGER NOT NULL REFERENCES return_items(id),
      original_transaction_id INTEGER NOT NULL REFERENCES transactions(id),
      transaction_item_id INTEGER NOT NULL REFERENCES transaction_items(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      branch_id INTEGER REFERENCES branches(id),
      quantity INTEGER NOT NULL,
      unit_cost_at_issue REAL,
      issued_by_employee_id INTEGER REFERENCES employees(id),
      issued_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(return_item_id)
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS return_quarantine (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      return_id INTEGER NOT NULL REFERENCES returns(id),
      return_item_id INTEGER NOT NULL REFERENCES return_items(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      branch_id INTEGER REFERENCES branches(id),
      quantity INTEGER NOT NULL,
      unit_cost_at_return REAL,
      disposition_status TEXT NOT NULL DEFAULT 'quarantine',
      disposition_notes TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      resolved_at DATETIME,
      UNIQUE(return_item_id)
    )` },
    { sql: 'CREATE INDEX IF NOT EXISTS idx_replacement_return ON replacement_fulfillments(return_id)' },
    { sql: 'CREATE INDEX IF NOT EXISTS idx_return_quarantine_return ON return_quarantine(return_id)' },
  ], 'write').catch(e => { readyPromise = null; throw e; });
  return readyPromise;
}

router.use(async (req, res, next) => {
  try { await ensureSchema(); next(); }
  catch (e) { res.status(500).json({ error: 'Replacement return integrity initialization failed', detail: e.message }); }
});

router.post('/:id/return', requirePermission('transactions_returns'), async (req, res, next) => {
  if (req.body?.resolution !== 'replacement') return next();
  try {
    const { items, notes, employee_id } = req.body || {};
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'No items selected for replacement' });

    const { rows: [sale] } = await db.execute({ sql: 'SELECT * FROM transactions WHERE id = ?', args: [req.params.id] });
    if (!sale) return res.status(404).json({ error: 'Transaction not found' });
    if (sale.status !== 'completed') return res.status(400).json({ error: 'Only completed transactions can be replaced' });

    const { rows: [linkedRental] } = await db.execute({ sql: 'SELECT agreement_number FROM rental_agreements WHERE checkout_transaction_id = ? OR settlement_transaction_id = ?', args: [sale.id, sale.id] });
    if (linkedRental) return res.status(400).json({ error: `This transaction belongs to rental agreement ${linkedRental.agreement_number}; use the Rentals workflow.` });

    const { rows: saleItems } = await db.execute({ sql: 'SELECT * FROM transaction_items WHERE transaction_id = ?', args: [sale.id] });
    const { rows: alreadyReturned } = await db.execute({ sql: `SELECT ri.transaction_item_id, SUM(ri.quantity) AS returned_qty
      FROM return_items ri JOIN returns r ON r.id = ri.return_id
      WHERE r.original_transaction_id = ? AND COALESCE(r.status,'completed') != 'cancelled'
      GROUP BY ri.transaction_item_id`, args: [sale.id] });
    const returnedMap = Object.fromEntries(alreadyReturned.map(r => [Number(r.transaction_item_id), Number(r.returned_qty || 0)]));

    let subtotal = 0;
    let tax = 0;
    const prepared = [];
    for (const requestItem of items) {
      const line = saleItems.find(x => Number(x.id) === Number(requestItem.transaction_item_id));
      if (!line) return res.status(400).json({ error: `Item ${requestItem.transaction_item_id} not found in transaction` });
      if (!line.product_id) return res.status(409).json({ error: `Replacement cannot be issued for non-inventory line ${line.product_name}` });
      const qty = Number(requestItem.quantity || 0);
      const maxQty = Number(line.quantity || 0) - Number(returnedMap[line.id] || 0);
      if (!Number.isInteger(qty) || qty <= 0 || qty > maxQty) return res.status(400).json({ error: `Invalid replacement quantity for ${line.product_name}. Max replaceable: ${maxQty}` });

      const { rows: [product] } = await db.execute({ sql: 'SELECT id,name,stock_qty,cost FROM products WHERE id = ?', args: [line.product_id] });
      if (!product) return res.status(409).json({ error: `Replacement product ${line.product_id} no longer exists` });
      if (Number(product.stock_qty || 0) < qty) return res.status(409).json({ error: `Insufficient global stock to issue ${qty} replacement unit(s) of ${line.product_name}` });

      if (sale.branch_id) {
        const { rows: [branchStock] } = await db.execute({ sql: 'SELECT stock_qty FROM branch_inventory WHERE product_id = ? AND branch_id = ?', args: [line.product_id, sale.branch_id] });
        if (!branchStock || Number(branchStock.stock_qty || 0) < qty) return res.status(409).json({ error: `Insufficient branch stock to issue ${qty} replacement unit(s) of ${line.product_name}` });
      }

      const proportion = qty / Number(line.quantity || 1);
      const lineSubtotal = Number((Number(line.total || 0) * proportion).toFixed(2));
      const lineTax = Number((Number(line.tax_amount || 0) * proportion).toFixed(2));
      subtotal += lineSubtotal;
      tax += lineTax;
      prepared.push({ line, product, qty, lineSubtotal, lineTax });
    }

    subtotal = Number(subtotal.toFixed(2));
    tax = Number(tax.toFixed(2));
    const total = Number((subtotal + tax).toFixed(2));
    const returnNumber = await nextNumber(db, 'returns', 'return_number', 'RET-', 6);

    const tx = await db.transaction('write');
    let committed = false;
    try {
      const result = await tx.execute({ sql: `INSERT INTO returns
        (return_number,original_transaction_id,customer_id,employee_id,branch_id,resolution,subtotal,tax_amount,total,notes)
        VALUES (?,?,?,?,?,'replacement',?,?,?,?)`, args: [returnNumber, sale.id, sale.customer_id, employee_id || sale.employee_id, sale.branch_id, subtotal, tax, total, notes || null] });
      const returnId = Number(result.lastInsertRowid);

      for (const p of prepared) {
        const ri = await tx.execute({ sql: `INSERT INTO return_items
          (return_id,transaction_item_id,product_id,product_name,sku,quantity,unit_price,tax_amount,total,unit_cost_at_return)
          VALUES (?,?,?,?,?,?,?,?,?,?)`, args: [returnId, p.line.id, p.line.product_id, p.line.product_name, p.line.sku, p.qty, p.line.unit_price, p.lineTax, p.lineSubtotal, p.line.unit_cost_at_sale ?? null] });
        const returnItemId = Number(ri.lastInsertRowid);

        await tx.execute({ sql: `INSERT INTO return_quarantine
          (return_id,return_item_id,product_id,branch_id,quantity,unit_cost_at_return,disposition_status,disposition_notes)
          VALUES (?,?,?,?,?,?,'quarantine',?)`, args: [returnId, returnItemId, p.line.product_id, sale.branch_id || null, p.qty, p.line.unit_cost_at_sale ?? null, 'Returned unit withheld from sellable inventory pending inspection/disposition'] });

        await tx.execute({ sql: 'UPDATE products SET stock_qty = stock_qty - ? WHERE id = ?', args: [p.qty, p.line.product_id] });
        if (sale.branch_id) {
          await tx.execute({ sql: 'UPDATE branch_inventory SET stock_qty = stock_qty - ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND branch_id = ?', args: [p.qty, p.line.product_id, sale.branch_id] });
          await syncBinQty(tx, p.line.product_id, sale.branch_id, -p.qty);
        }
        await tx.execute({ sql: `INSERT INTO stock_movements(product_id,branch_id,quantity_change,type,reference,reason)
          VALUES (?,?,?,'replacement_issue',?,?)`, args: [p.line.product_id, sale.branch_id || null, -p.qty, returnNumber, `Like-for-like replacement issued for transaction ${sale.transaction_number}`] });
        await tx.execute({ sql: `INSERT INTO replacement_fulfillments
          (return_id,return_item_id,original_transaction_id,transaction_item_id,product_id,branch_id,quantity,unit_cost_at_issue,issued_by_employee_id)
          VALUES (?,?,?,?,?,?,?,?,?)`, args: [returnId, returnItemId, sale.id, p.line.id, p.line.product_id, sale.branch_id || null, p.qty, Number(p.product.cost || 0), employee_id || sale.employee_id || null] });
      }

      await tx.commit();
      committed = true;
      const { rows: [ret] } = await db.execute({ sql: 'SELECT * FROM returns WHERE id = ?', args: [returnId] });
      const { rows: retItems } = await db.execute({ sql: 'SELECT * FROM return_items WHERE return_id = ? ORDER BY id', args: [returnId] });
      const { rows: fulfillments } = await db.execute({ sql: 'SELECT * FROM replacement_fulfillments WHERE return_id = ? ORDER BY id', args: [returnId] });
      const { rows: quarantine } = await db.execute({ sql: 'SELECT * FROM return_quarantine WHERE return_id = ? ORDER BY id', args: [returnId] });
      res.status(201).json({ ...ret, items: retItems, replacement_fulfillments: fulfillments, quarantine });
    } catch (e) {
      if (!committed) await tx.rollback();
      res.status(committed ? 500 : 400).json({ error: e.message });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.ensureSchema = ensureSchema;
