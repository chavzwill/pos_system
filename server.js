require('dotenv').config({ quiet: true });
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const { ensureReady, db } = require('./database');
const { router: woocommerceRouter, runSyncAll: wooSyncAll } = require('./routes/woocommerce');
const { router: repairNotificationWorkerRouter, processQueue: processRepairNotificationQueue } = require('./routes/repair-notification-worker');
const { apiKeyAuth } = require('./lib/apiKeyAuth');
const { sessionAuth } = require('./lib/sessionAuth');
const { logActivity } = require('./routes/crm');

process.on('unhandledRejection', (reason) => { console.error('Unhandled promise rejection:', reason); });
process.on('uncaughtException', (err) => { console.error('Uncaught exception:', err); });

const app = express();
const PORT = process.env.PORT || 3001;
const publicDir = path.join(__dirname, 'public');
const indexPath = path.join(publicDir, 'index.html');
const fastShellPath = path.join(publicDir, 'app-shell.html');
const CLIENT_ASSET_VERSION = '20260824-0800';

let enhancedIndexCache = null;
let legacyAppScriptCache = null;
function versioned(asset) { return `${asset}?v=${CLIENT_ASSET_VERSION}`; }
function extractLegacyApp(source) {
  const marker = 'const App = {';
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) throw new Error('Legacy POS App marker not found in public/index.html');
  const scriptStart = source.lastIndexOf('<script', markerIndex);
  const scriptOpenEnd = scriptStart >= 0 ? source.indexOf('>', scriptStart) : -1;
  const scriptEnd = source.indexOf('</script>', markerIndex);
  if (scriptStart < 0 || scriptOpenEnd < 0 || scriptEnd < 0) throw new Error('Legacy POS App script boundaries could not be resolved');
  const script = source.slice(scriptOpenEnd + 1, scriptEnd);
  new vm.Script(script, { filename: 'legacy-pos-app.js' });
  return { script, start: scriptStart, end: scriptEnd + '</script>'.length };
}
function getLegacyAppScript() {
  if (legacyAppScriptCache) return legacyAppScriptCache;
  const source = fs.readFileSync(indexPath, 'utf8');
  legacyAppScriptCache = extractLegacyApp(source).script;
  return legacyAppScriptCache;
}
function getEnhancedIndex() {
  if (enhancedIndexCache) return enhancedIndexCache;
  const source = fs.readFileSync(indexPath, 'utf8');
  const legacy = extractLegacyApp(source);
  legacyAppScriptCache = legacy.script;
  const headAssets = [
    '<script src="' + versioned('/client-diagnostics.js') + '" defer></script>',
    '<link rel="stylesheet" href="' + versioned('/total-tools-pos.css') + '">',
    '<link rel="stylesheet" href="' + versioned('/pos-experience.css') + '">',
    '<link rel="stylesheet" href="' + versioned('/employee-workspace-home.css') + '">',
  ];
  const bodyAssets = [
    '<script src="' + versioned('/pos-guide-map.js') + '" defer></script>',
    '<script src="' + versioned('/guided-mode.js') + '" defer></script>',
    '<script src="' + versioned('/pos-upgrade-navigation.js') + '" defer></script>',
    '<script src="' + versioned('/navigation-shell.js') + '" defer></script>',
    '<script src="' + versioned('/role-workspace.js') + '" defer></script>',
    '<script src="' + versioned('/employee-workspace-home.js') + '" defer></script>',
    '<script src="' + versioned('/login-controller.js') + '" defer></script>',
  ];
  let html = source.slice(0, legacy.start) + '<script src="' + versioned('/legacy-pos-app.js') + '" defer></script>' + source.slice(legacy.end);
  for (const tag of headAssets) html = html.replace('</head>', `  ${tag}\n</head>`);
  for (const tag of bodyAssets) html = html.replace('</body>', `  ${tag}\n</body>`);
  enhancedIndexCache = html;
  return html;
}
function sendEnhancedIndex(req, res) {
  try {
    res.set('Cache-Control', 'private, no-cache, max-age=0, must-revalidate');
    res.type('html').send(getEnhancedIndex());
  } catch (error) {
    console.error('Unable to render enhanced POS shell:', error && (error.stack || error.message || error));
    res.status(500).type('text').send('POS shell validation failed.');
  }
}
function sendFastShell(req,res) {
  res.set('Cache-Control','private, no-cache, max-age=0, must-revalidate');
  res.sendFile(fastShellPath);
}

