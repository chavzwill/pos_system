const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission } = require('../lib/permissions');

let schemaReady = false;
async function ensureSchema() {
  if (schemaReady) return;
  await db.execute({ sql: `CREATE TABLE IF NOT EXISTS repair_timeline_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    work_order_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'internal',
    title TEXT NOT NULL,
    details TEXT,
    actor_employee_id INTEGER,
    source_entity_type TEXT,
    source_entity_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`, args: [] });
  await db.execute({ sql: 'CREATE INDEX IF NOT EXISTS idx_repair_timeline_work_order ON repair_timeline_events(work_order_id, created_at)', args: [] });
  await db.execute({ sql: `CREATE TABLE IF NOT EXISTS repair_diagnostics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    work_order_id INTEGER NOT NULL,
    fault_code TEXT,
    complaint TEXT,
    findings TEXT NOT NULL,
    recommended_action TEXT,
    severity TEXT NOT NULL DEFAULT 'normal',
    customer_visible INTEGER NOT NULL DEFAULT 0,
    technician_id INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`, args: [] });
  await db.execute({ sql: 'CREATE INDEX IF NOT EXISTS idx_repair_diagnostics_work_order ON repair_diagnostics(work_order_id, created_at)', args: [] });
  await db.execute({ sql: `CREATE TABLE IF NOT EXISTS repair_estimate_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    work_order_id INTEGER NOT NULL,
    revision_number INTEGER NOT NULL,
    reason TEXT,
    labor_amount REAL NOT NULL DEFAULT 0,
    parts_amount REAL NOT NULL DEFAULT 0,
    fees_amount REAL NOT NULL DEFAULT 0,
    tax_amount REAL NOT NULL DEFAULT 0,
    total_amount REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    created_by_employee_id INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    superseded_at TEXT,
    UNIQUE(work_order_id, revision_number)
  )`, args: [] });
  await db.execute({ sql: `CREATE TABLE IF NOT EXISTS repair_authorizations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    estimate_revision_id INTEGER NOT NULL,
    work_order_id INTEGER NOT NULL,
    decision TEXT NOT NULL,
    authorization_method TEXT NOT NULL,
    authorized_name TEXT,
    authorized_contact TEXT,
    notes TEXT,
    actor_employee_id INTEGER,
    decided_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`, args: [] });
  await db.execute({ sql: 'CREATE INDEX IF NOT EXISTS idx_repair_authorizations_work_order ON repair_authorizations(work_order_id, decided_at)', args: [] });
  schemaReady = true;
}

router.use(async (req, res, next) => {
  try { await ensureSchema(); next(); }
  catch (e) { res.status(500).json({ error: 'Repair authorization schema initialization failed', detail: e.message }); }
});

async function workOrderExists(id) {
  const { rows: [row] } = await db.execute({ sql: 'SELECT id, status FROM work_orders WHERE id = ?', args: [id] });
  return row;
}

