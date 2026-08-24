const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission } = require('../lib/permissions');

let ready = false;
async function ensureSchema() {
  if (ready) return;
  await db.execute({ sql: `CREATE TABLE IF NOT EXISTS repair_notification_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_key TEXT NOT NULL UNIQUE,
    work_order_id INTEGER NOT NULL,
    customer_id INTEGER,
    channel TEXT NOT NULL,
    recipient TEXT,
    notification_type TEXT NOT NULL,
    subject TEXT,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    blocked_reason TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    external_reference TEXT,
    source_entity_type TEXT,
    source_entity_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sent_at TEXT,
    delivered_at TEXT
  )`, args: [] });
  await db.execute({ sql: 'CREATE INDEX IF NOT EXISTS idx_repair_notification_status ON repair_notification_outbox(status, created_at)', args: [] });
  await db.execute({ sql: 'CREATE INDEX IF NOT EXISTS idx_repair_notification_work_order ON repair_notification_outbox(work_order_id, created_at)', args: [] });
  ready = true;
}
router.use(async (req,res,next)=>{ try { await ensureSchema(); next(); } catch(e) { res.status(500).json({error:'Repair notification orchestration initialization failed'}); } });

const channels = ['email','sms','whatsapp'];
const validStatuses = new Set(['queued','blocked','sending','sent','delivered','failed','cancelled']);

async function setting(key) {
  try {
    const { rows:[row] } = await db.execute({ sql:'SELECT value FROM settings WHERE key=? LIMIT 1', args:[key] });
    return row?.value == null ? null : String(row.value);
  } catch (_) { return null; }
}
function enabled(value) { return ['1','true','yes','on','enabled'].includes(String(value||'').toLowerCase()); }
function normalizePhone(value) { return String(value||'').replace(/\D/g,''); }
function eventCopy(event) {
  const title = String(event.title || 'Repair update').trim();
  const details = String(event.details || '').trim();
  const body = details ? `${title}: ${details}` : title;
  return { subject: title.slice(0,180), body: body.slice(0,1800) };
}
function channelRecipient(channel, customer) {
  if (channel === 'email') return String(customer.email || '').trim();
  return normalizePhone(customer.phone);
}
async function channelPolicy() {
  return {
    email: enabled(await setting('repair_notify_email_enabled')),
    sms: enabled(await setting('repair_notify_sms_enabled')),
    whatsapp: enabled(await setting('repair_notify_whatsapp_enabled')),
  };
}

