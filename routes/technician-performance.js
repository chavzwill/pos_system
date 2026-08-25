const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requireAnyPermission, requirePermission } = require('../lib/permissions');

let schemaPromise = null;
async function ensureSchema() {
  if (!schemaPromise) schemaPromise = db.batch([
    { sql: `CREATE TABLE IF NOT EXISTS technician_performance_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      technician_id INTEGER NOT NULL REFERENCES employees(id),
      work_order_id INTEGER REFERENCES work_orders(id),
      task_id INTEGER REFERENCES work_order_tasks(id),
      event_type TEXT NOT NULL,
      note TEXT,
      recorded_by INTEGER REFERENCES employees(id),
      occurred_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )` },
    { sql: 'CREATE INDEX IF NOT EXISTS idx_tech_perf_events_tech_date ON technician_performance_events(technician_id, occurred_at)' },
    { sql: 'CREATE INDEX IF NOT EXISTS idx_tech_perf_events_wo ON technician_performance_events(work_order_id)' },
    { sql: `CREATE TABLE IF NOT EXISTS technician_coaching_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      technician_id INTEGER NOT NULL REFERENCES employees(id),
      review_type TEXT NOT NULL DEFAULT 'coaching',
      strengths TEXT,
      focus_area TEXT NOT NULL,
      action_plan TEXT NOT NULL,
      target_date DATE,
      status TEXT NOT NULL DEFAULT 'open',
      created_by INTEGER REFERENCES employees(id),
      closed_by INTEGER REFERENCES employees(id),
      closed_at DATETIME,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )` },
    { sql: 'CREATE INDEX IF NOT EXISTS idx_tech_coaching_tech_status ON technician_coaching_actions(technician_id, status, created_at)' },
    { sql: 'CREATE INDEX IF NOT EXISTS idx_tech_coaching_target ON technician_coaching_actions(target_date, status)' },
  ], 'write').catch(err => { schemaPromise = null; throw err; });
  return schemaPromise;
}

function period(req) {
  const end = String(req.query.end || new Date().toISOString().slice(0,10));
  const start = String(req.query.start || new Date(Date.now()-29*86400000).toISOString().slice(0,10));
  return { start, end };
}
function n(v){ return Number(v||0); }
function clamp(v,min=0,max=100){ return Math.max(min,Math.min(max,v)); }
function metric(value, evidence, note){ return value == null ? { score:null, available:false, evidence, note } : { score:Number(value.toFixed(1)), available:true, evidence, note }; }