app.set('trust proxy', true);
app.use(cors());
app.use(compression());
app.use(bodyParser.json({ limit: '10mb' }));
app.post('/client-diagnostics', (req, res) => { const body=req.body||{}; console.error('POS client diagnostic:', { kind:String(body.kind||'').slice(0,80), detail:String(body.detail||'').slice(0,4000), href:String(body.href||'').slice(0,500), ua:String(body.ua||'').slice(0,500), ts:String(body.ts||'').slice(0,80) }); res.status(204).end(); });
app.get('/legacy-pos-app.js', (req,res)=>{ try{res.set('Cache-Control','public, max-age=3600, stale-while-revalidate=86400');res.type('application/javascript').send(getLegacyAppScript());}catch(error){console.error('Unable to serve validated legacy POS application script:',error&&(error.stack||error.message||error));res.status(500).type('application/javascript').send('throw new Error("POS application script validation failed");');}});
app.get('/', sendFastShell);
app.get('/legacy', sendEnhancedIndex);
app.use(express.static(publicDir, { index:false, etag:true, maxAge:'1h', setHeaders:(res,filePath)=>{ if (/\.(?:js|css|png|jpg|jpeg|gif|svg|webp|ico)$/i.test(filePath)) res.set('Cache-Control','public, max-age=3600, stale-while-revalidate=86400'); else res.set('Cache-Control','no-cache, must-revalidate'); } }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), { maxAge:'1h' }));
app.use(async (req,res,next)=>{try{await ensureReady();next();}catch(e){console.error('POS database initialization failed:',e&&(e.stack||e.message||e));res.status(500).json({error:'Database initialization failed'});}});