router.get('/work-orders/:id', requirePermission('work_orders'), async (req, res) => {
  try {
    const wo = await workOrderExists(req.params.id);
    if (!wo) return res.status(404).json({ error: 'Work order not found' });
    const { rows: diagnostics } = await db.execute({ sql: `SELECT rd.*, e.first_name || ' ' || e.last_name AS technician_name
      FROM repair_diagnostics rd LEFT JOIN employees e ON e.id = rd.technician_id
      WHERE rd.work_order_id = ? ORDER BY rd.created_at DESC, rd.id DESC`, args: [req.params.id] });
    const { rows: estimates } = await db.execute({ sql: `SELECT rer.*, e.first_name || ' ' || e.last_name AS created_by_name,
      (SELECT decision FROM repair_authorizations ra WHERE ra.estimate_revision_id = rer.id ORDER BY ra.decided_at DESC, ra.id DESC LIMIT 1) AS latest_decision,
      (SELECT authorization_method FROM repair_authorizations ra WHERE ra.estimate_revision_id = rer.id ORDER BY ra.decided_at DESC, ra.id DESC LIMIT 1) AS latest_authorization_method,
      (SELECT decided_at FROM repair_authorizations ra WHERE ra.estimate_revision_id = rer.id ORDER BY ra.decided_at DESC, ra.id DESC LIMIT 1) AS latest_decided_at
      FROM repair_estimate_revisions rer LEFT JOIN employees e ON e.id = rer.created_by_employee_id
      WHERE rer.work_order_id = ? ORDER BY rer.revision_number DESC`, args: [req.params.id] });
    const { rows: authorizations } = await db.execute({ sql: `SELECT ra.*, e.first_name || ' ' || e.last_name AS actor_name
      FROM repair_authorizations ra LEFT JOIN employees e ON e.id = ra.actor_employee_id
      WHERE ra.work_order_id = ? ORDER BY ra.decided_at DESC, ra.id DESC`, args: [req.params.id] });
    res.json({ work_order: wo, diagnostics, estimates, authorizations });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/work-orders/:id/diagnostics', requirePermission('work_orders'), async (req, res) => {
  try {
    const wo = await workOrderExists(req.params.id);
    if (!wo) return res.status(404).json({ error: 'Work order not found' });
    const { fault_code, complaint, findings, recommended_action, severity = 'normal', customer_visible = false, technician_id } = req.body || {};
    if (!findings || !String(findings).trim()) return res.status(400).json({ error: 'findings are required' });
    const allowedSeverity = ['low','normal','high','critical'];
    if (!allowedSeverity.includes(severity)) return res.status(400).json({ error: 'Invalid severity' });
    const result = await db.execute({ sql: `INSERT INTO repair_diagnostics
      (work_order_id,fault_code,complaint,findings,recommended_action,severity,customer_visible,technician_id)
      VALUES (?,?,?,?,?,?,?,?)`, args: [req.params.id,fault_code||null,complaint||null,String(findings).trim(),recommended_action||null,severity,customer_visible?1:0,technician_id||req.user?.employee_id||null] });
    const id = Number(result.lastInsertRowid);
    await db.execute({ sql: `INSERT INTO repair_timeline_events (work_order_id,event_type,visibility,title,details,actor_employee_id,source_entity_type,source_entity_id)
      VALUES (?,?,?,?,?,?,?,?)`, args: [req.params.id,'diagnostic',customer_visible?'customer':'internal','Diagnostic findings recorded',String(findings).trim(),req.user?.employee_id||null,'repair_diagnostic',String(id)] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM repair_diagnostics WHERE id = ?', args: [id] });
    res.status(201).json(row);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/work-orders/:id/estimates', requirePermission('work_orders'), async (req, res) => {
  try {
    const wo = await workOrderExists(req.params.id);
    if (!wo) return res.status(404).json({ error: 'Work order not found' });
    const body = req.body || {};
    const labor = Number(body.labor_amount || 0);
    const parts = Number(body.parts_amount || 0);
    const fees = Number(body.fees_amount || 0);
    const tax = Number(body.tax_amount || 0);
    if ([labor,parts,fees,tax].some(v => !Number.isFinite(v) || v < 0)) return res.status(400).json({ error: 'Estimate amounts must be non-negative numbers' });
    const total = Math.round((labor + parts + fees + tax) * 100) / 100;
    const { rows: [maxRow] } = await db.execute({ sql: 'SELECT COALESCE(MAX(revision_number),0) AS max_revision FROM repair_estimate_revisions WHERE work_order_id = ?', args: [req.params.id] });
    const revision = Number(maxRow.max_revision || 0) + 1;
    await db.execute({ sql: `UPDATE repair_estimate_revisions SET status = 'superseded', superseded_at = CURRENT_TIMESTAMP
      WHERE work_order_id = ? AND status = 'pending'`, args: [req.params.id] });
    const result = await db.execute({ sql: `INSERT INTO repair_estimate_revisions
      (work_order_id,revision_number,reason,labor_amount,parts_amount,fees_amount,tax_amount,total_amount,status,created_by_employee_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, args: [req.params.id,revision,body.reason||null,labor,parts,fees,tax,total,'pending',req.user?.employee_id||null] });
    const id = Number(result.lastInsertRowid);
    await db.execute({ sql: `INSERT INTO repair_timeline_events (work_order_id,event_type,visibility,title,details,actor_employee_id,source_entity_type,source_entity_id)
      VALUES (?,?,?,?,?,?,?,?)`, args: [req.params.id,'estimate_revision','customer',`Estimate revision ${revision} created`,`Total: ${total.toFixed(2)}${body.reason ? ` — ${body.reason}` : ''}`,req.user?.employee_id||null,'repair_estimate_revision',String(id)] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM repair_estimate_revisions WHERE id = ?', args: [id] });
    res.status(201).json(row);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/estimates/:id/decision', requirePermission('work_orders'), async (req, res) => {
  try {
    const { rows: [estimate] } = await db.execute({ sql: 'SELECT * FROM repair_estimate_revisions WHERE id = ?', args: [req.params.id] });
    if (!estimate) return res.status(404).json({ error: 'Estimate revision not found' });
    if (estimate.status === 'superseded') return res.status(409).json({ error: 'A superseded estimate cannot be authorized' });
    const { decision, authorization_method, authorized_name, authorized_contact, notes } = req.body || {};
    if (!['approved','rejected'].includes(decision)) return res.status(400).json({ error: 'decision must be approved or rejected' });
    const methods = ['in_person','phone','email','sms','whatsapp','portal','other'];
    if (!methods.includes(authorization_method)) return res.status(400).json({ error: 'Invalid authorization_method' });
    const tx = await db.transaction('write');
    try {
      await tx.execute({ sql: `INSERT INTO repair_authorizations
        (estimate_revision_id,work_order_id,decision,authorization_method,authorized_name,authorized_contact,notes,actor_employee_id)
        VALUES (?,?,?,?,?,?,?,?)`, args: [estimate.id,estimate.work_order_id,decision,authorization_method,authorized_name||null,authorized_contact||null,notes||null,req.user?.employee_id||null] });
      await tx.execute({ sql: 'UPDATE repair_estimate_revisions SET status = ? WHERE id = ?', args: [decision, estimate.id] });
      await tx.execute({ sql: `INSERT INTO repair_timeline_events (work_order_id,event_type,visibility,title,details,actor_employee_id,source_entity_type,source_entity_id)
        VALUES (?,?,?,?,?,?,?,?)`, args: [estimate.work_order_id,'authorization','customer',`Estimate revision ${estimate.revision_number} ${decision}`,notes||`Authorization method: ${authorization_method}`,req.user?.employee_id||null,'repair_estimate_revision',String(estimate.id)] });
      await tx.commit();
    } catch (e) { await tx.rollback(); throw e; }
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM repair_estimate_revisions WHERE id = ?', args: [estimate.id] });
    res.json(row);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
