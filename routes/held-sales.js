const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requireAuth, requirePermission } = require('../lib/permissions');

router.use(requireAuth);

router.get('/', requirePermission('pos_hold'), async (req, res) => {
  try {
    const { branch_id, limit = 100 } = req.query;
    let sql = `SELECT t.id,t.transaction_number,t.customer_id,t.employee_id,t.branch_id,t.subtotal,t.tax_amount,t.discount_amount,t.total,t.notes,t.created_at,
      c.first_name || ' ' || c.last_name AS customer_name,c.phone AS customer_phone,c.email AS customer_email,
      b.name AS branch_name,e.first_name || ' ' || e.last_name AS employee_name,
      (SELECT COUNT(*) FROM transaction_items ti WHERE ti.transaction_id=t.id) AS item_count
      FROM transactions t
      LEFT JOIN customers c ON c.id=t.customer_id
      LEFT JOIN branches b ON b.id=t.branch_id
      LEFT JOIN employees e ON e.id=t.employee_id
      WHERE t.status='hold'`;
    const args = [];
    if (branch_id) { sql += ' AND t.branch_id=?'; args.push(branch_id); }
    sql += ' ORDER BY t.created_at ASC LIMIT ?';
    args.push(Math.min(Math.max(parseInt(limit) || 100, 1), 250));
    const { rows } = await db.execute({ sql, args });
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', requirePermission('pos_hold'), async (req, res) => {
  try {
    const { rows: [held] } = await db.execute({
      sql: `SELECT t.*,c.first_name,c.last_name,c.customer_number,c.phone AS customer_phone,c.email AS customer_email,c.customer_type,c.account_blocked,
        b.name AS branch_name,e.first_name || ' ' || e.last_name AS employee_name
        FROM transactions t
        LEFT JOIN customers c ON c.id=t.customer_id
        LEFT JOIN branches b ON b.id=t.branch_id
        LEFT JOIN employees e ON e.id=t.employee_id
        WHERE t.id=? AND t.status='hold'`,
      args: [req.params.id]
    });
    if (!held) return res.status(404).json({ error: 'Held sale not found' });
    const { rows: items } = await db.execute({
      sql: `SELECT ti.*,p.tax_rate,p.active,p.is_service,p.is_rental,
        COALESCE(bi.stock_qty,p.stock_qty,0) AS current_stock_qty
        FROM transaction_items ti
        LEFT JOIN products p ON p.id=ti.product_id
        LEFT JOIN branch_inventory bi ON bi.product_id=ti.product_id AND bi.branch_id=?
        WHERE ti.transaction_id=? ORDER BY ti.id`,
      args: [held.branch_id || -1, held.id]
    });
    held.items = items;
    res.json(held);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', requirePermission('pos_hold'), async (req, res) => {
  try {
    const tx = await db.transaction('write');
    try {
      const { rows: [held] } = await tx.execute({ sql: `SELECT id FROM transactions WHERE id=? AND status='hold'`, args: [req.params.id] });
      if (!held) { await tx.rollback(); return res.status(404).json({ error: 'Held sale not found' }); }
      await tx.execute({ sql: `UPDATE quotations SET status='accepted',converted_to_tx=NULL WHERE converted_to_tx=?`, args: [req.params.id] });
      await tx.execute({ sql: 'DELETE FROM transaction_items WHERE transaction_id=?', args: [req.params.id] });
      await tx.execute({ sql: 'DELETE FROM transactions WHERE id=?', args: [req.params.id] });
      await tx.commit();
      res.json({ success: true });
    } catch (e) { await tx.rollback(); throw e; }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/finalize', requirePermission('pos_hold'), async (req, res) => {
  try {
    const completedId = parseInt(req.body?.completed_transaction_id);
    if (!completedId) return res.status(400).json({ error: 'Completed transaction id is required' });
    const tx = await db.transaction('write');
    try {
      const { rows: [held] } = await tx.execute({ sql: `SELECT * FROM transactions WHERE id=? AND status='hold'`, args: [req.params.id] });
      if (!held) { await tx.rollback(); return res.status(404).json({ error: 'Held sale not found or already finalized' }); }
      const { rows: [completed] } = await tx.execute({ sql: `SELECT * FROM transactions WHERE id=? AND status='completed'`, args: [completedId] });
      if (!completed) { await tx.rollback(); return res.status(400).json({ error: 'Replacement transaction is not a completed sale' }); }
      if (String(completed.branch_id || '') !== String(held.branch_id || '')) { await tx.rollback(); return res.status(400).json({ error: 'Completed sale must belong to the same branch as the held sale' }); }
      await tx.execute({ sql: `UPDATE quotations SET status='converted',converted_to_tx=? WHERE converted_to_tx=?`, args: [completedId, held.id] });
      await tx.execute({ sql: 'DELETE FROM transaction_items WHERE transaction_id=?', args: [held.id] });
      await tx.execute({ sql: 'DELETE FROM transactions WHERE id=?', args: [held.id] });
      await tx.commit();
      res.json({ success: true, completed_transaction_id: completedId });
    } catch (e) { await tx.rollback(); throw e; }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