app.use('/api', apiKeyAuth);
app.use('/api', sessionAuth);
app.use('/api/workspace-profile', require('./routes/workspace-profile'));
app.use('/api/employee-workspace-intelligence', require('./routes/employee-workspace-intelligence'));
app.use('/api/technician-management-intelligence', require('./routes/technician-management-intelligence'));
app.use('/api/products', require('./routes/products'));
app.use('/api/categories', require('./routes/categories'));
app.use('/api/commerce-sync', require('./routes/commerce-sync'));
app.use('/api/smartcommerce-orders', require('./routes/smartcommerce-orders'));
app.use('/api/customer-repair-portal', require('./routes/customer-repair-portal'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/held-sales', require('./routes/held-sales'));
app.use('/api/transactions', require('./routes/held-sale-recall-hardening'));
app.use('/api/transactions', require('./routes/retail-cost-integrity'));
app.use('/api/transactions', require('./routes/replacement-return-hardening'));
app.use('/api/transactions', require('./routes/transactions'));
app.use('/api/employees', require('./routes/employees'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/operational-reports', require('./routes/operational-reports'));
app.use('/api/accounting-intelligence', require('./routes/accounting-intelligence'));
app.use('/api/financial-controls-intelligence', require('./routes/financial-controls-intelligence'));
app.use('/api/supplier-ledger', require('./routes/supplier-ledger'));
app.use('/api/settlement-reconciliation', require('./routes/settlement-reconciliation'));
app.use('/api/accounting-ledger', require('./routes/accounting-ledger'));
app.use('/api/accounting-source-sync', require('./routes/accounting-source-sync'));
app.use('/api/erp-intelligence', require('./routes/erp-intelligence'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/branches', require('./routes/branches'));
app.use('/api/suppliers', require('./routes/suppliers'));
app.use('/api/purchase-orders', require('./routes/purchase-order-document-context'));
app.use('/api/purchase-orders', require('./routes/purchase-order-hardening'));
app.use('/api/purchase-orders', require('./routes/purchase-orders'));
app.use('/api/purchase-requests',require('./routes/purchase-requests'));
app.use('/api/security-groups', require('./routes/security-groups'));
app.use('/api/quotations', require('./routes/quotations'));
app.use('/api/accounts', require('./routes/accounts'));
app.use('/api/transfers', require('./routes/transfers'));
app.use('/api/stock-rebalancing',require('./routes/stock-rebalancing'));
app.use('/api/inventory-intelligence', require('./routes/inventory-intelligence'));
app.use('/api/logistics-intelligence', require('./routes/logistics-intelligence'));
app.use('/api/scheduling-intelligence', require('./routes/scheduling-intelligence'));
app.use('/api/crm', require('./routes/crm'));
app.use('/api/commissions', require('./routes/commissions'));
app.use('/api/email', require('./routes/email'));
app.use('/api/warehouse', require('./routes/warehouse'));
app.use('/api/drawers', require('./routes/drawers'));
app.use('/api/promotions', require('./routes/promotions'));
app.use('/api/discount-cards', require('./routes/discount-cards'));
app.use('/api/cash-back-cards', require('./routes/cash-back-cards'));
app.use('/api/denominations', require('./routes/denominations'));
app.use('/api/woocommerce', woocommerceRouter);
app.use('/api/api-keys', require('./routes/api-keys'));
app.use('/api/rentals', require('./routes/rentals'));
app.use('/api/layaway', require('./routes/layaway'));
app.use('/api/work-orders', require('./routes/work-order-completion-hardening'));
app.use('/api/work-orders', require('./routes/work-orders'));
app.use('/api/repair-operations', require('./routes/repair-operations'));
app.use('/api/repair-quality', require('./routes/repair-quality'));
app.use('/api/repair-communications', require('./routes/repair-communications'));
app.use('/api/repair-notifications', require('./routes/repair-notifications'));
app.use('/api/repair-notification-worker', repairNotificationWorkerRouter);
app.use('/api/repair-authorizations', require('./routes/repair-authorizations'));
app.use('/api/repair-parts-integrity', require('./routes/repair-parts-hardening'));
app.use('/api/repair-parts-integrity', require('./routes/repair-parts-integrity'));
app.use('/api/technician-compensation/performance', require('./routes/technician-performance'));
app.use('/api/technician-compensation', require('./routes/technician-compensation'));
app.use('/api', (err,req,res,next)=>{if(res.headersSent)return next(err);res.status(err.status||500).json({error:err.message||'Request failed'});});
app.get('*', (req,res)=> req.path.startsWith('/legacy') ? sendEnhancedIndex(req,res) : sendFastShell(req,res));

if (!process.env.VERCEL) {
  app.listen(PORT, () => { console.log(`\n  POS System running at http://localhost:${PORT}\n`); });
  setInterval(async()=>{try{await ensureReady();const{rows:[iRow]}=await db.execute({sql:"SELECT value FROM settings WHERE key='woo_sync_interval'",args:[]});const mins=parseInt(iRow?.value||'0');if(!mins)return;const{rows:[lRow]}=await db.execute({sql:"SELECT value FROM settings WHERE key='woo_last_auto_sync'",args:[]});const last=lRow?.value?new Date(lRow.value):new Date(0);if((Date.now()-last.getTime())/60000>=mins)wooSyncAll().catch(()=>{});}catch(e){}},60000);
  setInterval(async()=>{try{await ensureReady();const{rows:overdue}=await db.execute({sql:"SELECT * FROM rental_agreements WHERE status='active' AND due_date < date('now') AND overdue_notified_at IS NULL",args:[]});for(const agreement of overdue){try{await db.execute({sql:'UPDATE rental_agreements SET overdue_notified_at = CURRENT_TIMESTAMP WHERE id = ?',args:[agreement.id]});await logActivity({customerId:agreement.customer_id,employeeId:agreement.employee_id,type:'rental',subject:`Rental ${agreement.agreement_number} is overdue (due ${agreement.due_date})`,dueDate:agreement.due_date,completed:false});}catch(e){}}}catch(e){}},30*60000);
  setInterval(()=>{ processRepairNotificationQueue(20).catch(e=>console.error('Repair notification worker failed:',e&&e.message||e)); },60000);
}
module.exports = app;