async function syncEvents() {
  const policy = await channelPolicy();
  const { rows: events } = await db.execute({ sql:`SELECT rte.id,rte.work_order_id,rte.event_type,rte.title,rte.details,rte.created_at,
      wo.customer_id,wo.wo_number,c.email,c.phone,c.first_name,c.last_name
    FROM repair_timeline_events rte
    JOIN work_orders wo ON wo.id=rte.work_order_id
    LEFT JOIN customers c ON c.id=wo.customer_id
    WHERE rte.visibility='customer'
      AND rte.event_type IN ('status_update','estimate_created','estimate_authorized','estimate_rejected','communication_logged','equipment_linked','repair_completed','pickup_ready','customer_portal_authorization','customer_portal_message')
    ORDER BY rte.id ASC LIMIT 1000`, args: [] });
  let created=0, blocked=0;
  for (const event of events) {
    const copy = eventCopy(event);
    for (const channel of channels) {
      const recipient = channelRecipient(channel,event);
      const transportEnabled = !!policy[channel];
      const hasRecipient = !!recipient;
      const status = transportEnabled && hasRecipient ? 'queued' : 'blocked';
      const reason = !transportEnabled ? `${channel} repair notifications are not enabled` : !hasRecipient ? `Customer has no ${channel==='email'?'email address':'phone number'} on file` : null;
      const eventKey = `timeline:${event.id}:${channel}`;
      const result = await db.execute({ sql:`INSERT OR IGNORE INTO repair_notification_outbox
        (event_key,work_order_id,customer_id,channel,recipient,notification_type,subject,body,status,blocked_reason,source_entity_type,source_entity_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, args:[eventKey,event.work_order_id,event.customer_id||null,channel,recipient||null,event.event_type,copy.subject,copy.body,status,reason,'repair_timeline_event',String(event.id)] });
      if (Number(result.rowsAffected || 0) > 0) { created += 1; if(status==='blocked') blocked += 1; }
    }
  }
  return { scanned: events.length, created, blocked, policy };
}

router.post('/sync', requirePermission('work_orders'), async (req,res)=>{
  try { res.json(await syncEvents()); } catch(e) { res.status(500).json({error:e.message}); }
});

router.get('/summary', requirePermission('work_orders'), async (req,res)=>{
  try {
    const { branch_id } = req.query;
    const args=[];
    let branchJoin=''; let where='1=1';
    if(branch_id){ branchJoin=' JOIN work_orders wo ON wo.id=rno.work_order_id '; where='wo.branch_id=?'; args.push(branch_id); }
    const { rows:[counts] } = await db.execute({ sql:`SELECT
      COUNT(*) total,
      SUM(CASE WHEN rno.status='queued' THEN 1 ELSE 0 END) queued,
      SUM(CASE WHEN rno.status='blocked' THEN 1 ELSE 0 END) blocked,
      SUM(CASE WHEN rno.status='failed' THEN 1 ELSE 0 END) failed,
      SUM(CASE WHEN rno.status IN ('sent','delivered') THEN 1 ELSE 0 END) sent_or_delivered,
      SUM(CASE WHEN rno.status='delivered' THEN 1 ELSE 0 END) delivered
      FROM repair_notification_outbox rno ${branchJoin} WHERE ${where}`, args });
    const policy = await channelPolicy();
    res.json({ ...(counts||{}), policy });
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.get('/queue', requirePermission('work_orders'), async (req,res)=>{
  try {
    const { status, channel, branch_id, limit=200 } = req.query;
    const args=[]; let where='1=1';
    if(status){ where+=' AND rno.status=?'; args.push(status); }
    if(channel){ where+=' AND rno.channel=?'; args.push(channel); }
    if(branch_id){ where+=' AND wo.branch_id=?'; args.push(branch_id); }
    args.push(Math.min(Math.max(parseInt(limit)||200,1),500));
    const { rows } = await db.execute({ sql:`SELECT rno.*,wo.wo_number,wo.status work_order_status,wo.branch_id,b.name branch_name,
      c.first_name||' '||c.last_name customer_name,c.email customer_email,c.phone customer_phone
      FROM repair_notification_outbox rno
      JOIN work_orders wo ON wo.id=rno.work_order_id
      LEFT JOIN branches b ON b.id=wo.branch_id
      LEFT JOIN customers c ON c.id=rno.customer_id
      WHERE ${where}
      ORDER BY CASE rno.status WHEN 'failed' THEN 0 WHEN 'blocked' THEN 1 WHEN 'queued' THEN 2 ELSE 3 END,rno.created_at DESC,rno.id DESC LIMIT ?`, args });
    res.json(rows);
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.post('/:id/retry', requirePermission('work_orders'), async (req,res)=>{
  try {
    const { rows:[row] } = await db.execute({ sql:'SELECT * FROM repair_notification_outbox WHERE id=?', args:[req.params.id] });
    if(!row)return res.status(404).json({error:'Notification not found'});
    const policy = await channelPolicy();
    const allowed = !!policy[row.channel];
    if(!allowed)return res.status(409).json({error:`${row.channel} repair notifications are not enabled`});
    if(!row.recipient)return res.status(409).json({error:'Notification has no recipient'});
    if(['sent','delivered'].includes(row.status))return res.status(409).json({error:'Notification is already sent'});
    await db.execute({ sql:`UPDATE repair_notification_outbox SET status='queued',blocked_reason=NULL,last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?`, args:[req.params.id] });
    const { rows:[updated] } = await db.execute({ sql:'SELECT * FROM repair_notification_outbox WHERE id=?', args:[req.params.id] });
    res.json(updated);
  } catch(e) { res.status(400).json({error:e.message}); }
});

// Provider/worker callback endpoint. This does not send messages itself; it records
// verified transport outcomes so the POS never claims delivery without evidence.
router.patch('/:id/delivery', requirePermission('work_orders'), async (req,res)=>{
  try {
    const next = String(req.body?.status||'');
    if(!validStatuses.has(next))return res.status(400).json({error:'Invalid notification status'});
    const { rows:[row] } = await db.execute({ sql:'SELECT * FROM repair_notification_outbox WHERE id=?', args:[req.params.id] });
    if(!row)return res.status(404).json({error:'Notification not found'});
    const sentAt = ['sent','delivered'].includes(next) ? 'COALESCE(sent_at,CURRENT_TIMESTAMP)' : 'sent_at';
    const deliveredAt = next==='delivered' ? 'COALESCE(delivered_at,CURRENT_TIMESTAMP)' : 'delivered_at';
    await db.execute({ sql:`UPDATE repair_notification_outbox SET status=?,external_reference=COALESCE(?,external_reference),last_error=?,attempts=attempts+CASE WHEN ? IN ('sending','sent','failed') THEN 1 ELSE 0 END,sent_at=${sentAt},delivered_at=${deliveredAt},updated_at=CURRENT_TIMESTAMP WHERE id=?`, args:[next,req.body?.external_reference||null,req.body?.last_error||null,next,req.params.id] });
    const { rows:[updated] } = await db.execute({ sql:'SELECT * FROM repair_notification_outbox WHERE id=?', args:[req.params.id] });
    res.json(updated);
  } catch(e) { res.status(400).json({error:e.message}); }
});

module.exports = router;
