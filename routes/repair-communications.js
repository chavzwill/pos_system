const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission } = require('../lib/permissions');

let ready = false;
async function ensureSchema() {
  if (ready) return;
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
  await db.execute({ sql: 'CREATE INDEX IF NOT EXISTS idx_repair_comms_work_order ON repair_communications(work_order_id, created_at)', args: [] });
  await db.execute({ sql: 'CREATE INDEX IF NOT EXISTS idx_repair_comms_response ON repair_communications(requires_response, responded_at)', args: [] });
  ready = true;
}
router.use(async (req,res,next)=>{ try { await ensureSchema(); next(); } catch(e) { res.status(500).json({error:'Repair communications schema initialization failed',detail:e.message}); } });

const allowedChannels = new Set(['internal','phone','email','sms','whatsapp','in_person','portal']);
const allowedDirections = new Set(['internal','outbound','inbound']);
const allowedVisibility = new Set(['internal','customer']);
const allowedTypes = new Set(['note','call','message','approval_request','approval_response','status_update','pickup_instruction','system_event']);
const allowedDelivery = new Set(['not_sent','queued','sent','delivered','failed','received','manual']);

router.get('/work-orders', requirePermission('work_orders'), async (req,res)=>{
  try {
    const { branch_id, awaiting_response, limit=100 } = req.query;
    const args=[];
    let where="wo.status NOT IN ('picked_up','cancelled')";
    if(branch_id){where+=' AND wo.branch_id=?';args.push(branch_id);}
    if(awaiting_response==='1') where += ` AND EXISTS (SELECT 1 FROM repair_communications rc WHERE rc.work_order_id=wo.id AND rc.requires_response=1 AND rc.responded_at IS NULL)`;
    args.push(Math.min(Math.max(parseInt(limit)||100,1),300));
    const {rows}=await db.execute({sql:`SELECT wo.id,wo.wo_number,wo.status,wo.created_at,wo.branch_id,b.name branch_name,
      c.id customer_id,c.first_name||' '||c.last_name customer_name,c.phone customer_phone,c.email customer_email,
      (SELECT COUNT(*) FROM repair_communications rc WHERE rc.work_order_id=wo.id) communication_count,
      (SELECT COUNT(*) FROM repair_communications rc WHERE rc.work_order_id=wo.id AND rc.requires_response=1 AND rc.responded_at IS NULL) awaiting_response_count,
      (SELECT rc.created_at FROM repair_communications rc WHERE rc.work_order_id=wo.id ORDER BY rc.created_at DESC,rc.id DESC LIMIT 1) last_contact_at,
      (SELECT rc.channel FROM repair_communications rc WHERE rc.work_order_id=wo.id ORDER BY rc.created_at DESC,rc.id DESC LIMIT 1) last_channel
      FROM work_orders wo LEFT JOIN customers c ON c.id=wo.customer_id LEFT JOIN branches b ON b.id=wo.branch_id
      WHERE ${where} ORDER BY awaiting_response_count DESC,COALESCE(last_contact_at,wo.created_at) ASC LIMIT ?`,args});
    res.json(rows);
  } catch(e){res.status(500).json({error:e.message});}
});

router.get('/work-orders/:id', requirePermission('work_orders'), async (req,res)=>{
  try {
    const {rows:[wo]}=await db.execute({sql:`SELECT wo.id,wo.wo_number,wo.status,wo.customer_id,c.first_name||' '||c.last_name customer_name,c.phone customer_phone,c.email customer_email
      FROM work_orders wo LEFT JOIN customers c ON c.id=wo.customer_id WHERE wo.id=?`,args:[req.params.id]});
    if(!wo)return res.status(404).json({error:'Work order not found'});
    const {rows:communications}=await db.execute({sql:`SELECT rc.*,e.first_name||' '||e.last_name created_by_name
      FROM repair_communications rc LEFT JOIN employees e ON e.id=rc.created_by_employee_id
      WHERE rc.work_order_id=? ORDER BY rc.created_at DESC,rc.id DESC`,args:[req.params.id]});
    res.json({work_order:wo,communications});
  }catch(e){res.status(500).json({error:e.message});}
});

