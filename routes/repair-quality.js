const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission, requireAnyPermission } = require('../lib/permissions');
const { ensureWorkOrderServiceEvidenceSchema } = require('../lib/work-order-service-evidence-schema');

let schemaPromise = null;
async function ensureSchema() {
  if (!schemaPromise) schemaPromise = (async()=>{
    await ensureWorkOrderServiceEvidenceSchema();
    await db.batch([
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
      { sql: `CREATE TABLE IF NOT EXISTS repair_quality_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_order_id INTEGER NOT NULL REFERENCES work_orders(id),
        technician_id INTEGER NOT NULL REFERENCES employees(id),
        result TEXT NOT NULL CHECK(result IN ('pass','fail')),
        checklist_json TEXT NOT NULL DEFAULT '{}',
        note TEXT,
        reviewed_by INTEGER REFERENCES employees(id),
        reviewed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )` },
      { sql: `CREATE TABLE IF NOT EXISTS repair_comeback_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        original_work_order_id INTEGER NOT NULL REFERENCES work_orders(id),
        comeback_work_order_id INTEGER REFERENCES work_orders(id),
        technician_id INTEGER NOT NULL REFERENCES employees(id),
        confirmed INTEGER NOT NULL DEFAULT 1,
        reason TEXT NOT NULL,
        recorded_by INTEGER REFERENCES employees(id),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(original_work_order_id, comeback_work_order_id)
      )` },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_repair_quality_work_order ON repair_quality_reviews(work_order_id, reviewed_at)' },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_repair_comeback_original ON repair_comeback_links(original_work_order_id)' },
      { sql: `CREATE TRIGGER IF NOT EXISTS trg_work_order_completion_requires_quality
        BEFORE UPDATE OF status ON work_orders
        WHEN NEW.status = 'complete' AND OLD.status <> 'complete'
        BEGIN
          SELECT CASE WHEN TRIM(COALESCE(NEW.diagnosis,'')) = '' OR TRIM(COALESCE(NEW.repair_notes,'')) = ''
            THEN RAISE(ABORT,'Work order cannot be completed without diagnosis and repair notes') END;
          SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM work_order_tasks WHERE work_order_id = NEW.id)
            THEN RAISE(ABORT,'Work order cannot be completed without repair tasks') END;
          SELECT CASE WHEN EXISTS (SELECT 1 FROM work_order_tasks WHERE work_order_id = NEW.id AND (status <> 'complete' OR technician_id IS NULL))
            THEN RAISE(ABORT,'Work order cannot be completed with unfinished or unattributed tasks') END;
          SELECT CASE WHEN COALESCE((SELECT result FROM repair_quality_reviews WHERE work_order_id = NEW.id ORDER BY reviewed_at DESC,id DESC LIMIT 1),'') <> 'pass'
            THEN RAISE(ABORT,'Work order cannot be completed before passing QC') END;
        END` },
    ], 'write');
  })().catch(err => { schemaPromise = null; throw err; });
  return schemaPromise;
}

router.use(async (req,res,next)=>{ try { await ensureSchema(); next(); } catch(e) { res.status(500).json({error:'Repair quality schema initialization failed',detail:e.message}); } });

