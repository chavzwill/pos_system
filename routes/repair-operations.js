const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission } = require('../lib/permissions');

let schemaReady = false;
async function ensureSchema() {
  if (schemaReady) return;
  await db.execute({ sql: `CREATE TABLE IF NOT EXISTS customer_equipment (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    branch_id INTEGER,
    equipment_type TEXT NOT NULL,
    brand TEXT,
    model TEXT,
    serial_number TEXT,
    asset_tag TEXT,
    purchase_date TEXT,
    warranty_expiry TEXT,
    warranty_status TEXT,
    notes TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`, args: [] });
  await db.execute({ sql: 'CREATE INDEX IF NOT EXISTS idx_customer_equipment_customer ON customer_equipment(customer_id)', args: [] });
  await db.execute({ sql: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_equipment_serial ON customer_equipment(serial_number) WHERE serial_number IS NOT NULL AND serial_number <> \'\'', args: [] });
  await db.execute({ sql: `CREATE TABLE IF NOT EXISTS repair_equipment_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    work_order_id INTEGER NOT NULL UNIQUE,
    equipment_id INTEGER NOT NULL,
    intake_condition TEXT,
    reported_issue TEXT,
    warranty_claim INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`, args: [] });
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
  schemaReady = true;
}

router.use(async (req, res, next) => {
  try { await ensureSchema(); next(); }
  catch (e) { res.status(500).json({ error: 'Repair operations schema initialization failed', detail: e.message }); }
});