const WEIGHTS = Object.freeze({ quality:25, comeback_control:20, efficiency:20, completion_discipline:15, timeliness:10, documentation:5, safety:5 });
function scorecard(row, events) {
  const timed=n(row.timed_tasks), completed=n(row.completed_tasks), worked=n(row.worked_minutes), allotted=n(row.allotted_minutes);
  const eligibleTimed=n(row.allotted_completed_tasks), within=n(row.within_allotted_tasks);
  const efficiencyRatio = worked>0 && allotted>0 ? allotted/worked : null;
  const efficiencyScore = efficiencyRatio==null ? null : clamp(efficiencyRatio*100);
  const completionScore = timed>0 ? clamp(completed/timed*100) : null;
  const timelinessScore = eligibleTimed>0 ? clamp(within/eligibleTimed*100) : null;
  const count = type => events.filter(e=>e.event_type===type).length;
  const qcPass=count('qc_pass'), qcFail=count('qc_fail'), qcTotal=qcPass+qcFail;
  const qualityScore=qcTotal ? clamp(qcPass/qcTotal*100) : null;
  const comebacks=count('comeback_confirmed');
  const comebackScore=(completed>0 && (comebacks>0 || events.some(e=>e.event_type==='comeback_clear'))) ? clamp(100-(comebacks/completed*100)) : null;
  const docOk=count('documentation_complete'), docBad=count('documentation_missing'), docTotal=docOk+docBad;
  const documentationScore=docTotal ? clamp(docOk/docTotal*100) : null;
  const safetyOk=count('safety_compliant'), safetyBad=count('safety_incident'), safetyTotal=safetyOk+safetyBad;
  const safetyScore=safetyTotal ? clamp(safetyOk/safetyTotal*100) : null;

  const metrics={
    quality:metric(qualityScore,{qc_pass:qcPass,qc_fail:qcFail},'First-pass quality uses explicitly recorded QC outcomes only.'),
    comeback_control:metric(comebackScore,{confirmed_comebacks:comebacks,completed_tasks:completed},'Comebacks are counted only when explicitly confirmed and attributed.'),
    efficiency:metric(efficiencyScore,{worked_minutes:Number(worked.toFixed(1)),allotted_minutes:Number(allotted.toFixed(1)),ratio:efficiencyRatio==null?null:Number(efficiencyRatio.toFixed(3))},'Efficiency compares verified timer minutes with allotted task minutes; scores are capped so extreme speed is not rewarded beyond target.'),
    completion_discipline:metric(completionScore,{timed_tasks:timed,completed_tasks:completed},'Completion discipline is the share of timed tasks currently completed.'),
    timeliness:metric(timelinessScore,{allotted_completed_tasks:eligibleTimed,within_allotted_tasks:within},'Timeliness uses completed timed tasks with configured allotted minutes.'),
    documentation:metric(documentationScore,{complete:docOk,missing:docBad},'Documentation is scored only from explicit review events.'),
    safety:metric(safetyScore,{compliant:safetyOk,incidents:safetyBad},'Safety is scored only from explicitly recorded compliance/incident evidence.')
  };
  let earned=0, availableWeight=0;
  for(const [key,w] of Object.entries(WEIGHTS)){ if(metrics[key].available){ earned += metrics[key].score*w; availableWeight += w; } }
  const overall = availableWeight ? earned/availableWeight : null;
  const flags=[];
  if(efficiencyRatio!=null && efficiencyRatio>1.35) flags.push('Efficiency is unusually high; review task allotments and timer evidence before using it for incentives.');
  if(qualityScore!=null && qualityScore<85) flags.push('Quality is below the preferred review threshold; speed should not outweigh first-pass quality.');
  if(comebacks>0) flags.push(`${comebacks} confirmed comeback${comebacks===1?'':'s'} require review.`);
  const band = overall==null ? 'insufficient_evidence' : overall>=95?'exceptional':overall>=90?'strong':overall>=80?'solid':overall>=70?'watch':'needs_improvement';
  return { overall_score:overall==null?null:Number(overall.toFixed(1)), evidence_coverage_percent:availableWeight, performance_band:band, metrics, flags,
    incentive_review:{ eligible:overall!=null && availableWeight>=70 && overall>=80 && !flags.some(f=>f.includes('Quality is below')), automatic_pay_change:false, policy:'Performance may inform an approved incentive under company policy. This endpoint never changes base pay or payroll automatically.' } };
}

router.get('/summary', requireAnyPermission('work_orders','reports','employees_salaries'), async (req,res)=>{
  try{
    await ensureSchema(); const p=period(req); const started=Date.now();
    const [taskResult,eventResult]=await Promise.all([
      db.execute({sql:`WITH per_task AS (
        SELECT te.technician_id,te.task_id,t.status,t.allotted_minutes,
          SUM((julianday(COALESCE(te.ended_at,CURRENT_TIMESTAMP))-julianday(te.started_at))*24*60) actual_minutes
        FROM work_order_task_time_entries te JOIN work_order_tasks t ON t.id=te.task_id
        WHERE date(te.started_at) BETWEEN date(?) AND date(?)
        GROUP BY te.technician_id,te.task_id,t.status,t.allotted_minutes
      )
      SELECT e.id employee_id,e.employee_number,e.first_name,e.last_name,
        COUNT(pt.task_id) timed_tasks,
        COALESCE(SUM(CASE WHEN pt.status='complete' THEN 1 ELSE 0 END),0) completed_tasks,
        COALESCE(SUM(pt.actual_minutes),0) worked_minutes,
        COALESCE(SUM(CASE WHEN pt.allotted_minutes>0 THEN pt.allotted_minutes ELSE 0 END),0) allotted_minutes,
        COALESCE(SUM(CASE WHEN pt.status='complete' AND pt.allotted_minutes>0 THEN 1 ELSE 0 END),0) allotted_completed_tasks,
        COALESCE(SUM(CASE WHEN pt.status='complete' AND pt.allotted_minutes>0 AND pt.actual_minutes<=pt.allotted_minutes*1.1 THEN 1 ELSE 0 END),0) within_allotted_tasks
      FROM per_task pt JOIN employees e ON e.id=pt.technician_id
      GROUP BY e.id,e.employee_number,e.first_name,e.last_name ORDER BY e.last_name,e.first_name`,args:[p.start,p.end]}),
      db.execute({sql:`SELECT * FROM technician_performance_events WHERE date(occurred_at) BETWEEN date(?) AND date(?) ORDER BY occurred_at DESC`,args:[p.start,p.end]})
    ]);
    const byTech=new Map(); for(const e of eventResult.rows){const id=Number(e.technician_id);if(!byTech.has(id))byTech.set(id,[]);byTech.get(id).push(e);}
    const rows=taskResult.rows.map(r=>({...r,worked_minutes:Number(n(r.worked_minutes).toFixed(1)),allotted_minutes:Number(n(r.allotted_minutes).toFixed(1)),scorecard:scorecard(r,byTech.get(Number(r.employee_id))||[])}));
    res.json({period:p,weights:WEIGHTS,rows,evaluation_ms:Date.now()-started,methodology:'Evidence-based technician performance. Missing quality, comeback, documentation or safety evidence remains unavailable and is never inferred. Overall scores normalize only across available dimensions and include evidence coverage.'});
  }catch(e){res.status(500).json({error:e.message});}
});

