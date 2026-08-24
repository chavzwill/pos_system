const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission } = require('../lib/permissions');

let ready = false;
async function ensureSchema() {
  if (ready) return;
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
  await db.execute({ sql: `CREATE TABLE IF NOT EXISTS repair_communications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    work_order_id INTEGER NOT NULL,
    customer_id INTEGER,
    channel TEXT NOT NULL,
    direction TEXT NOT NULL DEFAULT 'internal',
    visibility TEXT NOT NULL DEFAULT 'internal',
    message_type TEXT NOT NULL DEFAULT 'note',
    subject TEXT,
    body TEXT NOT NULL,
    contact_value TEXT,
    delivery_status TEXT NOT NULL DEFAULT 'not_sent',
    external_reference TEXT,
    requires_response INTEGER NOT NULL DEFAULT 0,
    responded_at TEXT,
    created_by_employee_id INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`, args: [] });
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
  ready = true;
}
router.use(async (req,res,next)=>{ try { await ensureSchema(); next(); } catch(e) { res.status(500).json({error:'Customer repair portal schema initialization failed',detail:e.message}); } });

function access(req,res,next){
  if(req.apiKey) return next();
  return requirePermission('work_orders')(req,res,next);
}
router.use(access);

async function customerExists(id){
  const {rows:[row]}=await db.execute({sql:'SELECT id,customer_number,first_name,last_name FROM customers WHERE id=? AND active=1',args:[id]});
  return row;
}

router.get('/customers/:customerId', async (req,res)=>{
  try {
    const customer=await customerExists(req.params.customerId);
    if(!customer)return res.status(404).json({error:'Customer not found'});
    const {rows:repairs}=await db.execute({sql:`SELECT wo.id work_order_id,wo.wo_number,wo.status,wo.created_at,wo.completed_at,wo.pickup_due_date,
      wo.assessment_fee,wo.estimate_labor,wo.estimate_consumables,wo.deposit_amount,
      b.name branch_name,e.first_name||' '||e.last_name employee_name,
      COALESCE((SELECT SUM(total) FROM work_order_items woi WHERE woi.work_order_id=wo.id),0) parts_total,
      ce.id equipment_id,ce.equipment_type,ce.brand,ce.model,ce.serial_number,ce.asset_tag,ce.warranty_status,ce.warranty_expiry,
      rel.intake_condition,rel.reported_issue,rel.warranty_claim,
      (SELECT COUNT(*) FROM repair_communications rc WHERE rc.work_order_id=wo.id AND rc.visibility='customer' AND rc.requires_response=1 AND rc.responded_at IS NULL) awaiting_customer_response_count
      FROM work_orders wo
      LEFT JOIN branches b ON b.id=wo.branch_id
      LEFT JOIN employees e ON e.id=wo.employee_id
      LEFT JOIN repair_equipment_links rel ON rel.work_order_id=wo.id
      LEFT JOIN customer_equipment ce ON ce.id=rel.equipment_id
      WHERE wo.customer_id=? ORDER BY wo.created_at DESC LIMIT 200`,args:[req.params.customerId]});

    const output=[];
    for(const repair of repairs){
      const id=repair.work_order_id;
      const [{rows:timeline},{rows:communications},{rows:diagnostics},{rows:estimates}] = await Promise.all([
        db.execute({sql:`SELECT id,event_type,title,details,source_entity_type,source_entity_id,created_at
          FROM repair_timeline_events WHERE work_order_id=? AND visibility='customer'
          ORDER BY created_at ASC,id ASC`,args:[id]}),
        db.execute({sql:`SELECT id,channel,direction,message_type,subject,body,delivery_status,requires_response,responded_at,created_at
          FROM repair_communications WHERE work_order_id=? AND visibility='customer'
          ORDER BY created_at ASC,id ASC`,args:[id]}),
        db.execute({sql:`SELECT id,fault_code,complaint,findings,recommended_action,severity,created_at
          FROM repair_diagnostics WHERE work_order_id=? AND customer_visible=1
          ORDER BY created_at ASC,id ASC`,args:[id]}),
        db.execute({sql:`SELECT rer.id,rer.revision_number,rer.reason,rer.labor_amount,rer.parts_amount,rer.fees_amount,rer.tax_amount,rer.total_amount,rer.status,rer.created_at,rer.superseded_at,
          (SELECT decision FROM repair_authorizations ra WHERE ra.estimate_revision_id=rer.id ORDER BY ra.decided_at DESC,ra.id DESC LIMIT 1) latest_decision,
          (SELECT authorization_method FROM repair_authorizations ra WHERE ra.estimate_revision_id=rer.id ORDER BY ra.decided_at DESC,ra.id DESC LIMIT 1) latest_authorization_method,
          (SELECT decided_at FROM repair_authorizations ra WHERE ra.estimate_revision_id=rer.id ORDER BY ra.decided_at DESC,ra.id DESC LIMIT 1) latest_decided_at
          FROM repair_estimate_revisions rer WHERE rer.work_order_id=? ORDER BY rer.revision_number ASC`,args:[id]})
      ]);
      output.push({
        ...repair,
        equipment: repair.equipment_id ? {
          id:repair.equipment_id,type:repair.equipment_type,brand:repair.brand,model:repair.model,serial_number:repair.serial_number,asset_tag:repair.asset_tag,warranty_status:repair.warranty_status,warranty_expiry:repair.warranty_expiry,intake_condition:repair.intake_condition,reported_issue:repair.reported_issue,warranty_claim:!!repair.warranty_claim
        } : null,
        timeline,
        communications,
        diagnostics,
        estimates
      });
    }
    res.json({
      customer:{id:customer.id,customer_number:customer.customer_number,name:`${customer.first_name||''} ${customer.last_name||''}`.trim()},
      repairs:output,
      privacy_policy:'Only customer-visible repair timeline events, communications and diagnostics are exported. Internal technician notes, compensation, cost controls and staff-only comments are excluded.'
    });
  } catch(e){res.status(500).json({error:e.message});}
});

module.exports=router;
