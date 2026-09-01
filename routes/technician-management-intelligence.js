const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requireAnyPermission}=require('../lib/permissions');

async function ensureSupportingSchema(){
  await db.batch([
    {sql:`CREATE TABLE IF NOT EXISTS technician_performance_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      technician_id INTEGER NOT NULL REFERENCES employees(id),
      work_order_id INTEGER REFERENCES work_orders(id),
      task_id INTEGER REFERENCES work_order_tasks(id),
      event_type TEXT NOT NULL,
      note TEXT,
      recorded_by INTEGER REFERENCES employees(id),
      occurred_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`},
    {sql:`CREATE TABLE IF NOT EXISTS technician_coaching_actions (
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
    )`}
  ],'write');
}
const n=v=>Number(v||0);
const severityRank={critical:0,high:1,medium:2,info:3};
router.get('/overview',requireAnyPermission('work_orders','reports','employees_salaries'),async(req,res)=>{
  try{
    const started=Date.now();
    await ensureSupportingSchema();
    const days=Math.max(7,Math.min(90,Number(req.query.days)||30));
    const [actionsResult,eventResult,timerResult,qcReadyResult]=await Promise.all([
      db.execute({sql:`SELECT ca.id,ca.technician_id,ca.review_type,ca.focus_area,ca.target_date,ca.status,ca.created_at,
        e.employee_number,e.first_name,e.last_name
        FROM technician_coaching_actions ca JOIN employees e ON e.id=ca.technician_id
        WHERE ca.status='open' ORDER BY CASE WHEN ca.target_date IS NOT NULL AND date(ca.target_date)<date('now') THEN 0 ELSE 1 END,COALESCE(ca.target_date,'9999-12-31'),ca.created_at LIMIT 100`,args:[]}),
      db.execute({sql:`SELECT pe.technician_id,pe.event_type,COUNT(*) event_count,MAX(pe.occurred_at) latest_at,
        e.employee_number,e.first_name,e.last_name
        FROM technician_performance_events pe JOIN employees e ON e.id=pe.technician_id
        WHERE datetime(pe.occurred_at)>=datetime('now',?)
        GROUP BY pe.technician_id,pe.event_type,e.employee_number,e.first_name,e.last_name`,args:[`-${days} days`]}),
      db.execute({sql:`WITH per_task AS (
        SELECT te.technician_id,te.task_id,t.status,t.allotted_minutes,
          SUM((julianday(COALESCE(te.ended_at,CURRENT_TIMESTAMP))-julianday(te.started_at))*24*60) actual_minutes
        FROM work_order_task_time_entries te JOIN work_order_tasks t ON t.id=te.task_id
        WHERE datetime(te.started_at)>=datetime('now',?)
        GROUP BY te.technician_id,te.task_id,t.status,t.allotted_minutes
      )
      SELECT e.id technician_id,e.employee_number,e.first_name,e.last_name,COUNT(*) timed_tasks,
        SUM(CASE WHEN pt.status='complete' THEN 1 ELSE 0 END) completed_tasks,
        SUM(CASE WHEN pt.allotted_minutes>0 THEN pt.allotted_minutes ELSE 0 END) allotted_minutes,
        SUM(pt.actual_minutes) actual_minutes,
        SUM(CASE WHEN pt.status='complete' AND pt.allotted_minutes>0 THEN 1 ELSE 0 END) timed_completed,
        SUM(CASE WHEN pt.status='complete' AND pt.allotted_minutes>0 AND pt.actual_minutes<=pt.allotted_minutes*1.1 THEN 1 ELSE 0 END) within_allotted
      FROM per_task pt JOIN employees e ON e.id=pt.technician_id
      GROUP BY e.id,e.employee_number,e.first_name,e.last_name`,args:[`-${days} days`]}),
      db.execute({sql:`SELECT COUNT(*) pending_qc FROM work_orders WHERE status IN ('repair_complete','qc_pending')`,args:[]}).catch(()=>({rows:[{pending_qc:0}]}))
    ]);
    const alerts=[];
    const tech=new Map();
    const ensure=(id,row={})=>{if(!tech.has(Number(id)))tech.set(Number(id),{technician_id:Number(id),employee_number:row.employee_number||'',first_name:row.first_name||'',last_name:row.last_name||'',open_actions:0,overdue_actions:0,qc_fail:0,comebacks:0,documentation_missing:0,safety_incidents:0,quality_events:0,timed_tasks:0,completed_tasks:0,efficiency_ratio:null,timeliness_percent:null});return tech.get(Number(id));};
    for(const a of actionsResult.rows){const t=ensure(a.technician_id,a);t.open_actions++;const overdue=a.target_date&&String(a.target_date)<new Date().toISOString().slice(0,10);if(overdue){t.overdue_actions++;alerts.push({severity:'high',type:'overdue_coaching',technician_id:t.technician_id,technician_name:`${t.first_name} ${t.last_name}`.trim(),title:'Manager follow-up overdue',detail:`${String(a.review_type).replace(/_/g,' ')} target ${a.target_date}: ${a.focus_area}`,action:'Open coaching'});}}
    for(const e of eventResult.rows){const t=ensure(e.technician_id,e),c=n(e.event_count);if(e.event_type==='qc_fail'){t.qc_fail+=c;t.quality_events+=c;alerts.push({severity:'high',type:'qc_fail',technician_id:t.technician_id,technician_name:`${t.first_name} ${t.last_name}`.trim(),title:'QC failures need review',detail:`${c} QC failure${c===1?'':'s'} recorded in the last ${days} days.`,action:'Review performance'});}if(e.event_type==='qc_pass')t.quality_events+=c;if(e.event_type==='comeback_confirmed'){t.comebacks+=c;alerts.push({severity:'critical',type:'comeback',technician_id:t.technician_id,technician_name:`${t.first_name} ${t.last_name}`.trim(),title:'Confirmed comeback risk',detail:`${c} technician-attributed comeback${c===1?'':'s'} recorded in the last ${days} days.`,action:'Review quality evidence'});}if(e.event_type==='documentation_missing'){t.documentation_missing+=c;alerts.push({severity:'medium',type:'documentation',technician_id:t.technician_id,technician_name:`${t.first_name} ${t.last_name}`.trim(),title:'Documentation discipline',detail:`${c} missing-documentation event${c===1?'':'s'} recorded.`,action:'Review evidence'});}if(e.event_type==='safety_incident'){t.safety_incidents+=c;alerts.push({severity:'critical',type:'safety',technician_id:t.technician_id,technician_name:`${t.first_name} ${t.last_name}`.trim(),title:'Safety incident requires attention',detail:`${c} safety incident${c===1?'':'s'} recorded in the last ${days} days.`,action:'Review immediately'});}}
    for(const r of timerResult.rows){const t=ensure(r.technician_id,r);t.timed_tasks=n(r.timed_tasks);t.completed_tasks=n(r.completed_tasks);const actual=n(r.actual_minutes),allotted=n(r.allotted_minutes);t.efficiency_ratio=actual>0&&allotted>0?Number((allotted/actual).toFixed(3)):null;t.timeliness_percent=n(r.timed_completed)>0?Number((n(r.within_allotted)/n(r.timed_completed)*100).toFixed(1)):null;if(t.efficiency_ratio!=null&&t.efficiency_ratio>1.35)alerts.push({severity:'medium',type:'efficiency_anomaly',technician_id:t.technician_id,technician_name:`${t.first_name} ${t.last_name}`.trim(),title:'Efficiency anomaly',detail:`Allotted-to-actual ratio is ${t.efficiency_ratio.toFixed(2)}. Review task allotments and timer evidence before rewarding speed.`,action:'Inspect timers'});if(t.timeliness_percent!=null&&t.timeliness_percent<70&&n(r.timed_completed)>=3)alerts.push({severity:'medium',type:'timeliness',technician_id:t.technician_id,technician_name:`${t.first_name} ${t.last_name}`.trim(),title:'Timeliness deterioration',detail:`${t.timeliness_percent.toFixed(1)}% of completed allotted tasks were within the permitted window.`,action:'Review workload'});}
    const technicians=[...tech.values()].map(t=>({...t,risk_points:t.comebacks*5+t.safety_incidents*5+t.qc_fail*3+t.overdue_actions*2+t.documentation_missing+(t.timeliness_percent!=null&&t.timeliness_percent<70?1:0)})).sort((a,b)=>b.risk_points-a.risk_points||String(a.last_name).localeCompare(String(b.last_name)));
    alerts.sort((a,b)=>severityRank[a.severity]-severityRank[b.severity]||String(a.technician_name).localeCompare(String(b.technician_name)));
    const summary={technicians_observed:technicians.length,attention_items:alerts.length,critical:alerts.filter(a=>a.severity==='critical').length,overdue_followups:technicians.reduce((s,t)=>s+t.overdue_actions,0),confirmed_comebacks:technicians.reduce((s,t)=>s+t.comebacks,0),qc_failures:technicians.reduce((s,t)=>s+t.qc_fail,0),safety_incidents:technicians.reduce((s,t)=>s+t.safety_incidents,0),pending_qc:n(qcReadyResult.rows?.[0]?.pending_qc)};
    res.json({period_days:days,summary,alerts:alerts.slice(0,100),technicians,evaluation_ms:Date.now()-started,methodology:'Management attention uses verified coaching, QC, comeback, documentation, safety and timer evidence. It surfaces review priorities only; it does not alter performance records or compensation.'});
  }catch(e){res.status(500).json({error:e.message});}
});
module.exports=router;
