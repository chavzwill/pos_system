const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { db } = require('../database');
const { requireAuth, requirePermission, can } = require('../lib/permissions');
const { ensureSecurityAuditTable, recordSecurityAudit } = require('../lib/securityAudit');
const { cloudUpload, cloudDestroy } = require('../lib/cloudinary');
const { validateMemoryUpload, imageMulterFilter } = require('../lib/uploadSecurity');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 1,
    fields: 2,
    parts: 3,
    fieldNameSize: 100,
    fieldSize: 64 * 1024,
    headerPairs: 50,
  },
  fileFilter: imageMulterFilter,
});

const SECRET_KEYS = new Set([
  'email_smtp_pass','repair_notify_sms_webhook_token','repair_notify_whatsapp_webhook_token',
  'woocommerce_consumer_secret','woocommerce_webhook_secret','stripe_secret_key','stripe_webhook_secret',
  'twilio_auth_token','whatsapp_access_token','openai_api_key'
]);
const INTEGRATION_KEYS = new Set([
  'email_smtp_host','email_smtp_port','email_smtp_secure','email_smtp_user','email_smtp_pass','email_from',
  'repair_notify_email_enabled','repair_notify_sms_enabled','repair_notify_whatsapp_enabled',
  'repair_notify_sms_webhook_url','repair_notify_sms_webhook_token',
  'repair_notify_whatsapp_webhook_url','repair_notify_whatsapp_webhook_token',
  'woo_sync_interval','woocommerce_consumer_secret','woocommerce_webhook_secret','stripe_secret_key','stripe_webhook_secret',
  'twilio_auth_token','whatsapp_access_token','openai_api_key'
]);
const COMPANY_KEYS = new Set(['store_name','store_phone','store_email','store_address','currency','receipt_footer']);
const TAX_KEYS = new Set(['tax_rate']);
const MANAGED_KEYS = new Set([
  ...COMPANY_KEYS,...TAX_KEYS,
  'email_smtp_host','email_smtp_port','email_smtp_secure','email_smtp_user','email_smtp_pass','email_from',
  'repair_notify_email_enabled','repair_notify_sms_enabled','repair_notify_whatsapp_enabled',
  'repair_notify_sms_webhook_url','repair_notify_sms_webhook_token',
  'repair_notify_whatsapp_webhook_url','repair_notify_whatsapp_webhook_token',
  'wo_assessment_fee','woo_sync_interval',
  'loss_control_min_gross_margin_pct','loss_control_margin_override_allow_self',
  'loss_control_cash_shortage_threshold','loss_control_return_rate_threshold_pct',
  'loss_control_return_value_threshold','loss_control_dead_stock_days'
]);
function redact(key,value){ return SECRET_KEYS.has(key) && value ? '••••••••' : value; }
function isIntegrationKey(key){ return INTEGRATION_KEYS.has(key) || SECRET_KEYS.has(key); }
function canManageIntegrations(req){ return !req.apiKey && can(req.employee?.permissions,'settings_integrations'); }
function explicitBroadSettings(req){ return req.employee?.permissions?.settings === true; }
function requiredPermissionForKey(key){
  if(isIntegrationKey(key)) return 'settings_integrations';
  if(COMPANY_KEYS.has(key)) return 'settings_company';
  if(TAX_KEYS.has(key)) return 'settings_tax';
  return 'settings';
}
function canManageKey(req,key){
  const required=requiredPermissionForKey(key);
  if(required==='settings_integrations') return canManageIntegrations(req);
  if(required==='settings_company' || required==='settings_tax') return can(req.employee?.permissions,required);
  return explicitBroadSettings(req);
}
function blockApiKey(req,res){
  if(!req.apiKey) return false;
  res.status(403).json({error:'API keys cannot read or modify internal settings administration'});
  return true;
}
function auditValue(key,value){
  if(isIntegrationKey(key)) return { configured: value != null && String(value) !== '' };
  return value == null ? '' : String(value);
}
async function auditSettingsChange(tx,req,action,oldValues,newValues,reason){
  await recordSecurityAudit({
    executor:tx,
    actorEmployeeId:req.employee?.id||null,
    action,
    targetType:'settings',
    oldValue:oldValues,
    newValue:newValues,
    reason:reason||'Settings configuration updated',
    requestId:req.requestId||null,
    method:req.method||null,
    path:String(req.originalUrl||req.path||'').split('?')[0],
    control:'settings_governance',
  });
}