router.get('/equipment', requirePermission('work_orders'), async (req, res) => {
  try {
    const { customer_id, q, active = '1', limit = 100 } = req.query;
    let sql = `SELECT ce.*, c.first_name || ' ' || c.last_name AS customer_name, b.name AS branch_name,
      (SELECT COUNT(*) FROM repair_equipment_links rel WHERE rel.equipment_id = ce.id) AS repair_count
      FROM customer_equipment ce
      LEFT JOIN customers c ON c.id = ce.customer_id
      LEFT JOIN branches b ON b.id = ce.branch_id
      WHERE 1=1`;
    const args = [];
    if (active !== 'all') { sql += ' AND ce.active = ?'; args.push(active === '0' ? 0 : 1); }
    if (customer_id) { sql += ' AND ce.customer_id = ?'; args.push(customer_id); }
    if (q) {
      sql += ` AND (ce.equipment_type LIKE ? OR ce.brand LIKE ? OR ce.model LIKE ? OR ce.serial_number LIKE ? OR ce.asset_tag LIKE ? OR c.first_name LIKE ? OR c.last_name LIKE ?)`;
      const s = `%${q}%`; args.push(s,s,s,s,s,s,s);
    }
    sql += ' ORDER BY ce.updated_at DESC LIMIT ?'; args.push(Math.min(Math.max(parseInt(limit) || 100, 1), 500));
    const { rows } = await db.execute({ sql, args });
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/equipment', requirePermission('work_orders'), async (req, res) => {
  try {
    const { customer_id, branch_id, equipment_type, brand, model, serial_number, asset_tag, purchase_date, warranty_expiry, warranty_status, notes } = req.body || {};
    if (!customer_id || !equipment_type || !String(equipment_type).trim()) return res.status(400).json({ error: 'customer_id and equipment_type are required' });
    const result = await db.execute({ sql: `INSERT INTO customer_equipment
      (customer_id,branch_id,equipment_type,brand,model,serial_number,asset_tag,purchase_date,warranty_expiry,warranty_status,notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, args: [customer_id,branch_id||null,String(equipment_type).trim(),brand||null,model||null,serial_number||null,asset_tag||null,purchase_date||null,warranty_expiry||null,warranty_status||null,notes||null] });
    const id = Number(result.lastInsertRowid);
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM customer_equipment WHERE id = ?', args: [id] });
    res.status(201).json(row);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.patch('/equipment/:id', requirePermission('work_orders'), async (req, res) => {
  try {
    const allowed = ['customer_id','branch_id','equipment_type','brand','model','serial_number','asset_tag','purchase_date','warranty_expiry','warranty_status','notes','active'];
    const fields = []; const args = [];
    for (const key of allowed) if (Object.prototype.hasOwnProperty.call(req.body || {}, key)) { fields.push(`${key} = ?`); args.push(req.body[key]); }
    if (!fields.length) return res.status(400).json({ error: 'No supported fields supplied' });
    fields.push('updated_at = CURRENT_TIMESTAMP'); args.push(req.params.id);
    await db.execute({ sql: `UPDATE customer_equipment SET ${fields.join(', ')} WHERE id = ?`, args });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM customer_equipment WHERE id = ?', args: [req.params.id] });
    if (!row) return res.status(404).json({ error: 'Equipment not found' });
    res.json(row);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/equipment/:id/history', requirePermission('work_orders'), async (req, res) => {
  try {
    const { rows: [equipment] } = await db.execute({ sql: 'SELECT * FROM customer_equipment WHERE id = ?', args: [req.params.id] });
    if (!equipment) return res.status(404).json({ error: 'Equipment not found' });
    const { rows: repairs } = await db.execute({ sql: `SELECT wo.*, rel.intake_condition, rel.reported_issue, rel.warranty_claim
      FROM repair_equipment_links rel JOIN work_orders wo ON wo.id = rel.work_order_id
      WHERE rel.equipment_id = ? ORDER BY wo.created_at DESC`, args: [req.params.id] });
    res.json({ equipment, repairs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/work-orders/:id/equipment', requirePermission('work_orders'), async (req, res) => {
  try {
    const { equipment_id, intake_condition, reported_issue, warranty_claim } = req.body || {};
    if (!equipment_id) return res.status(400).json({ error: 'equipment_id is required' });
    const { rows: [wo] } = await db.execute({ sql: 'SELECT id FROM work_orders WHERE id = ?', args: [req.params.id] });
    if (!wo) return res.status(404).json({ error: 'Work order not found' });
    const { rows: [eq] } = await db.execute({ sql: 'SELECT id FROM customer_equipment WHERE id = ?', args: [equipment_id] });
    if (!eq) return res.status(404).json({ error: 'Equipment not found' });
    await db.execute({ sql: `INSERT INTO repair_equipment_links (work_order_id,equipment_id,intake_condition,reported_issue,warranty_claim)
      VALUES (?,?,?,?,?) ON CONFLICT(work_order_id) DO UPDATE SET equipment_id=excluded.equipment_id,intake_condition=excluded.intake_condition,reported_issue=excluded.reported_issue,warranty_claim=excluded.warranty_claim,updated_at=CURRENT_TIMESTAMP`,
      args: [req.params.id,equipment_id,intake_condition||null,reported_issue||null,warranty_claim?1:0] });
    await db.execute({ sql: `INSERT INTO repair_timeline_events (work_order_id,event_type,visibility,title,details,actor_employee_id,source_entity_type,source_entity_id)
      VALUES (?,?,?,?,?,?,?,?)`, args: [req.params.id,'equipment_linked','internal','Equipment linked to repair',reported_issue||null,req.user?.employee_id||null,'equipment',String(equipment_id)] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM repair_equipment_links WHERE work_order_id = ?', args: [req.params.id] });
    res.json(row);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/work-orders/:id/timeline', requirePermission('work_orders'), async (req, res) => {
  try {
    const { rows } = await db.execute({ sql: `SELECT rte.*, e.first_name || ' ' || e.last_name AS actor_name
      FROM repair_timeline_events rte LEFT JOIN employees e ON e.id = rte.actor_employee_id
      WHERE rte.work_order_id = ? ORDER BY rte.created_at DESC, rte.id DESC`, args: [req.params.id] });
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/work-orders/:id/timeline', requirePermission('work_orders'), async (req, res) => {
  try {
    const { event_type = 'note', visibility = 'internal', title, details, source_entity_type, source_entity_id } = req.body || {};
    if (!title || !String(title).trim()) return res.status(400).json({ error: 'title is required' });
    if (!['internal','customer'].includes(visibility)) return res.status(400).json({ error: 'visibility must be internal or customer' });
    const result = await db.execute({ sql: `INSERT INTO repair_timeline_events (work_order_id,event_type,visibility,title,details,actor_employee_id,source_entity_type,source_entity_id)
      VALUES (?,?,?,?,?,?,?,?)`, args: [req.params.id,event_type,visibility,String(title).trim(),details||null,req.user?.employee_id||null,source_entity_type||null,source_entity_id||null] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM repair_timeline_events WHERE id = ?', args: [Number(result.lastInsertRowid)] });
    res.status(201).json(row);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