const EVENT_TYPES=new Set(['qc_pass','qc_fail','comeback_confirmed','comeback_clear','documentation_complete','documentation_missing','safety_compliant','safety_incident']);
router.post('/events', requirePermission('work_orders'), async (req,res)=>{
  try{
    await ensureSchema(); const technicianId=Number(req.body.technician_id); const type=String(req.body.event_type||''); const workOrderId=req.body.work_order_id==null?null:Number(req.body.work_order_id); const taskId=req.body.task_id==null?null:Number(req.body.task_id); const note=String(req.body.note||'').trim();
    if(!technicianId||!EVENT_TYPES.has(type)) return res.status(400).json({error:'Valid technician_id and event_type are required'});
    if(['qc_fail','comeback_confirmed','documentation_missing','safety_incident'].includes(type) && !note) return res.status(400).json({error:'A note is required for adverse performance events'});
    const occurred=String(req.body.occurred_at||new Date().toISOString());
    const result=await db.execute({sql:'INSERT INTO technician_performance_events(technician_id,work_order_id,task_id,event_type,note,recorded_by,occurred_at) VALUES(?,?,?,?,?,?,?)',args:[technicianId,workOrderId,taskId,type,note||null,req.employee?.id||null,occurred]});
    const {rows:[row]}=await db.execute({sql:'SELECT * FROM technician_performance_events WHERE id=?',args:[Number(result.lastInsertRowid)]});res.status(201).json(row);
  }catch(e){res.status(400).json({error:e.message});}
});

router.get('/events', requireAnyPermission('work_orders','reports','employees_salaries'), async (req,res)=>{
  try{await ensureSchema();const p=period(req);const args=[p.start,p.end];let where='date(pe.occurred_at) BETWEEN date(?) AND date(?)';if(req.query.technician_id){where+=' AND pe.technician_id=?';args.push(Number(req.query.technician_id));}const {rows}=await db.execute({sql:`SELECT pe.*,e.employee_number,e.first_name,e.last_name,wo.wo_number FROM technician_performance_events pe JOIN employees e ON e.id=pe.technician_id LEFT JOIN work_orders wo ON wo.id=pe.work_order_id WHERE ${where} ORDER BY pe.occurred_at DESC LIMIT 500`,args});res.json(rows);}catch(e){res.status(500).json({error:e.message});}
});

