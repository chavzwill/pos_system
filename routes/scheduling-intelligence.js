const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission } = require('../lib/permissions');

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const asNumber = v => Number.isFinite(Number(v)) ? Number(v) : 0;

async function getTechnicians(date) {
  const { rows } = await db.execute({
    sql: `SELECT e.id, e.first_name, e.last_name, e.branch_id,
      COALESCE((SELECT SUM(COALESCE(t.allotted_minutes,0))
        FROM technician_schedule ts
        LEFT JOIN work_order_tasks t ON t.id = ts.work_order_task_id
        WHERE ts.employee_id = e.id AND ts.scheduled_date = ?),0) AS scheduled_minutes,
      COALESCE((SELECT COUNT(*) FROM technician_schedule ts WHERE ts.employee_id = e.id AND ts.scheduled_date = ?),0) AS scheduled_items,
      COALESCE((SELECT COUNT(*) FROM work_order_task_time_entries te WHERE te.technician_id = e.id AND te.ended_at IS NULL),0) AS active_tasks,
      (SELECT GROUP_CONCAT(s.name, ', ') FROM employee_skills es JOIN technician_skills s ON s.id = es.skill_id WHERE es.employee_id = e.id AND s.active = 1) AS skills
      FROM employees e
      WHERE EXISTS (SELECT 1 FROM employee_skills es WHERE es.employee_id = e.id)
         OR EXISTS (SELECT 1 FROM work_order_tasks t WHERE t.technician_id = e.id)
         OR EXISTS (SELECT 1 FROM technician_schedule ts WHERE ts.employee_id = e.id)
      ORDER BY e.first_name, e.last_name`,
    args: [date, date],
  });
  return rows.map(r => ({
    ...r,
    name: `${r.first_name || ''} ${r.last_name || ''}`.trim() || `Employee ${r.id}`,
    scheduled_minutes: asNumber(r.scheduled_minutes),
    scheduled_items: asNumber(r.scheduled_items),
    active_tasks: asNumber(r.active_tasks),
    skill_list: String(r.skills || '').split(',').map(s => s.trim()).filter(Boolean),
  }));
}

async function getTasks(date, branchId) {
  const args = [date];
  let branchClause = '';
  if (branchId) { branchClause = ' AND wo.branch_id = ?'; args.push(branchId); }
  const { rows } = await db.execute({
    sql: `SELECT t.id, t.work_order_id, t.description, t.allotted_minutes, t.status, t.technician_id,
      wo.wo_number, wo.branch_id, wo.status AS work_order_status,
      (SELECT GROUP_CONCAT(s.name, ', ') FROM work_order_task_skills wts JOIN technician_skills s ON s.id = wts.skill_id WHERE wts.task_id = t.id) AS required_skills,
      (SELECT COUNT(*) FROM technician_schedule ts WHERE ts.work_order_task_id = t.id AND ts.scheduled_date = ?) AS scheduled_today
      FROM work_order_tasks t
      JOIN work_orders wo ON wo.id = t.work_order_id
      WHERE t.status != 'complete' AND wo.status NOT IN ('picked_up','cancelled')${branchClause}
      ORDER BY wo.created_at, t.id`,
    args,
  });
  return rows.map(r => ({
    ...r,
    allotted_minutes: Math.max(0, asNumber(r.allotted_minutes)),
    required_skill_list: String(r.required_skills || '').split(',').map(s => s.trim()).filter(Boolean),
    scheduled_today: asNumber(r.scheduled_today),
  }));
}

function scoreMatch(task, tech, dailyCapacity) {
  const required = task.required_skill_list.map(s => s.toLowerCase());
  const techSkills = tech.skill_list.map(s => s.toLowerCase());
  const matched = required.filter(s => techSkills.includes(s));
  const skillScore = required.length ? matched.length / required.length : 1;
  const projected = tech.scheduled_minutes + task.allotted_minutes;
  const utilization = dailyCapacity ? projected / dailyCapacity : 1;
  const capacityScore = utilization <= 1 ? 1 - (utilization * 0.35) : Math.max(0, 1 - ((utilization - 1) * 1.5));
  const branchScore = !task.branch_id || !tech.branch_id || Number(task.branch_id) === Number(tech.branch_id) ? 1 : 0.35;
  const activePenalty = Math.min(0.25, tech.active_tasks * 0.08);
  const score = clamp((skillScore * 0.55) + (capacityScore * 0.25) + (branchScore * 0.2) - activePenalty, 0, 1);
  const reasons = [];
  if (required.length) reasons.push(`${matched.length}/${required.length} required skills matched`); else reasons.push('No explicit skill requirement');
  reasons.push(`${Math.round((tech.scheduled_minutes / dailyCapacity) * 100)}% of day already scheduled`);
  if (task.branch_id && tech.branch_id) reasons.push(Number(task.branch_id) === Number(tech.branch_id) ? 'Same branch' : 'Different branch');
  if (tech.active_tasks) reasons.push(`${tech.active_tasks} task${tech.active_tasks === 1 ? '' : 's'} currently active`);
  return { score: Math.round(score * 100), skill_match: Math.round(skillScore * 100), projected_minutes: projected, reasons };
}

