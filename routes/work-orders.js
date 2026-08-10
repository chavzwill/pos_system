const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission, requireAnyPermission } = require('../lib/permissions');
const { nextNumber } = require('../lib/nextNumber');

// Statuses a WO can freely log a comment against via PATCH /:id/status without
// going through a dedicated money-moving endpoint (assessment-paid,
// deposit-paid, signoff each own their own transition below). 'in_progress'
// and 'awaiting_signoff' are the two phases a technician/supervisor actually
// works from day to day.
const FREE_STATUS_TRANSITIONS = ['in_progress', 'awaiting_signoff'];

async function logStatus(executor, workOrderId, status, comment, employeeId) {
  await executor.execute({ sql: 'INSERT INTO work_order_status_log (work_order_id, status, comment, employee_id) VALUES (?,?,?,?)', args: [workOrderId, status, comment || null, employeeId || null] });
}

const WO_LIST_SELECT = `SELECT wo.*, c.first_name || ' ' || c.last_name as customer_name, c.phone as customer_phone, c.email as customer_email,
  e.first_name || ' ' || e.last_name as employee_name, b.name as branch_name,
  cb.first_name || ' ' || cb.last_name as completed_by_name,
  julianday('now') - julianday(wo.pickup_due_date) as days_past_pickup_due
  FROM work_orders wo
  LEFT JOIN customers c ON wo.customer_id = c.id
  LEFT JOIN employees e ON wo.employee_id = e.id
  LEFT JOIN branches b ON wo.branch_id = b.id
  LEFT JOIN employees cb ON wo.completed_by = cb.id`;