router.post('/work-orders/:id', requirePermission('work_orders'), async (req,res)=>{
  try {
    const body=req.body||{};
    const channel=String(body.channel||'internal');
    const direction=String(body.direction||'internal');
    const visibility=String(body.visibility||'internal');
    const messageType=String(body.message_type||'note');
    const deliveryStatus=String(body.delivery_status||((channel==='internal'||channel==='phone'||channel==='in_person')?'manual':'not_sent'));
    if(!allowedChannels.has(channel))return res.status(400).json({error:'Invalid channel'});
    if(!allowedDirections.has(direction))return res.status(400).json({error:'Invalid direction'});
    if(!allowedVisibility.has(visibility))return res.status(400).json({error:'Invalid visibility'});
    if(!allowedTypes.has(messageType))return res.status(400).json({error:'Invalid message_type'});
    if(!allowedDelivery.has(deliveryStatus))return res.status(400).json({error:'Invalid delivery_status'});
    if(!body.body||!String(body.body).trim())return res.status(400).json({error:'body is required'});
    const {rows:[wo]}=await db.execute({sql:'SELECT id,customer_id FROM work_orders WHERE id=?',args:[req.params.id]});
    if(!wo)return res.status(404).json({error:'Work order not found'});
    const tx=await db.transaction('write');
    try{
      const result=await tx.execute({sql:`INSERT INTO repair_communications
        (work_order_id,customer_id,channel,direction,visibility,message_type,subject,body,contact_value,delivery_status,external_reference,requires_response,created_by_employee_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:[req.params.id,wo.customer_id||null,channel,direction,visibility,messageType,body.subject||null,String(body.body).trim(),body.contact_value||null,deliveryStatus,body.external_reference||null,body.requires_response?1:0,req.user?.employee_id||req.employee?.id||null]});
      await tx.execute({sql:`INSERT INTO repair_timeline_events (work_order_id,event_type,visibility,title,details,actor_employee_id,source_entity_type,source_entity_id)
        VALUES (?,?,?,?,?,?,?,?)`,args:[req.params.id,'communication_logged',visibility,messageType==='call'?'Customer call logged':messageType==='approval_request'?'Approval request logged':'Communication logged',String(body.body).trim().slice(0,500),req.user?.employee_id||req.employee?.id||null,'repair_communication',String(Number(result.lastInsertRowid))]});
      await tx.commit();
      const id=Number(result.lastInsertRowid);
      const {rows:[row]}=await db.execute({sql:'SELECT * FROM repair_communications WHERE id=?',args:[id]});
      res.status(201).json(row);
    }catch(e){await tx.rollback();throw e;}
  }catch(e){res.status(400).json({error:e.message});}
});

router.post('/:id/responded', requirePermission('work_orders'), async (req,res)=>{
  try{
    const {rows:[existing]}=await db.execute({sql:'SELECT * FROM repair_communications WHERE id=?',args:[req.params.id]});
    if(!existing)return res.status(404).json({error:'Communication not found'});
    await db.execute({sql:'UPDATE repair_communications SET responded_at=COALESCE(responded_at,CURRENT_TIMESTAMP) WHERE id=?',args:[req.params.id]});
    const {rows:[row]}=await db.execute({sql:'SELECT * FROM repair_communications WHERE id=?',args:[req.params.id]});
    res.json(row);
  }catch(e){res.status(400).json({error:e.message});}
});

router.patch('/:id/delivery', requirePermission('work_orders'), async (req,res)=>{
  try{
    const status=String(req.body?.delivery_status||'');
    if(!allowedDelivery.has(status))return res.status(400).json({error:'Invalid delivery_status'});
    const {rows:[existing]}=await db.execute({sql:'SELECT * FROM repair_communications WHERE id=?',args:[req.params.id]});
    if(!existing)return res.status(404).json({error:'Communication not found'});
    await db.execute({sql:'UPDATE repair_communications SET delivery_status=?,external_reference=COALESCE(?,external_reference) WHERE id=?',args:[status,req.body?.external_reference||null,req.params.id]});
    const {rows:[row]}=await db.execute({sql:'SELECT * FROM repair_communications WHERE id=?',args:[req.params.id]});
    res.json(row);
  }catch(e){res.status(400).json({error:e.message});}
});

module.exports=router;
