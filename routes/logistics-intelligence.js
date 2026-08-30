const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission } = require('../lib/permissions');

let schemaReady = false;
async function ensureSchema() {
  if (schemaReady) return;
  await db.execute({ sql: `CREATE TABLE IF NOT EXISTS dispatch_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_number TEXT NOT NULL UNIQUE,
    source_type TEXT NOT NULL,
    source_id INTEGER,
    branch_id INTEGER,
    origin_label TEXT NOT NULL,
    destination_label TEXT NOT NULL,
    job_type TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'normal',
    status TEXT NOT NULL DEFAULT 'unassigned',
    promised_at TEXT,
    scheduled_for TEXT,
    assignee_employee_id INTEGER,
    vehicle_label TEXT,
    stop_sequence INTEGER,
    estimated_minutes INTEGER,
    actual_departed_at TEXT,
    completed_at TEXT,
    notes TEXT,
    created_by_employee_id INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`, args: [] });
  await db.execute({ sql: 'CREATE INDEX IF NOT EXISTS idx_dispatch_jobs_status ON dispatch_jobs(status, promised_at, scheduled_for)', args: [] });
  await db.execute({ sql: 'CREATE INDEX IF NOT EXISTS idx_dispatch_jobs_source ON dispatch_jobs(source_type, source_id)', args: [] });
  await db.execute({ sql: `CREATE TABLE IF NOT EXISTS dispatch_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dispatch_job_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    old_status TEXT,
    new_status TEXT,
    details TEXT,
    actor_employee_id INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`, args: [] });
  await db.execute({ sql: 'CREATE INDEX IF NOT EXISTS idx_dispatch_events_job ON dispatch_events(dispatch_job_id, created_at)', args: [] });
  schemaReady = true;
}

router.use(async (req, res, next) => {
  try { await ensureSchema(); next(); }
  catch (e) { res.status(500).json({ error: 'Logistics intelligence schema initialization failed', detail: e.message }); }
});

router.use(require('./logistics-commercial-handoff'));
router.use(require('./logistics-field-execution'));

function jobNumber() { return `DSP-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2,6).toUpperCase()}`; }
function nowMs() { return Date.now(); }
function scoreJob(row) {
  let score = 0;
  const reasons = [];
  if (row.priority === 'urgent') { score += 40; reasons.push('urgent priority'); }
  else if (row.priority === 'high') { score += 25; reasons.push('high priority'); }
  if (!row.assignee_employee_id) { score += 15; reasons.push('unassigned'); }
  if (!row.scheduled_for) { score += 10; reasons.push('not scheduled'); }
  const due = row.promised_at ? new Date(row.promised_at).getTime() : null;
  if (due && Number.isFinite(due)) {
    const hours = (due - nowMs()) / 3600000;
    if (hours < 0) { score += 50; reasons.push('past promised time'); }
    else if (hours <= 4) { score += 35; reasons.push('due within 4 hours'); }
    else if (hours <= 24) { score += 20; reasons.push('due within 24 hours'); }
  }
  if (row.status === 'in_transit') { score += 8; reasons.push('already in transit'); }
  return { score, reasons };
}

