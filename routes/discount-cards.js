const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requireAuth, requirePermission } = require('../lib/permissions');

// List all discount card types — requireAuth only (not requirePermission),
// since the customer form (gated by the `customers` permission, not
// `discount-cards`) needs this list to populate its Card Type dropdown.
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.execute({ sql: `SELECT dct.*,
      (SELECT COUNT(*) FROM customers WHERE discount_card_type_id = dct.id) as customer_count
      FROM discount_card_types dct ORDER BY dct.name`, args: [] });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/', requirePermission('discount-cards'), async (req, res) => {
  try {
    const { name, discount_percent, active } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const result = await db.execute({ sql: 'INSERT INTO discount_card_types (name, discount_percent, active) VALUES (?,?,?)', args: [name, parseFloat(discount_percent) || 0, active !== false ? 1 : 0] });
    res.status(201).json({ id: Number(result.lastInsertRowid) });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

router.put('/:id', requirePermission('discount-cards'), async (req, res) => {
  try {
    const { name, discount_percent, active } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    await db.execute({ sql: 'UPDATE discount_card_types SET name=?, discount_percent=?, active=? WHERE id=?', args: [name, parseFloat(discount_percent) || 0, active ? 1 : 0, req.params.id] });
    res.json({ success: true });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// Blocked while any customer still carries this card type — deactivating is
// the intended way to retire a type still in use (clear the checkout
// application without breaking the customer records that reference it).
router.delete('/:id', requirePermission('discount-cards'), async (req, res) => {
  try {
    const { rows: [{ c }] } = await db.execute({ sql: 'SELECT COUNT(*) as c FROM customers WHERE discount_card_type_id = ?', args: [req.params.id] });
    if (c > 0) return res.status(400).json({ error: `${c} customer(s) still have this card type — deactivate it instead, or clear it from those customer profiles first.` });
    await db.execute({ sql: 'DELETE FROM discount_card_types WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