router.get('/board', requirePermission('work_orders'), async (req, res) => {
  try {
    const date = String(req.query.date || new Date().toISOString().slice(0,10));
    const branchId = req.query.branch_id || null;
    const dailyCapacity = clamp(parseInt(req.query.capacity_minutes || '480', 10) || 480, 120, 960);
    const [technicians, tasks] = await Promise.all([getTechnicians(date), getTasks(date, branchId)]);

    const techRows = technicians
      .filter(t => !branchId || !t.branch_id || Number(t.branch_id) === Number(branchId))
      .map(t => ({
        ...t,
        capacity_minutes: dailyCapacity,
        remaining_minutes: Math.max(0, dailyCapacity - t.scheduled_minutes),
        utilization_percent: Math.round((t.scheduled_minutes / dailyCapacity) * 100),
        overload_minutes: Math.max(0, t.scheduled_minutes - dailyCapacity),
      }));

    const recommendations = tasks.filter(t => !t.scheduled_today).map(task => {
      const candidates = techRows.map(tech => ({ technician_id: tech.id, technician_name: tech.name, ...scoreMatch(task, tech, dailyCapacity) }))
        .sort((a,b) => b.score - a.score).slice(0,5);
      return {
        task_id: task.id,
        work_order_id: task.work_order_id,
        wo_number: task.wo_number,
        description: task.description,
        branch_id: task.branch_id,
        allotted_minutes: task.allotted_minutes,
        required_skills: task.required_skill_list,
        candidates,
        risk: candidates[0]?.score >= 75 ? 'low' : candidates[0]?.score >= 50 ? 'medium' : 'high',
      };
    });

    res.json({
      date,
      branch_id: branchId,
      daily_capacity_minutes: dailyCapacity,
      summary: {
        technicians: techRows.length,
        open_tasks: tasks.length,
        unscheduled_tasks: recommendations.length,
        overloaded_technicians: techRows.filter(t => t.overload_minutes > 0).length,
        capacity_minutes: techRows.length * dailyCapacity,
        scheduled_minutes: techRows.reduce((s,t) => s + t.scheduled_minutes, 0),
      },
      technicians: techRows,
      recommendations,
      methodology: 'Deterministic ranking only: required skill coverage, scheduled capacity, branch alignment and currently active work. No assignment is changed automatically.',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/assign', requirePermission('work_orders'), async (req, res) => {
  try {
    const { employee_id, work_order_task_id, scheduled_date, notes } = req.body || {};
    if (!employee_id || !work_order_task_id || !scheduled_date) return res.status(400).json({ error: 'employee_id, work_order_task_id and scheduled_date are required' });
    const { rows: [task] } = await db.execute({ sql: `SELECT t.id,t.status,wo.id AS work_order_id,wo.status AS work_order_status FROM work_order_tasks t JOIN work_orders wo ON wo.id=t.work_order_id WHERE t.id=?`, args: [work_order_task_id] });
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (task.status === 'complete' || ['picked_up','cancelled'].includes(task.work_order_status)) return res.status(409).json({ error: 'Task is no longer schedulable' });
    const tx = await db.transaction('write');
    try {
      await tx.execute({ sql: 'DELETE FROM technician_schedule WHERE work_order_task_id = ? AND scheduled_date = ?', args: [work_order_task_id, scheduled_date] });
      const result = await tx.execute({ sql: 'INSERT INTO technician_schedule (employee_id,work_order_task_id,scheduled_date,notes) VALUES (?,?,?,?)', args: [employee_id,work_order_task_id,scheduled_date,notes||'Assigned from scheduling intelligence'] });
      await tx.execute({ sql: 'UPDATE work_order_tasks SET technician_id = ? WHERE id = ?', args: [employee_id, work_order_task_id] });
      await tx.execute({ sql: `INSERT INTO repair_timeline_events (work_order_id,event_type,visibility,title,details,actor_employee_id,source_entity_type,source_entity_id)
        VALUES (?,?,?,?,?,?,?,?)`, args: [task.work_order_id,'technician_scheduled','internal','Technician scheduled',`Employee ${employee_id} scheduled for ${scheduled_date}`,req.user?.employee_id||null,'work_order_task',String(work_order_task_id)] });
      await tx.commit();
      res.status(201).json({ id: Number(result.lastInsertRowid), employee_id, work_order_task_id, scheduled_date });
    } catch (e) { await tx.rollback(); throw e; }
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
