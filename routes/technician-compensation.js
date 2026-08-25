const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requireAnyPermission, requirePermission } = require('../lib/permissions');

let schemaPromise = null;
async function ensureCompensationSchema() {
  if (!schemaPromise) schemaPromise = db.batch([
    { sql: `CREATE TABLE IF NOT EXISTS technician_pay_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL REFERENCES employees(id),
      hourly_rate REAL NOT NULL DEFAULT 0,
      overtime_rate REAL,
      effective_from DATE NOT NULL,
      effective_to DATE,
      changed_by INTEGER REFERENCES employees(id),
      change_note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS technician_pay_adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL REFERENCES employees(id),
      period_start DATE NOT NULL,
      period_end DATE NOT NULL,
      adjustment_type TEXT NOT NULL DEFAULT 'other',
      amount REAL NOT NULL DEFAULT 0,
      note TEXT NOT NULL,
      created_by INTEGER REFERENCES employees(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS technician_pay_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL REFERENCES employees(id),
      period_start DATE NOT NULL,
      period_end DATE NOT NULL,
      hourly_rate REAL NOT NULL DEFAULT 0,
      worked_minutes REAL NOT NULL DEFAULT 0,
      completed_tasks INTEGER NOT NULL DEFAULT 0,
      allotted_minutes REAL NOT NULL DEFAULT 0,
      efficiency_percent REAL,
      base_pay REAL NOT NULL DEFAULT 0,
      adjustments_total REAL NOT NULL DEFAULT 0,
      payable_total REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'finalized',
      evidence_json TEXT NOT NULL DEFAULT '{}',
      finalized_by INTEGER REFERENCES employees(id),
      finalized_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(employee_id, period_start, period_end)
    )` },
    { sql: 'CREATE INDEX IF NOT EXISTS idx_tech_rates_employee_effective ON technician_pay_rates(employee_id, effective_from DESC)' },
    { sql: 'CREATE INDEX IF NOT EXISTS idx_tech_adjustments_period ON technician_pay_adjustments(period_start, period_end, employee_id)' },
    { sql: 'CREATE INDEX IF NOT EXISTS idx_tech_time_entries_period ON work_order_task_time_entries(technician_id, started_at)' },
  ], 'write').catch(err => { schemaPromise = null; throw err; });
  return schemaPromise;
}

function isoDate(d) { const y=d.getUTCFullYear(); const m=String(d.getUTCMonth()+1).padStart(2,'0'); const day=String(d.getUTCDate()).padStart(2,'0'); return `${y}-${m}-${day}`; }
function utcDate(y,m,d) { return new Date(Date.UTC(y,m,d)); }
function payPeriodFor(input) {
  const date = input ? new Date(`${input}T12:00:00Z`) : new Date();
  if (Number.isNaN(date.getTime())) throw new Error('Invalid date');
  const y=date.getUTCFullYear(), m=date.getUTCMonth(), day=date.getUTCDate();
  if (day >= 14 && day <= 28) return { start: isoDate(utcDate(y,m,14)), end: isoDate(utcDate(y,m,28)), label:'14th–28th' };
  if (day >= 29) return { start: isoDate(utcDate(y,m,29)), end: isoDate(utcDate(y,m+1,13)), label:'29th–13th' };
  return { start: isoDate(utcDate(y,m-1,29)), end: isoDate(utcDate(y,m,13)), label:'29th–13th' };
}

async function rateFor(employeeId, periodEnd) {
  const { rows:[row] } = await db.execute({ sql:`SELECT * FROM technician_pay_rates WHERE employee_id=? AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?) ORDER BY effective_from DESC,id DESC LIMIT 1`, args:[employeeId,periodEnd,periodEnd] });
  return row || null;
}
async function rateMapFor(employeeIds, periodEnd) {
  if (!employeeIds.length) return new Map();
  const marks=employeeIds.map(()=>'?').join(',');
  const {rows}=await db.execute({sql:`SELECT * FROM technician_pay_rates WHERE employee_id IN (${marks}) AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?) ORDER BY employee_id,effective_from DESC,id DESC`,args:[...employeeIds,periodEnd,periodEnd]});
  const map=new Map();
  for(const row of rows){const id=Number(row.employee_id);if(!map.has(id))map.set(id,row);}
  return map;
}

async function evidenceFor(period) {
  const { rows } = await db.execute({ sql:`WITH task_time AS (
      SELECT te.technician_id, te.task_id, SUM((julianday(te.ended_at)-julianday(te.started_at))*24*60) AS actual_minutes
      FROM work_order_task_time_entries te
      WHERE te.ended_at IS NOT NULL AND date(te.started_at) BETWEEN ? AND ?
      GROUP BY te.technician_id, te.task_id
    )
    SELECT e.id AS employee_id, e.employee_number, e.first_name, e.last_name,
      COUNT(tt.task_id) AS timed_tasks, COALESCE(SUM(tt.actual_minutes),0) AS worked_minutes,
      COALESCE(SUM(CASE WHEN t.status='complete' THEN 1 ELSE 0 END),0) AS completed_tasks,
      COALESCE(SUM(CASE WHEN t.allotted_minutes>0 THEN t.allotted_minutes ELSE 0 END),0) AS allotted_minutes
    FROM task_time tt JOIN employees e ON e.id=tt.technician_id JOIN work_order_tasks t ON t.id=tt.task_id
    GROUP BY e.id,e.employee_number,e.first_name,e.last_name ORDER BY e.last_name,e.first_name`, args:[period.start,period.end] });
  return rows;
}