router.get('/', requireAuth, async (req, res) => {
  if(blockApiKey(req,res)) return;
  try {
    const { rows } = await db.execute({ sql: 'SELECT * FROM settings', args: [] });
    const settings = {};
    const integrationAuthority = canManageIntegrations(req);
    rows.forEach(r => {
      if(isIntegrationKey(r.key) && !integrationAuthority) return;
      settings[r.key] = redact(r.key,r.value);
    });
    res.json(settings);
  } catch(e) { res.status(500).json({ error: 'Unable to load settings' }); }
});

router.get('/manage', requirePermission('settings'), async (req,res)=>{
  if(blockApiKey(req,res)) return;
  try {
    const integrationAuthority=canManageIntegrations(req);
    const { rows } = await db.execute({ sql:'SELECT key,value FROM settings ORDER BY key', args:[] });
    const values={};
    for(const row of rows){
      if(!MANAGED_KEYS.has(row.key) || !canManageKey(req,row.key)) continue;
      values[row.key]=redact(row.key,row.value);
    }
    res.json({
      values,
      secret_keys:integrationAuthority?[...SECRET_KEYS].filter(k=>MANAGED_KEYS.has(k)):[],
      integration_authority:integrationAuthority,
      capabilities:{
        company:can(req.employee?.permissions,'settings_company'),
        tax:can(req.employee?.permissions,'settings_tax'),
        integrations:integrationAuthority,
        general:explicitBroadSettings(req),
      },
    });
  } catch(e){ res.status(500).json({error:'Unable to load managed settings'}); }
});

router.get('/public', async (req, res) => {
  try {
    const { rows } = await db.execute({ sql: "SELECT key, value FROM settings WHERE key IN ('store_name','company_logo_url')", args: [] });
    const settings = {};
    rows.forEach(r => { settings[r.key] = r.value; });
    res.json(settings);
  } catch(e) { res.status(500).json({ error: 'Unable to load public settings' }); }
});

router.put('/', requirePermission('settings'), async (req, res) => {
  if(blockApiKey(req,res)) return;
  try {
    const body=req.body||{};
    const entries=Object.entries(body).filter(([key])=>MANAGED_KEYS.has(key));
    if(!entries.length) return res.status(400).json({error:'No supported settings supplied'});
    for(const [key] of entries){
      if(canManageKey(req,key)) continue;
      const required=requiredPermissionForKey(key);
      const message=required==='settings_integrations'
        ? 'Integration and secret settings require explicit Integration Settings authority'
        : `Missing permission: ${required}`;
      return res.status(403).json({error:message});
    }
    const integrationEntries=entries.filter(([key])=>isIntegrationKey(key));
    const reason=String(body.reason||body._reason||'').trim();
    if(integrationEntries.length && reason.length<8){
      return res.status(400).json({error:'A reason is required for integration or secret settings changes'});
    }

    await ensureSecurityAuditTable();
    const keys=entries.map(([key])=>key);
    const placeholders=keys.map(()=>'?').join(',');
    const tx=await db.transaction('write');
    try{
      const {rows:existingRows}=await tx.execute({sql:`SELECT key,value FROM settings WHERE key IN (${placeholders})`,args:keys});
      const existing=new Map(existingRows.map(row=>[row.key,row.value]));
      const oldValues={};
      const newValues={};
      const changedKeys=[];
      for(const [key,value] of entries){
        if(SECRET_KEYS.has(key) && (value==='••••••••' || value==='')) continue;
        const next=value==null?'':String(value);
        const previous=existing.has(key)?existing.get(key):null;
        if(String(previous??'')===next) continue;
        await tx.execute({sql:'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',args:[key,next]});
        oldValues[key]=auditValue(key,previous);
        newValues[key]=auditValue(key,next);
        changedKeys.push(key);
      }
      if(!changedKeys.length){
        await tx.rollback().catch(()=>{});
        return res.json({success:true,changed_keys:[]});
      }
      await auditSettingsChange(tx,req,integrationEntries.length?'integration_settings_updated':'settings_updated',oldValues,newValues,integrationEntries.length?reason:'Settings configuration updated');
      await tx.commit();
      res.json({success:true,changed_keys:changedKeys});
    }catch(error){
      await tx.rollback().catch(()=>{});
      throw error;
    }
  } catch(e) { res.status(500).json({ error: 'Unable to update settings' }); }
});