router.get('/', requirePermission('work_orders'), async (req, res) => {
  try {
    const { status, view, customer_id, branch_id, limit = 200 } = req.query;
    let sql = `${WO_LIST_SELECT} WHERE 1=1`;
    const params = [];
    if (view === 'active') { sql += " AND wo.status NOT IN ('picked_up','cancelled')"; }
    else if (view === 'awaiting_pickup') { sql += " AND wo.status = 'awaiting_pickup'"; }
    else if (status) { sql += ' AND wo.status = ?'; params.push(status); }
    if (customer_id) { sql += ' AND wo.customer_id = ?'; params.push(customer_id); }
    if (branch_id) { sql += ' AND wo.branch_id = ?'; params.push(branch_id); }
    sql += ' ORDER BY wo.created_at DESC LIMIT ?';
    params.push(parseInt(limit));
    const { rows } = await db.execute({ sql, args: params });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', requirePermission('work_orders'), async (req, res) => {
  try {
    const { rows: [wo] } = await db.execute({ sql: `${WO_LIST_SELECT} WHERE wo.id = ?`, args: [req.params.id] });
    if (!wo) return res.status(404).json({ error: 'Not found' });
    const { rows: statusLog } = await db.execute({ sql: `SELECT wsl.*, e.first_name || ' ' || e.last_name as employee_name FROM work_order_status_log wsl LEFT JOIN employees e ON wsl.employee_id = e.id WHERE wsl.work_order_id = ? ORDER BY wsl.id`, args: [req.params.id] });
    wo.status_log = statusLog;
    res.json(wo);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Intake ─────────────────────────────────────────────────────────────────

router.post('/', requirePermission('wo_intake'), async (req, res) => {
  try {
    const { customer_id, employee_id, branch_id, description, item_label } = req.body;
    if (!customer_id) return res.status(400).json({ error: 'A customer is required' });
    if (!description || !description.trim()) return res.status(400).json({ error: 'A description is required' });

    const { rows: [feeSetting] } = await db.execute({ sql: "SELECT value FROM settings WHERE key = 'wo_assessment_fee'", args: [] });
    const assessmentFee = parseFloat(feeSetting?.value) || 0;

    const wo_number = await nextNumber(db, 'work_orders', 'wo_number', 'WO-', 6);
    const tx = await db.transaction('write');
    let committed = false;
    try {
      const result = await tx.execute({ sql: `INSERT INTO work_orders (wo_number, customer_id, employee_id, branch_id, description, item_label, assessment_fee, pickup_due_date)
        VALUES (?,?,?,?,?,?,?, date('now','+30 days'))`, args: [wo_number, customer_id, employee_id || null, branch_id || null, description.trim(), item_label || null, assessmentFee] });
      const woId = Number(result.lastInsertRowid);
      await logStatus(tx, woId, 'intake', 'Work order opened', employee_id);
      await tx.commit();
      committed = true;
      const { rows: [wo] } = await db.execute({ sql: `${WO_LIST_SELECT} WHERE wo.id = ?`, args: [woId] });
      res.status(201).json(wo);
    } catch(e) {
      if (!committed) await tx.rollback();
      res.status(committed ? 500 : 400).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Editable any time before completion — explicitly requested so an initial
// intake note can be corrected/expanded once the item's actually been looked
// at. Logs a status-log comment (no status change) so the edit is visible in
// the history the service rep sees, not just silently overwritten.
router.patch('/:id', requirePermission('work_orders'), async (req, res) => {
  try {
    const { description, item_label, employee_id } = req.body;
    const { rows: [wo] } = await db.execute({ sql: 'SELECT * FROM work_orders WHERE id = ?', args: [req.params.id] });
    if (!wo) return res.status(404).json({ error: 'Not found' });
    if (['complete', 'awaiting_pickup', 'picked_up', 'cancelled'].includes(wo.status)) return res.status(400).json({ error: `Cannot edit a ${wo.status} work order` });
    if (description != null && !description.trim()) return res.status(400).json({ error: 'Description cannot be empty' });

    const newDescription = description != null ? description.trim() : wo.description;
    await db.execute({ sql: 'UPDATE work_orders SET description = ?, item_label = ? WHERE id = ?', args: [newDescription, item_label != null ? item_label : wo.item_label, req.params.id] });
    if (description != null && description.trim() !== wo.description) {
      await logStatus(db, req.params.id, wo.status, `Description updated: ${description.trim()}`, employee_id);
    }
    const { rows: [updated] } = await db.execute({ sql: `${WO_LIST_SELECT} WHERE wo.id = ?`, args: [req.params.id] });
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id/label', async (req, res) => {
  try {
    const { rows: [wo] } = await db.execute({ sql: `${WO_LIST_SELECT} WHERE wo.id = ?`, args: [req.params.id] });
    if (!wo) return res.status(404).send('Not found');
    res.json(wo); // frontend renders the printable label itself, same as printRentalDeliveryNote
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Assessment fee (charged at intake, before the item is assessed) ──────

// No pre-existing "hold" transaction row — mirrors how rental checkout works
// (rental_agreements.status IS the held state; the transaction is created
// fresh right here, at finalize time), not the quote-convert pattern (which
// creates a literal status='hold' transactions row up front). A WO's
// "held" state is just its own status='intake', which is what the POS Hold
// Recall list below queries against.
router.patch('/:id/assessment-paid', requireAnyPermission('wo_assess', 'pos'), async (req, res) => {
  try {
    const { payment_method, amount_tendered, employee_id, drawer_session_id, branch_id } = req.body;
    const { rows: [wo] } = await db.execute({ sql: 'SELECT * FROM work_orders WHERE id = ?', args: [req.params.id] });
    if (!wo) return res.status(404).json({ error: 'Not found' });
    if (wo.status !== 'intake') return res.status(400).json({ error: `This work order is ${wo.status}, not awaiting the assessment fee` });

    const method = payment_method || 'cash';
    const total = wo.assessment_fee;
    const tendered = parseFloat(amount_tendered || total);
    const changeAmt = Math.max(0, parseFloat((tendered - total).toFixed(2)));
    const transaction_number = await nextNumber(db, 'transactions', 'transaction_number', 'TXN-', 6);

    const tx = await db.transaction('write');
    let committed = false;
    try {
      const txResult = await tx.execute({ sql: `INSERT INTO transactions (transaction_number,customer_id,employee_id,branch_id,drawer_session_id,subtotal,tax_amount,total,payment_method,amount_tendered,change_amount,notes,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, args: [transaction_number, wo.customer_id, employee_id || null, branch_id || wo.branch_id || null, drawer_session_id || null, total, 0, total, method, tendered, changeAmt, `Work order assessment fee ${wo.wo_number}`, 'pos'] });
      const txId = Number(txResult.lastInsertRowid);
      await tx.execute({ sql: `INSERT INTO transaction_items (transaction_id,product_name,sku,quantity,unit_price,tax_amount,total) VALUES (?,?,?,?,?,?,?)`, args: [txId, 'Assessment Fee', 'WO-ASSESS', 1, total, 0, total] });
      await tx.execute({ sql: `UPDATE work_orders SET assessment_transaction_id = ?, status = 'assessed' WHERE id = ?`, args: [txId, req.params.id] });
      await logStatus(tx, req.params.id, 'assessed', `Assessment fee paid (${method})`, employee_id);
      await tx.commit();
      committed = true;
      const { rows: [updated] } = await db.execute({ sql: `${WO_LIST_SELECT} WHERE wo.id = ?`, args: [req.params.id] });
      res.json(updated);
    } catch(e) {
      if (!committed) await tx.rollback();
      res.status(committed ? 500 : 400).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Estimate + deposit ─────────────────────────────────────────────────────

router.patch('/:id/estimate', requirePermission('wo_assess'), async (req, res) => {
  try {
    const { estimate_labor, estimate_consumables, estimate_notes, deposit_amount, employee_id } = req.body;
    const { rows: [wo] } = await db.execute({ sql: 'SELECT * FROM work_orders WHERE id = ?', args: [req.params.id] });
    if (!wo) return res.status(404).json({ error: 'Not found' });
    if (wo.status !== 'assessed') return res.status(400).json({ error: `This work order is ${wo.status}, not awaiting an estimate` });
    const deposit = parseFloat(deposit_amount) || 0;
    if (deposit <= 0) return res.status(400).json({ error: 'A deposit amount is required' });

    await db.execute({ sql: `UPDATE work_orders SET estimate_labor = ?, estimate_consumables = ?, estimate_notes = ?, deposit_amount = ?, status = 'pending_deposit' WHERE id = ?`,
      args: [parseFloat(estimate_labor) || 0, parseFloat(estimate_consumables) || 0, estimate_notes || null, deposit, req.params.id] });
    await logStatus(db, req.params.id, 'pending_deposit', `Estimate entered — labor ${estimate_labor||0}, consumables ${estimate_consumables||0}, deposit due ${deposit}`, employee_id);
    const { rows: [updated] } = await db.execute({ sql: `${WO_LIST_SELECT} WHERE wo.id = ?`, args: [req.params.id] });
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.patch('/:id/deposit-paid', requireAnyPermission('wo_assess', 'pos'), async (req, res) => {
  try {
    const { payment_method, amount_tendered, employee_id, drawer_session_id, branch_id } = req.body;
    const { rows: [wo] } = await db.execute({ sql: 'SELECT * FROM work_orders WHERE id = ?', args: [req.params.id] });
    if (!wo) return res.status(404).json({ error: 'Not found' });
    if (wo.status !== 'pending_deposit') return res.status(400).json({ error: `This work order is ${wo.status}, not awaiting the deposit` });

    const method = payment_method || 'cash';
    const total = wo.deposit_amount;
    const tendered = parseFloat(amount_tendered || total);
    const changeAmt = Math.max(0, parseFloat((tendered - total).toFixed(2)));
    const transaction_number = await nextNumber(db, 'transactions', 'transaction_number', 'TXN-', 6);

    const tx = await db.transaction('write');
    let committed = false;
    try {
      const txResult = await tx.execute({ sql: `INSERT INTO transactions (transaction_number,customer_id,employee_id,branch_id,drawer_session_id,subtotal,tax_amount,total,payment_method,amount_tendered,change_amount,notes,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, args: [transaction_number, wo.customer_id, employee_id || null, branch_id || wo.branch_id || null, drawer_session_id || null, total, 0, total, method, tendered, changeAmt, `Work order deposit ${wo.wo_number}`, 'pos'] });
      const txId = Number(txResult.lastInsertRowid);
      await tx.execute({ sql: `INSERT INTO transaction_items (transaction_id,product_name,sku,quantity,unit_price,tax_amount,total) VALUES (?,?,?,?,?,?,?)`, args: [txId, 'Deposit', 'WO-DEPOSIT', 1, total, 0, total] });
      await tx.execute({ sql: `UPDATE work_orders SET deposit_transaction_id = ?, status = 'in_progress' WHERE id = ?`, args: [txId, req.params.id] });
      await logStatus(tx, req.params.id, 'in_progress', `Deposit paid (${method})`, employee_id);
      await tx.commit();
      committed = true;
      const { rows: [updated] } = await db.execute({ sql: `${WO_LIST_SELECT} WHERE wo.id = ?`, args: [req.params.id] });
      res.json(updated);
    } catch(e) {
      if (!committed) await tx.rollback();
      res.status(committed ? 500 : 400).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Free status/comment updates + cancel ──────────────────────────────────

router.patch('/:id/status', requirePermission('work_orders'), async (req, res) => {
  try {
    const { status, comment, employee_id } = req.body;
    const { rows: [wo] } = await db.execute({ sql: 'SELECT * FROM work_orders WHERE id = ?', args: [req.params.id] });
    if (!wo) return res.status(404).json({ error: 'Not found' });
    if (!comment || !comment.trim()) return res.status(400).json({ error: 'A comment is required' });
    let newStatus = wo.status;
    if (status && status !== wo.status) {
      if (!FREE_STATUS_TRANSITIONS.includes(status)) return res.status(400).json({ error: `Cannot set status to ${status} directly — use the dedicated action for that step` });
      if (wo.status !== 'in_progress') return res.status(400).json({ error: `This work order is ${wo.status}, not in progress` });
      newStatus = status;
      await db.execute({ sql: 'UPDATE work_orders SET status = ? WHERE id = ?', args: [newStatus, req.params.id] });
    }
    await logStatus(db, req.params.id, newStatus, comment.trim(), employee_id);
    const { rows: [updated] } = await db.execute({ sql: `${WO_LIST_SELECT} WHERE wo.id = ?`, args: [req.params.id] });
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.patch('/:id/cancel', requirePermission('work_orders'), async (req, res) => {
  try {
    const { reason, employee_id } = req.body;
    if (!reason || !reason.trim()) return res.status(400).json({ error: 'A cancellation reason is required' });
    const { rows: [wo] } = await db.execute({ sql: 'SELECT * FROM work_orders WHERE id = ?', args: [req.params.id] });
    if (!wo) return res.status(404).json({ error: 'Not found' });
    if (['in_progress', 'awaiting_signoff', 'complete', 'awaiting_pickup', 'picked_up', 'cancelled'].includes(wo.status)) {
      return res.status(400).json({ error: `Cannot cancel a work order that's already ${wo.status} — the deposit has been collected and work has started` });
    }
    await db.execute({ sql: `UPDATE work_orders SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP, cancellation_reason = ? WHERE id = ?`, args: [reason.trim(), req.params.id] });
    await logStatus(db, req.params.id, 'cancelled', reason.trim(), employee_id);
    const { rows: [updated] } = await db.execute({ sql: `${WO_LIST_SELECT} WHERE wo.id = ?`, args: [req.params.id] });
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