const REVIEW_TYPES=new Set(['coaching','recognition','performance_plan','follow_up']);
const COACHING_STATUSES=new Set(['open','completed','cancelled']);
router.get('/coaching', requireAnyPermission('work_orders','reports','employees_salaries'), async (req,res)=>{
  try{
    await ensureSchema(); const args=[]; const where=[];
    if(req.query.technician_id){where.push('ca.technician_id=?');args.push(Number(req.query.technician_id));}
    if(req.query.status){where.push('ca.status=?');args.push(String(req.query.status));}
    const clause=where.length?'WHERE '+where.join(' AND '):'';
    const {rows}=await db.execute({sql:`SELECT ca.*,e.employee_number,e.first_name,e.last_name,
      TRIM(COALESCE(cb.first_name,'')||' '||COALESCE(cb.last_name,'')) created_by_name,
      TRIM(COALESCE(xb.first_name,'')||' '||COALESCE(xb.last_name,'')) closed_by_name
      FROM technician_coaching_actions ca
      JOIN employees e ON e.id=ca.technician_id
      LEFT JOIN employees cb ON cb.id=ca.created_by
      LEFT JOIN employees xb ON xb.id=ca.closed_by
      ${clause}
      ORDER BY CASE ca.status WHEN 'open' THEN 0 ELSE 1 END, COALESCE(ca.target_date,'9999-12-31'), ca.created_at DESC LIMIT 500`,args});
    res.json(rows);
  }catch(e){res.status(500).json({error:e.message});}
});

router.post('/coaching', requirePermission('work_orders'), async (req,res)=>{
  try{
    await ensureSchema();
    const technicianId=Number(req.body.technician_id); const reviewType=String(req.body.review_type||'coaching');
    const strengths=String(req.body.strengths||'').trim(); const focus=String(req.body.focus_area||'').trim(); const plan=String(req.body.action_plan||'').trim();
    const targetDate=req.body.target_date?String(req.body.target_date):null;
    if(!technicianId||!REVIEW_TYPES.has(reviewType)||!focus||!plan) return res.status(400).json({error:'Technician, valid review type, focus area and action plan are required'});
    if(focus.length>1000||plan.length>3000||strengths.length>1500) return res.status(400).json({error:'Coaching text exceeds the supported length'});
    const result=await db.execute({sql:`INSERT INTO technician_coaching_actions(technician_id,review_type,strengths,focus_area,action_plan,target_date,created_by) VALUES(?,?,?,?,?,?,?)`,args:[technicianId,reviewType,strengths||null,focus,plan,targetDate,req.employee?.id||null]});
    const {rows:[row]}=await db.execute({sql:'SELECT * FROM technician_coaching_actions WHERE id=?',args:[Number(result.lastInsertRowid)]});
    res.status(201).json(row);
  }catch(e){res.status(400).json({error:e.message});}
});

router.patch('/coaching/:id', requirePermission('work_orders'), async (req,res)=>{
  try{
    await ensureSchema(); const id=Number(req.params.id); if(!id)return res.status(400).json({error:'Valid coaching action id is required'});
    const {rows:[existing]}=await db.execute({sql:'SELECT * FROM technician_coaching_actions WHERE id=?',args:[id]}); if(!existing)return res.status(404).json({error:'Coaching action not found'});
    const status=req.body.status==null?existing.status:String(req.body.status); if(!COACHING_STATUSES.has(status))return res.status(400).json({error:'Invalid coaching status'});
    const focus=req.body.focus_area==null?existing.focus_area:String(req.body.focus_area).trim();
    const plan=req.body.action_plan==null?existing.action_plan:String(req.body.action_plan).trim();
    const strengths=req.body.strengths==null?existing.strengths:String(req.body.strengths).trim();
    const targetDate=req.body.target_date===undefined?existing.target_date:(req.body.target_date?String(req.body.target_date):null);
    if(!focus||!plan)return res.status(400).json({error:'Focus area and action plan are required'});
    const closing=status!=='open'&&existing.status==='open'; const reopening=status==='open'&&existing.status!=='open';
    await db.execute({sql:`UPDATE technician_coaching_actions SET strengths=?,focus_area=?,action_plan=?,target_date=?,status=?,closed_by=?,closed_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`,args:[strengths||null,focus,plan,targetDate,status,reopening?null:(closing?(req.employee?.id||null):existing.closed_by),reopening?null:(closing?new Date().toISOString():existing.closed_at),id]});
    const {rows:[row]}=await db.execute({sql:'SELECT * FROM technician_coaching_actions WHERE id=?',args:[id]}); res.json(row);
  }catch(e){res.status(400).json({error:e.message});}
});

module.exports=router;