router.post('/logo', requirePermission('settings'), upload.single('logo'), async (req, res) => {
  if(blockApiKey(req,res)) return;
  if(!can(req.employee?.permissions,'settings_company')) return res.status(403).json({error:'Missing permission: settings_company'});
  if (!req.file) return res.status(400).json({ error: 'A JPEG, PNG, or WebP logo is required' });
  const validation = validateMemoryUpload(req.file, { kind: 'image' });
  if (!validation.ok) return res.status(415).json({ error: validation.error });
  try {
    const { rows: [existing] } = await db.execute({ sql: "SELECT value FROM settings WHERE key = 'company_logo_url'", args: [] });
    const result = await cloudUpload(req.file.buffer, { folder: 'pos-system/branding', public_id: 'company-logo', overwrite: true, resource_type: 'image' });
    let logoUrl;
    if (result) logoUrl = result.secure_url;
    else {
      const dir = path.join(__dirname, '../uploads/branding');
      fs.mkdirSync(dir, { recursive: true });
      const filename = `company-logo-${Date.now()}${validation.extension}`;
      fs.writeFileSync(path.join(dir, filename), req.file.buffer);
      logoUrl = `/uploads/branding/${filename}`;
    }
    await ensureSecurityAuditTable();
    const tx=await db.transaction('write');
    try{
      await tx.execute({ sql: 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', args: ['company_logo_url', logoUrl] });
      await auditSettingsChange(tx,req,'company_logo_updated',{company_logo_url:existing?.value||null},{company_logo_url:logoUrl},'Company logo updated');
      await tx.commit();
    }catch(error){
      await tx.rollback().catch(()=>{});
      if(!result){const created=path.join(__dirname,'..',logoUrl);if(fs.existsSync(created))fs.unlinkSync(created);}
      throw error;
    }
    if (existing?.value && existing.value !== logoUrl) {
      if (existing.value.startsWith('https://')) await cloudDestroy(existing.value).catch(()=>{});
      else { const old = path.join(__dirname, '..', existing.value); if (fs.existsSync(old)) fs.unlinkSync(old); }
    }
    res.json({ logo_url: logoUrl });
  } catch(e) { res.status(500).json({ error: 'Unable to store company logo' }); }
});

router.delete('/logo', requirePermission('settings'), async (req, res) => {
  if(blockApiKey(req,res)) return;
  if(!can(req.employee?.permissions,'settings_company')) return res.status(403).json({error:'Missing permission: settings_company'});
  try {
    const { rows: [existing] } = await db.execute({ sql: "SELECT value FROM settings WHERE key = 'company_logo_url'", args: [] });
    await ensureSecurityAuditTable();
    const tx=await db.transaction('write');
    try{
      await tx.execute({ sql: "DELETE FROM settings WHERE key = 'company_logo_url'", args: [] });
      await auditSettingsChange(tx,req,'company_logo_deleted',{company_logo_url:existing?.value||null},{company_logo_url:null},'Company logo removed');
      await tx.commit();
    }catch(error){
      await tx.rollback().catch(()=>{});
      throw error;
    }
    if (existing?.value) {
      if (existing.value.startsWith('https://')) await cloudDestroy(existing.value).catch(()=>{});
      else { const old = path.join(__dirname, '..', existing.value); if (fs.existsSync(old)) fs.unlinkSync(old); }
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Unable to remove company logo' }); }
});

module.exports = router;