async function workOrder(id) {
  const { rows:[wo] } = await db.execute({ sql:'SELECT id,wo_number,status,employee_id,diagnosis,repair_notes,completed_at FROM work_orders WHERE id=?', args:[id] });
  return wo || null;
}
async function primaryTechnician(workOrderId, fallbackEmployeeId) {
  const { rows:[row] } = await db.execute({ sql:`SELECT technician_id,COUNT(*) task_count FROM work_order_tasks WHERE work_order_id=? AND technician_id IS NOT NULL GROUP BY technician_id ORDER BY task_count DESC,technician_id LIMIT 1`, args:[workOrderId] });
  return Number(row?.technician_id || fallbackEmployeeId || 0) || null;
}
async function readinessFor(wo) {
  const technicianId=await primaryTechnician(wo.id,wo.employee_id);
  const [taskResult,partResult]=await Promise.all([
    db.execute({sql:`SELECT id,description,status,technician_id,allotted_minutes FROM work_order_tasks WHERE work_order_id=? ORDER BY id`,args:[wo.id]}),
    db.execute({sql:'SELECT id,product_name,quantity FROM work_order_items WHERE work_order_id=?',args:[wo.id]})
  ]);
  const tasks=taskResult.rows, parts=partResult.rows;
  const incompleteTasks=tasks.filter(t=>t.status!=='complete');
  const missingTaskTech=tasks.filter(t=>!t.technician_id);
  const checks={
    technician_assigned:!!technicianId,
    diagnosis_documented:!!String(wo.diagnosis||'').trim(),
    repair_notes_documented:!!String(wo.repair_notes||'').trim(),
    all_tasks_complete:tasks.length>0&&incompleteTasks.length===0,
    all_tasks_attributed:tasks.length>0&&missingTaskTech.length===0,
    parts_evidence_present:parts.length>0,
  };
  const readyForQc=checks.technician_assigned&&checks.diagnosis_documented&&checks.repair_notes_documented&&checks.all_tasks_complete&&checks.all_tasks_attributed;
  return { technicianId,tasks,parts,checks,readyForQc,blockingReasons:Object.entries(checks).filter(([k,v])=>!v&&k!=='parts_evidence_present').map(([k])=>k) };
}
async function event({technicianId,workOrderId,type,note,actor}) {
  return db.execute({ sql:'INSERT INTO technician_performance_events(technician_id,work_order_id,event_type,note,recorded_by) VALUES(?,?,?,?,?)', args:[technicianId,workOrderId,type,note||null,actor||null] });
}
async function timeline(workOrderId,type,title,details,actor) {
  try { await db.execute({ sql:`INSERT INTO repair_timeline_events(work_order_id,event_type,visibility,title,details,actor_employee_id,source_entity_type,source_entity_id) VALUES(?,?,?,?,?,?,?,?)`, args:[workOrderId,type,'internal',title,details||null,actor||null,'performance',String(workOrderId)] }); } catch(_) {}
}

router.get('/work-orders/:id/readiness', requireAnyPermission('work_orders','reports'), async (req,res)=>{
  try {
    const wo=await workOrder(req.params.id); if(!wo)return res.status(404).json({error:'Work order not found'});
    const readiness=await readinessFor(wo);
    res.json({work_order_id:wo.id,wo_number:wo.wo_number,status:wo.status,technician_id:readiness.technicianId,checks:readiness.checks,ready_for_qc:readiness.readyForQc,blocking_reasons:readiness.blockingReasons,note:'Parts evidence is informative because some repairs legitimately require no parts.'});
  } catch(e){res.status(500).json({error:e.message});}
});

router.post('/work-orders/:id/qc', requirePermission('work_orders'), async (req,res)=>{
  try {
    const wo=await workOrder(req.params.id); if(!wo)return res.status(404).json({error:'Work order not found'});
    const result=String(req.body.result||'').toLowerCase(); if(!['pass','fail'].includes(result))return res.status(400).json({error:'QC result must be pass or fail'});
    const readiness=await readinessFor(wo);
    const requestedTechnicianId=Number(req.body.technician_id)||null;
    const technicianId=requestedTechnicianId||readiness.technicianId;
    if(!technicianId)return res.status(400).json({error:'A technician must be attributable before QC can be recorded'});
    if(requestedTechnicianId && readiness.technicianId && requestedTechnicianId!==readiness.technicianId) {
      return res.status(409).json({error:'QC technician must match the technician attributable from the work order evidence',attributable_technician_id:readiness.technicianId});
    }
    const checklist=req.body.checklist&&typeof req.body.checklist==='object'?req.body.checklist:{}; const note=String(req.body.note||'').trim();
    if(result==='pass'&&!readiness.readyForQc) return res.status(409).json({error:'Work order is not ready to pass QC',blocking_reasons:readiness.blockingReasons,checks:readiness.checks});
    if(result==='fail'&&!note)return res.status(400).json({error:'A reason is required when QC fails'});
    const actor=req.employee?.id||null;
    const tx=await db.transaction('write'); let committed=false;
    try {
      const q=await tx.execute({sql:'INSERT INTO repair_quality_reviews(work_order_id,technician_id,result,checklist_json,note,reviewed_by) VALUES(?,?,?,?,?,?)',args:[wo.id,technicianId,result,JSON.stringify(checklist),note||null,actor]});
      await tx.execute({sql:'INSERT INTO technician_performance_events(technician_id,work_order_id,event_type,note,recorded_by) VALUES(?,?,?,?,?)',args:[technicianId,wo.id,result==='pass'?'qc_pass':'qc_fail',note||null,actor]});
      const documentationComplete=!!String(wo.diagnosis||'').trim()&&!!String(wo.repair_notes||'').trim();
      await tx.execute({sql:'INSERT INTO technician_performance_events(technician_id,work_order_id,event_type,note,recorded_by) VALUES(?,?,?,?,?)',args:[technicianId,wo.id,documentationComplete?'documentation_complete':'documentation_missing',documentationComplete?'Required diagnosis and repair notes present':'Diagnosis or repair notes missing at QC',actor]});
      await tx.commit(); committed=true;
      await timeline(wo.id,result==='pass'?'qc_pass':'qc_fail',result==='pass'?'Quality control passed':'Quality control failed',note||'QC checklist recorded',actor);
      res.status(201).json({id:Number(q.lastInsertRowid),work_order_id:wo.id,technician_id:technicianId,result,documentation_complete:documentationComplete,performance_evidence_recorded:true,automatic_pay_change:false});
    } catch(e){if(!committed)await tx.rollback();throw e;}
  } catch(e){res.status(400).json({error:e.message});}
});