router.get('/command-center', requirePermission('transfers'), async (req, res) => {
  try {
    const { branch_id } = req.query;
    const args = [];
    let sql = `SELECT dj.*, e.first_name || ' ' || e.last_name AS assignee_name, b.name AS branch_name,
      de.stage AS execution_stage, de.driver_employee_id, de.vehicle_id, dv.vehicle_number, dv.registration_number
      FROM dispatch_jobs dj
      LEFT JOIN employees e ON e.id = dj.assignee_employee_id
      LEFT JOIN branches b ON b.id = dj.branch_id
      LEFT JOIN dispatch_executions de ON de.dispatch_job_id = dj.id
      LEFT JOIN dispatch_vehicles dv ON dv.id = de.vehicle_id
      WHERE dj.status NOT IN ('completed','cancelled')`;
    if (branch_id) { sql += ' AND dj.branch_id = ?'; args.push(branch_id); }
    sql += ' ORDER BY COALESCE(dj.promised_at, dj.scheduled_for, dj.created_at), dj.created_at';
    let jobs;
    try { ({ rows: jobs } = await db.execute({ sql, args })); }
    catch (e) {
      let fallback = `SELECT dj.*, e.first_name || ' ' || e.last_name AS assignee_name, b.name AS branch_name
        FROM dispatch_jobs dj LEFT JOIN employees e ON e.id=dj.assignee_employee_id LEFT JOIN branches b ON b.id=dj.branch_id
        WHERE dj.status NOT IN ('completed','cancelled')`;
      const fallbackArgs=[]; if(branch_id){fallback+=' AND dj.branch_id=?';fallbackArgs.push(branch_id);} fallback+=' ORDER BY COALESCE(dj.promised_at,dj.scheduled_for,dj.created_at),dj.created_at';
      ({rows:jobs}=await db.execute({sql:fallback,args:fallbackArgs}));
    }

    const enriched = jobs.map(j => ({ ...j, intelligence: scoreJob(j) })).sort((a,b) => b.intelligence.score - a.intelligence.score);
    const summary = {
      open_jobs: enriched.length,
      unassigned: enriched.filter(j => !j.assignee_employee_id).length,
      unscheduled: enriched.filter(j => !j.scheduled_for).length,
      in_transit: enriched.filter(j => j.status === 'in_transit').length,
      at_risk: enriched.filter(j => j.intelligence.score >= 35).length,
    };

    const transferArgs = [];
    let transferSql = `SELECT t.id, t.transfer_number, t.status, t.created_at, fb.name AS from_branch_name, tb.name AS to_branch_name,
      (SELECT COUNT(*) FROM dispatch_jobs dj WHERE dj.source_type='branch_transfer' AND dj.source_id=t.id AND dj.status NOT IN ('cancelled')) AS dispatch_job_count
      FROM branch_transfers t
      JOIN branches fb ON fb.id=t.from_branch_id
      JOIN branches tb ON tb.id=t.to_branch_id
      WHERE t.status IN ('pending','in_transit')`;
    if (branch_id) { transferSql += ' AND (t.from_branch_id=? OR t.to_branch_id=?)'; transferArgs.push(branch_id, branch_id); }
    transferSql += ' ORDER BY t.created_at ASC LIMIT 100';
    const { rows: transfers } = await db.execute({ sql: transferSql, args: transferArgs });
    const uncovered_transfers = transfers.filter(t => Number(t.dispatch_job_count || 0) === 0);

    res.json({
      summary,
      jobs: enriched,
      uncovered_transfers,
      routing_note: 'Priority sequencing uses verified deadlines, assignment state and operational status. Road-distance optimization requires geocoded addresses and is intentionally not fabricated.',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/jobs', requirePermission('transfers'), async (req, res) => {
  try {
    const body = req.body || {};
    const required = ['source_type','origin_label','destination_label','job_type'];
    for (const key of required) if (!body[key] || !String(body[key]).trim()) return res.status(400).json({ error: `${key} is required` });
    if (!['low','normal','high','urgent'].includes(body.priority || 'normal')) return res.status(400).json({ error: 'Invalid priority' });
    const number = jobNumber();
    const result = await db.execute({ sql: `INSERT INTO dispatch_jobs
      (job_number,source_type,source_id,branch_id,origin_label,destination_label,job_type,priority,status,promised_at,scheduled_for,assignee_employee_id,vehicle_label,stop_sequence,estimated_minutes,notes,created_by_employee_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, args: [number,body.source_type,body.source_id||null,body.branch_id||null,String(body.origin_label).trim(),String(body.destination_label).trim(),String(body.job_type).trim(),body.priority||'normal','unassigned',body.promised_at||null,body.scheduled_for||null,body.assignee_employee_id||null,body.vehicle_label||null,body.stop_sequence||null,body.estimated_minutes||null,body.notes||null,req.user?.employee_id||null] });
    const id = Number(result.lastInsertRowid);
    await db.execute({ sql: `INSERT INTO dispatch_events (dispatch_job_id,event_type,new_status,details,actor_employee_id) VALUES (?,?,?,?,?)`, args: [id,'created','unassigned','Dispatch job created',req.user?.employee_id||null] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM dispatch_jobs WHERE id=?', args: [id] });
    res.status(201).json(row);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/from-transfer/:id', requirePermission('transfers'), async (req, res) => {
  try {
    const { rows: [t] } = await db.execute({ sql: `SELECT t.*, fb.name AS from_branch_name, tb.name AS to_branch_name FROM branch_transfers t JOIN branches fb ON fb.id=t.from_branch_id JOIN branches tb ON tb.id=t.to_branch_id WHERE t.id=?`, args: [req.params.id] });
    if (!t) return res.status(404).json({ error: 'Transfer not found' });
    if (!['pending','in_transit'].includes(t.status)) return res.status(409).json({ error: 'Only pending or in-transit transfers need dispatch' });
    const { rows: [existing] } = await db.execute({ sql: `SELECT * FROM dispatch_jobs WHERE source_type='branch_transfer' AND source_id=? AND status NOT IN ('cancelled') ORDER BY id DESC LIMIT 1`, args: [t.id] });
    if (existing) return res.status(200).json(existing);
    const number = jobNumber();
    const result = await db.execute({ sql: `INSERT INTO dispatch_jobs
      (job_number,source_type,source_id,branch_id,origin_label,destination_label,job_type,priority,status,notes,created_by_employee_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, args: [number,'branch_transfer',t.id,t.from_branch_id,t.from_branch_name,t.to_branch_name,'branch_transfer','normal',t.status === 'in_transit' ? 'in_transit' : 'unassigned',`Transfer ${t.transfer_number}`,req.user?.employee_id||null] });
    const id = Number(result.lastInsertRowid);
    await db.execute({ sql: `INSERT INTO dispatch_events (dispatch_job_id,event_type,new_status,details,actor_employee_id) VALUES (?,?,?,?,?)`, args: [id,'created',t.status === 'in_transit' ? 'in_transit' : 'unassigned',`Created from transfer ${t.transfer_number}`,req.user?.employee_id||null] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM dispatch_jobs WHERE id=?', args: [id] });
    res.status(201).json(row);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.patch('/jobs/:id', requirePermission('transfers'), async (req, res) => {
  try {
    const { rows: [existing] } = await db.execute({ sql: 'SELECT * FROM dispatch_jobs WHERE id=?', args: [req.params.id] });
    if (!existing) return res.status(404).json({ error: 'Dispatch job not found' });
    const allowed = ['priority','promised_at','scheduled_for','assignee_employee_id','vehicle_label','stop_sequence','estimated_minutes','notes'];
    const fields=[]; const args=[];
    for (const key of allowed) if (Object.prototype.hasOwnProperty.call(req.body||{}, key)) { fields.push(`${key}=?`); args.push(req.body[key]); }
    if (!fields.length) return res.status(400).json({ error: 'No supported fields supplied' });
    fields.push('updated_at=CURRENT_TIMESTAMP'); args.push(req.params.id);
    await db.execute({ sql: `UPDATE dispatch_jobs SET ${fields.join(', ')} WHERE id=?`, args });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM dispatch_jobs WHERE id=?', args: [req.params.id] });
    res.json(row);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/jobs/:id/status', requirePermission('transfers'), async (req, res) => {
  try {
    const { status, details } = req.body || {};
    const allowed = ['unassigned','scheduled','ready','in_transit','delayed','completed','cancelled'];
    if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const { rows: [existing] } = await db.execute({ sql: 'SELECT * FROM dispatch_jobs WHERE id=?', args: [req.params.id] });
    if (!existing) return res.status(404).json({ error: 'Dispatch job not found' });
    const departed = status === 'in_transit' && !existing.actual_departed_at ? new Date().toISOString() : existing.actual_departed_at;
    const completed = status === 'completed' ? new Date().toISOString() : existing.completed_at;
    const tx = await db.transaction('write');
    try {
      await tx.execute({ sql: 'UPDATE dispatch_jobs SET status=?, actual_departed_at=?, completed_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', args: [status,departed,completed,req.params.id] });
      await tx.execute({ sql: `INSERT INTO dispatch_events (dispatch_job_id,event_type,old_status,new_status,details,actor_employee_id) VALUES (?,?,?,?,?,?)`, args: [req.params.id,'status_changed',existing.status,status,details||null,req.user?.employee_id||null] });
      await tx.commit();
    } catch (e) { await tx.rollback(); throw e; }
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM dispatch_jobs WHERE id=?', args: [req.params.id] });
    res.json(row);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/jobs/:id/events', requirePermission('transfers'), async (req, res) => {
  try {
    const { rows } = await db.execute({ sql: `SELECT de.*, e.first_name || ' ' || e.last_name AS actor_name FROM dispatch_events de LEFT JOIN employees e ON e.id=de.actor_employee_id WHERE de.dispatch_job_id=? ORDER BY de.created_at DESC, de.id DESC`, args: [req.params.id] });
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