router.get('/period', requireAnyPermission('work_orders','reports','employees_salaries'), async (req,res) => {
  try { await ensureCompensationSchema(); res.json(payPeriodFor(req.query.date)); }
  catch(e) { res.status(400).json({ error:e.message }); }
});

router.get('/summary', requireAnyPermission('work_orders','reports','employees_salaries'), async (req,res) => {
  try {
    const startedAt=Date.now();
    await ensureCompensationSchema();
    const period = req.query.start && req.query.end ? { start:String(req.query.start), end:String(req.query.end), label:'custom' } : payPeriodFor(req.query.date);
    const [evidence,{ rows: adjustments }] = await Promise.all([
      evidenceFor(period),
      db.execute({ sql:'SELECT employee_id,COALESCE(SUM(amount),0) total FROM technician_pay_adjustments WHERE period_start=? AND period_end=? GROUP BY employee_id', args:[period.start,period.end] })
    ]);
    const employeeIds=evidence.map(x=>Number(x.employee_id)).filter(Boolean);
    const rates=await rateMapFor(employeeIds,period.end);
    const adjustmentMap = new Map(adjustments.map(a=>[Number(a.employee_id),Number(a.total)||0]));
    const rows=evidence.map(item=>{
      const rate=rates.get(Number(item.employee_id))||null; const worked=Number(item.worked_minutes)||0; const allotted=Number(item.allotted_minutes)||0;
      const efficiency = worked>0 && allotted>0 ? Number(((allotted/worked)*100).toFixed(1)) : null;
      const basePay = Number(((worked/60)*(Number(rate?.hourly_rate)||0)).toFixed(2)); const adjustmentsTotal=adjustmentMap.get(Number(item.employee_id))||0;
      return { ...item, worked_minutes:Number(worked.toFixed(1)), worked_hours:Number((worked/60).toFixed(2)), allotted_minutes:allotted, efficiency_percent:efficiency,
        hourly_rate:Number(rate?.hourly_rate)||0, overtime_rate:rate?.overtime_rate==null?null:Number(rate.overtime_rate), base_pay:basePay, adjustments_total:adjustmentsTotal,
        payable_total:Number((basePay+adjustmentsTotal).toFixed(2)), evidence:{ time_entries:'verified', task_completion:'verified_current_state', attendance:'unavailable', overtime_hours:'unavailable', qc_first_pass:'unavailable', comeback_rework:'unavailable', safety_events:'unavailable' } };
    });
    res.set('Server-Timing',`technician-compensation;dur=${Date.now()-startedAt}`);
    res.json({ period, generated_at:new Date().toISOString(), evaluation_ms:Date.now()-startedAt, rows, note:'Base pay uses completed technician timer evidence only. Pay-rate lookup is batched for the period. Unavailable quality/attendance evidence is not inferred.' });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

router.get('/rates', requireAnyPermission('work_orders','reports','employees_salaries'), async (req,res) => {
  try { await ensureCompensationSchema(); const { rows }=await db.execute({ sql:`SELECT r.*,e.employee_number,e.first_name,e.last_name,cb.first_name||' '||cb.last_name changed_by_name FROM technician_pay_rates r JOIN employees e ON e.id=r.employee_id LEFT JOIN employees cb ON cb.id=r.changed_by ORDER BY r.employee_id,r.effective_from DESC`, args:[] }); res.json(rows); }
  catch(e){res.status(500).json({error:e.message});}
});

router.put('/rates/:employeeId', requirePermission('employees_salaries'), async (req,res) => {
  try {
    await ensureCompensationSchema(); const employeeId=Number(req.params.employeeId); const hourly=Number(req.body.hourly_rate); const overtime=req.body.overtime_rate==null||req.body.overtime_rate===''?null:Number(req.body.overtime_rate); const effective=String(req.body.effective_from||isoDate(new Date()));
    if(!employeeId||!Number.isFinite(hourly)||hourly<0) return res.status(400).json({error:'A valid non-negative hourly rate is required'});
    const actor=req.employee?.id||null; const note=String(req.body.change_note||'').trim();
    const tx=await db.transaction('write'); let committed=false;
    try {
      await tx.execute({ sql:'UPDATE technician_pay_rates SET effective_to=date(?,\'-1 day\') WHERE employee_id=? AND effective_to IS NULL AND effective_from<?', args:[effective,employeeId,effective] });
      await tx.execute({ sql:'INSERT INTO technician_pay_rates(employee_id,hourly_rate,overtime_rate,effective_from,changed_by,change_note) VALUES(?,?,?,?,?,?)', args:[employeeId,hourly,overtime,effective,actor,note||null] });
      await tx.commit(); committed=true;
    } catch(e){if(!committed)await tx.rollback();throw e;}
    const rate=await rateFor(employeeId,effective); res.json(rate);
  } catch(e){res.status(400).json({error:e.message});}
});

router.post('/adjustments', requirePermission('employees_salaries'), async (req,res) => {
  try {
    await ensureCompensationSchema(); const period=req.body.period_start&&req.body.period_end?{start:String(req.body.period_start),end:String(req.body.period_end)}:payPeriodFor(req.body.date); const employeeId=Number(req.body.employee_id); const amount=Number(req.body.amount); const note=String(req.body.note||'').trim(); const type=String(req.body.adjustment_type||'other');
    if(!employeeId||!Number.isFinite(amount)||!note) return res.status(400).json({error:'Employee, amount and adjustment note are required'});
    const result=await db.execute({ sql:'INSERT INTO technician_pay_adjustments(employee_id,period_start,period_end,adjustment_type,amount,note,created_by) VALUES(?,?,?,?,?,?,?)', args:[employeeId,period.start,period.end,type,amount,note,req.employee?.id||null] });
    const {rows:[row]}=await db.execute({sql:'SELECT * FROM technician_pay_adjustments WHERE id=?',args:[Number(result.lastInsertRowid)]}); res.status(201).json(row);
  } catch(e){res.status(400).json({error:e.message});}
});

router.post('/finalize/:employeeId', requirePermission('employees_salaries'), async (req,res) => {
  try {
    await ensureCompensationSchema(); const employeeId=Number(req.params.employeeId); const period=req.body.period_start&&req.body.period_end?{start:String(req.body.period_start),end:String(req.body.period_end)}:payPeriodFor(req.body.date);
    const evidence=(await evidenceFor(period)).find(x=>Number(x.employee_id)===employeeId); if(!evidence)return res.status(400).json({error:'No verified technician time exists in this pay period'});
    const rate=await rateFor(employeeId,period.end); if(!rate)return res.status(400).json({error:'No technician pay rate is effective for this pay period'});
    const {rows:[adj]}=await db.execute({sql:'SELECT COALESCE(SUM(amount),0) total FROM technician_pay_adjustments WHERE employee_id=? AND period_start=? AND period_end=?',args:[employeeId,period.start,period.end]});
    const worked=Number(evidence.worked_minutes)||0, allotted=Number(evidence.allotted_minutes)||0, efficiency=worked>0&&allotted>0?Number(((allotted/worked)*100).toFixed(1)):null; const base=Number(((worked/60)*Number(rate.hourly_rate)).toFixed(2)); const adjustments=Number(adj?.total)||0; const payable=Number((base+adjustments).toFixed(2));
    const evidenceJson=JSON.stringify({ time_entries:'verified', task_completion:'verified_current_state', attendance:'unavailable', overtime_hours:'unavailable', qc_first_pass:'unavailable', comeback_rework:'unavailable', safety_events:'unavailable' });
    await db.execute({sql:`INSERT INTO technician_pay_snapshots(employee_id,period_start,period_end,hourly_rate,worked_minutes,completed_tasks,allotted_minutes,efficiency_percent,base_pay,adjustments_total,payable_total,evidence_json,finalized_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(employee_id,period_start,period_end) DO UPDATE SET hourly_rate=excluded.hourly_rate,worked_minutes=excluded.worked_minutes,completed_tasks=excluded.completed_tasks,allotted_minutes=excluded.allotted_minutes,efficiency_percent=excluded.efficiency_percent,base_pay=excluded.base_pay,adjustments_total=excluded.adjustments_total,payable_total=excluded.payable_total,evidence_json=excluded.evidence_json,finalized_by=excluded.finalized_by,finalized_at=CURRENT_TIMESTAMP`,args:[employeeId,period.start,period.end,rate.hourly_rate,worked,evidence.completed_tasks,allotted,efficiency,base,adjustments,payable,evidenceJson,req.employee?.id||null]});
    const {rows:[snapshot]}=await db.execute({sql:'SELECT * FROM technician_pay_snapshots WHERE employee_id=? AND period_start=? AND period_end=?',args:[employeeId,period.start,period.end]}); res.json(snapshot);
  } catch(e){res.status(400).json({error:e.message});}
});

router.get('/snapshots', requireAnyPermission('reports','employees_salaries'), async (req,res) => {
  try { await ensureCompensationSchema(); const {rows}=await db.execute({sql:`SELECT s.*,e.employee_number,e.first_name,e.last_name,f.first_name||' '||f.last_name finalized_by_name FROM technician_pay_snapshots s JOIN employees e ON e.id=s.employee_id LEFT JOIN employees f ON f.id=s.finalized_by ORDER BY s.period_end DESC,e.last_name,e.first_name`,args:[]}); res.json(rows.map(r=>({...r,evidence:JSON.parse(r.evidence_json||'{}')}))); }
  catch(e){res.status(500).json({error:e.message});}
});

module.exports = router;
