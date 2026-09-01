const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { db } = require('../database');
const { requireAuth, requirePermission, can } = require('../lib/permissions');
const { cloudUpload, cloudDestroy } = require('../lib/cloudinary');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

const SECRET_KEYS = new Set([
  'email_smtp_pass','repair_notify_sms_webhook_token','repair_notify_whatsapp_webhook_token',
  'woocommerce_consumer_secret','woocommerce_webhook_secret','stripe_secret_key','stripe_webhook_secret',
  'twilio_auth_token','whatsapp_access_token','openai_api_key'
]);
const MANAGED_KEYS = new Set([
  'store_name','store_phone','store_email','store_address','currency','tax_rate','receipt_footer',
  'email_smtp_host','email_smtp_port','email_smtp_secure','email_smtp_user','email_smtp_pass','email_from',
  'repair_notify_email_enabled','repair_notify_sms_enabled','repair_notify_whatsapp_enabled',
  'repair_notify_sms_webhook_url','repair_notify_sms_webhook_token',
  'repair_notify_whatsapp_webhook_url','repair_notify_whatsapp_webhook_token',
  'wo_assessment_fee','woo_sync_interval',
  'loss_control_min_gross_margin_pct','loss_control_margin_override_allow_self',
  'loss_control_cash_shortage_threshold','loss_control_return_rate_threshold_pct',
  'loss_control_return_value_threshold','loss_control_dead_stock_days'
]);
function mayManage(req){ return !!req.apiKey || can(req.employee?.permissions,'settings'); }
function redact(key,value){ return SECRET_KEYS.has(key) && value ? '••••••••' : value; }

router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.execute({ sql: 'SELECT * FROM settings', args: [] });
    const settings = {};
    const privileged = mayManage(req);
    rows.forEach(r => { settings[r.key] = privileged ? redact(r.key,r.value) : (SECRET_KEYS.has(r.key) ? undefined : r.value); });
    for (const key of Object.keys(settings)) if (settings[key] === undefined) delete settings[key];
    res.json(settings);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/manage', requirePermission('settings'), async (req,res)=>{
  try {
    const { rows } = await db.execute({ sql:'SELECT key,value FROM settings ORDER BY key', args:[] });
    const values={};
    for(const row of rows) if(MANAGED_KEYS.has(row.key)) values[row.key]=redact(row.key,row.value);
    res.json({ values, secret_keys:[...SECRET_KEYS].filter(k=>MANAGED_KEYS.has(k)) });
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.get('/public', async (req, res) => {
  try {
    const { rows } = await db.execute({ sql: "SELECT key, value FROM settings WHERE key IN ('store_name','company_logo_url')", args: [] });
    const settings = {};
    rows.forEach(r => { settings[r.key] = r.value; });
    res.json(settings);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/', requirePermission('settings'), async (req, res) => {
  try {
    const entries=Object.entries(req.body||{}).filter(([key])=>MANAGED_KEYS.has(key));
    if(!entries.length) return res.status(400).json({error:'No supported settings supplied'});
    for (const [key, value] of entries) {
      if(SECRET_KEYS.has(key) && (value === '••••••••' || value === '')) continue;
      await db.execute({ sql: 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', args: [key, value == null ? '' : String(value)] });
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/logo', requirePermission('settings'), upload.single('logo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  try {
    const { rows: [existing] } = await db.execute({ sql: "SELECT value FROM settings WHERE key = 'company_logo_url'", args: [] });
    if (existing?.value) {
      if (existing.value.startsWith('https://')) await cloudDestroy(existing.value);
      else { const old = path.join(__dirname, '..', existing.value); if (fs.existsSync(old)) fs.unlinkSync(old); }
    }
    const result = await cloudUpload(req.file.buffer, { folder: 'pos-system/branding', public_id: 'company-logo', overwrite: true, resource_type: 'image' });
    let logoUrl;
    if (result) logoUrl = result.secure_url;
    else {
      const dir = path.join(__dirname, '../uploads/branding');
      fs.mkdirSync(dir, { recursive: true });
      const ext = path.extname(req.file.originalname).toLowerCase();
      const filename = `company-logo-${Date.now()}${ext}`;
      fs.writeFileSync(path.join(dir, filename), req.file.buffer);
      logoUrl = `/uploads/branding/${filename}`;
    }
    await db.execute({ sql: 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', args: ['company_logo_url', logoUrl] });
    res.json({ logo_url: logoUrl });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/logo', requirePermission('settings'), async (req, res) => {
  try {
    const { rows: [existing] } = await db.execute({ sql: "SELECT value FROM settings WHERE key = 'company_logo_url'", args: [] });
    if (existing?.value) {
      if (existing.value.startsWith('https://')) await cloudDestroy(existing.value);
      else { const old = path.join(__dirname, '..', existing.value); if (fs.existsSync(old)) fs.unlinkSync(old); }
    }
    await db.execute({ sql: "DELETE FROM settings WHERE key = 'company_logo_url'", args: [] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
