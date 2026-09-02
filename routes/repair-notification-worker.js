const express = require('express');
const nodemailer = require('nodemailer');
const router = express.Router();
const { db } = require('../database');
const { revealSettingsRows } = require('../lib/secureSettings');
const { requirePermission } = require('../lib/permissions');

async function settings() {
  const { rows } = await db.execute({ sql: 'SELECT key,value FROM settings', args: [] });
  return revealSettingsRows(rows);
}
function truthy(v){ return ['1','true','yes','on','enabled'].includes(String(v||'').toLowerCase()); }
function errText(e){ return String(e?.message || e || 'Unknown transport error').slice(0,1200); }
function htmlEscape(v){ return String(v||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function buildEmailHtml(job, s){
  const store = htmlEscape(s.store_name || 'Total Tools');
  const subject = htmlEscape(job.subject || 'Repair update');
  const body = htmlEscape(job.body || '').replace(/\n/g,'<br>');
  return `<!doctype html><html><body style="margin:0;background:#f5f7f6;font-family:Arial,sans-serif;color:#17211f"><table width="100%" cellpadding="0" cellspacing="0" style="padding:24px"><tr><td align="center"><table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e1e7e3"><tr><td style="padding:24px;background:#0d5c4e;color:#fff"><div style="font-size:13px;opacity:.85">${store}</div><div style="font-size:24px;font-weight:700;margin-top:4px">${subject}</div></td></tr><tr><td style="padding:24px"><p style="margin:0 0 18px;line-height:1.6">${body}</p><p style="margin:0;color:#6b7671;font-size:12px">Repair ${htmlEscape(job.wo_number || ('#'+job.work_order_id))}</p></td></tr></table></td></tr></table></body></html>`;
}
async function sendEmail(job, s){
  if(!s.email_smtp_host) throw new Error('SMTP is not configured');
  const transporter = nodemailer.createTransport({ host:s.email_smtp_host, port:parseInt(s.email_smtp_port||587), secure:String(s.email_smtp_secure)==='true', auth:s.email_smtp_user?{user:s.email_smtp_user,pass:s.email_smtp_pass||''}:undefined });
  const from = s.email_from || s.email_smtp_user || s.store_email;
  if(!from) throw new Error('Email sender address is not configured');
  const info = await transporter.sendMail({ from, to:job.recipient, subject:job.subject || 'Repair update', text:job.body, html:buildEmailHtml(job,s) });
  return { external_reference: String(info.messageId || '') || null, status:'sent' };
}
async function sendWebhook(job, s){
  const isWhatsapp = job.channel === 'whatsapp';
  const url = String(s[isWhatsapp?'repair_notify_whatsapp_webhook_url':'repair_notify_sms_webhook_url'] || '').trim();
  const token = String(s[isWhatsapp?'repair_notify_whatsapp_webhook_token':'repair_notify_sms_webhook_token'] || '').trim();
  if(!url) throw new Error(`${job.channel} webhook transport is not configured`);
  const headers = { 'Content-Type':'application/json', Accept:'application/json' };
  if(token) headers.Authorization = `Bearer ${token}`;
  const controller = new AbortController(); const timeout=setTimeout(()=>controller.abort(),9000);
  try {
    const response = await fetch(url,{ method:'POST', headers, signal:controller.signal, body:JSON.stringify({ channel:job.channel, to:job.recipient, subject:job.subject, body:job.body, notification_id:job.id, work_order_id:job.work_order_id, wo_number:job.wo_number, event_key:job.event_key }) });
    const payload = await response.json().catch(()=>({}));
    if(!response.ok) throw new Error(`${job.channel} provider returned ${response.status}: ${String(payload?.error || payload?.message || 'request failed')}`);
    const ref = payload.id || payload.message_id || payload.messageId || payload.sid || payload.reference || null;
    const delivery = String(payload.status || '').toLowerCase();
    return { external_reference: ref ? String(ref) : null, status:['delivered'].includes(delivery)?'delivered':'sent' };
  } finally { clearTimeout(timeout); }
}
async function mark(id,status,extra={}){
  const sent = ['sent','delivered'].includes(status); const delivered = status==='delivered';
  await db.execute({ sql:`UPDATE repair_notification_outbox SET status=?,attempts=attempts+1,last_error=?,external_reference=COALESCE(?,external_reference),sent_at=CASE WHEN ? THEN COALESCE(sent_at,CURRENT_TIMESTAMP) ELSE sent_at END,delivered_at=CASE WHEN ? THEN COALESCE(delivered_at,CURRENT_TIMESTAMP) ELSE delivered_at END,updated_at=CURRENT_TIMESTAMP WHERE id=?`, args:[status,extra.last_error||null,extra.external_reference||null,sent?1:0,delivered?1:0,id] });
}
async function claim(limit){
  const { rows } = await db.execute({ sql:`SELECT rno.*,wo.wo_number FROM repair_notification_outbox rno JOIN work_orders wo ON wo.id=rno.work_order_id WHERE rno.status='queued' ORDER BY rno.created_at ASC,rno.id ASC LIMIT ?`, args:[limit] });
  const claimed=[];
  for(const row of rows){
    const result=await db.execute({ sql:`UPDATE repair_notification_outbox SET status='sending',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='queued'`, args:[row.id] });
    if(Number(result.rowsAffected||0)>0) claimed.push(row);
  }
  return claimed;
}
async function processQueue(limit=20){
  const s=await settings(); const jobs=await claim(Math.min(Math.max(parseInt(limit)||20,1),100));
  const results=[];
  for(const job of jobs){
    try {
      let outcome;
      if(job.channel==='email') outcome=await sendEmail(job,s);
      else if(job.channel==='sms' || job.channel==='whatsapp') outcome=await sendWebhook(job,s);
      else throw new Error(`Unsupported notification channel: ${job.channel}`);
      await mark(job.id,outcome.status,{external_reference:outcome.external_reference});
      results.push({id:job.id,status:outcome.status,channel:job.channel,external_reference:outcome.external_reference||null});
    } catch(e) {
      await mark(job.id,'failed',{last_error:errText(e)});
      results.push({id:job.id,status:'failed',channel:job.channel,error:errText(e)});
    }
  }
  return { claimed:jobs.length, processed:results.length, sent:results.filter(x=>x.status==='sent').length, delivered:results.filter(x=>x.status==='delivered').length, failed:results.filter(x=>x.status==='failed').length, results };
}

router.post('/process', requirePermission('work_orders'), async (req,res)=>{
  try { res.json(await processQueue(req.body?.limit)); } catch(e){ res.status(500).json({error:errText(e)}); }
});

router.get('/readiness', requirePermission('work_orders'), async (req,res)=>{
  try {
    const s=await settings();
    res.json({
      email:{ enabled:truthy(s.repair_notify_email_enabled), configured:!!s.email_smtp_host && !!(s.email_from||s.email_smtp_user||s.store_email), provider:'smtp' },
      sms:{ enabled:truthy(s.repair_notify_sms_enabled), configured:!!s.repair_notify_sms_webhook_url, provider:'webhook' },
      whatsapp:{ enabled:truthy(s.repair_notify_whatsapp_enabled), configured:!!s.repair_notify_whatsapp_webhook_url, provider:'webhook' }
    });
  } catch(e){ res.status(500).json({error:errText(e)}); }
});

module.exports={ router, processQueue };