router.post('/work-orders/:id/comeback', requirePermission('work_orders'), async (req,res)=>{
  try {
    const wo=await workOrder(req.params.id); if(!wo)return res.status(404).json({error:'Original work order not found'});
    const reason=String(req.body.reason||'').trim(); if(!reason)return res.status(400).json({error:'A comeback reason is required'});
    const technicianId=Number(req.body.technician_id)||await primaryTechnician(wo.id,wo.employee_id); if(!technicianId)return res.status(400).json({error:'A technician must be attributable before a comeback can be recorded'});
    const comebackId=req.body.comeback_work_order_id==null?null:Number(req.body.comeback_work_order_id); const confirmed=req.body.confirmed===false?0:1; const actor=req.employee?.id||null;
    if(comebackId!=null){
      if(!Number.isInteger(comebackId)||comebackId<=0)return res.status(400).json({error:'A valid comeback work order id is required'});
      if(comebackId===Number(wo.id))return res.status(409).json({error:'A work order cannot be recorded as its own comeback'});
      const comeback=await workOrder(comebackId); if(!comeback)return res.status(404).json({error:'Comeback work order not found'});
    }
    const result=await db.execute({sql:'INSERT INTO repair_comeback_links(original_work_order_id,comeback_work_order_id,technician_id,confirmed,reason,recorded_by) VALUES(?,?,?,?,?,?)',args:[wo.id,comebackId,technicianId,confirmed,reason,actor]});
    await event({technicianId,workOrderId:wo.id,type:confirmed?'comeback_confirmed':'comeback_clear',note:reason,actor});
    await timeline(wo.id,confirmed?'comeback_confirmed':'comeback_clear',confirmed?'Confirmed repair comeback':'Comeback review cleared',reason,actor);
    res.status(201).json({id:Number(result.lastInsertRowid),original_work_order_id:wo.id,comeback_work_order_id:comebackId,technician_id:technicianId,confirmed:!!confirmed,performance_evidence_recorded:true,automatic_pay_change:false});
  } catch(e){res.status(400).json({error:e.message});}
});

router.get('/work-orders/:id/quality-history', requireAnyPermission('work_orders','reports','employees_salaries'), async (req,res)=>{
  try {
    const wo=await workOrder(req.params.id); if(!wo)return res.status(404).json({error:'Work order not found'});
    const [reviews,comebacks,events]=await Promise.all([
      db.execute({sql:`SELECT qr.*,e.first_name||' '||e.last_name technician_name,r.first_name||' '||r.last_name reviewer_name FROM repair_quality_reviews qr LEFT JOIN employees e ON e.id=qr.technician_id LEFT JOIN employees r ON r.id=qr.reviewed_by WHERE qr.work_order_id=? ORDER BY qr.reviewed_at DESC`,args:[req.params.id]}),
      db.execute({sql:`SELECT rc.*,e.first_name||' '||e.last_name technician_name FROM repair_comeback_links rc LEFT JOIN employees e ON e.id=rc.technician_id WHERE rc.original_work_order_id=? ORDER BY rc.created_at DESC`,args:[req.params.id]}),
      db.execute({sql:`SELECT * FROM technician_performance_events WHERE work_order_id=? ORDER BY occurred_at DESC,id DESC`,args:[req.params.id]})
    ]);
    res.json({work_order_id:wo.id,wo_number:wo.wo_number,quality_reviews:reviews.rows.map(r=>({...r,checklist:JSON.parse(r.checklist_json||'{}')})),comebacks:comebacks.rows,performance_events:events.rows});
  } catch(e){res.status(500).json({error:e.message});}
});

module.exports=router;
