require('dotenv').config({ quiet: true });
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const compression = require('compression');
const path = require('path');
const fs = require('fs');

const { ensureReady, db } = require('./database');
const { router: woocommerceRouter, runSyncAll: wooSyncAll } = require('./routes/woocommerce');
const { apiKeyAuth } = require('./lib/apiKeyAuth');
const { sessionAuth } = require('./lib/sessionAuth');
const { logActivity } = require('./routes/crm');

process.on('unhandledRejection', (reason) => { console.error('Unhandled promise rejection:', reason); });
process.on('uncaughtException', (err) => { console.error('Uncaught exception:', err); });

const app = express();
const PORT = process.env.PORT || 3001;
const publicDir = path.join(__dirname, 'public');
const indexPath = path.join(publicDir, 'index.html');

// Keep the large legacy SPA intact while layering the Total Tools POS visual
// system and Guided Mode on top. This avoids a risky 1MB index.html rewrite.
let enhancedIndexCache = null;
function getEnhancedIndex() {
  if (enhancedIndexCache && process.env.NODE_ENV === 'production') return enhancedIndexCache;
  const source = fs.readFileSync(indexPath, 'utf8');
  const cssTag = '<link rel="stylesheet" href="/total-tools-pos.css">';
  const scriptTag = '<script src="/guided-mode.js" defer></script>';
  let html = source;
  if (!html.includes('/total-tools-pos.css')) html = html.replace('</head>', `  ${cssTag}\n</head>`);
  if (!html.includes('/guided-mode.js')) html = html.replace('</body>', `  ${scriptTag}\n</body>`);
  if (process.env.NODE_ENV === 'production') enhancedIndexCache = html;
  return html;
}
function sendEnhancedIndex(req, res) {
  try { res.type('html').send(getEnhancedIndex()); }
  catch (error) { console.error('Unable to render enhanced POS shell:', error); res.sendFile(indexPath); }
}

app.set('trust proxy', true);
app.use(cors());
app.use(compression());
app.use(bodyParser.json({ limit: '10mb' }));

app.get('/', sendEnhancedIndex);
app.use(express.static(publicDir, { index: false }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use(async (req, res, next) => {
  try { await ensureReady(); next(); } catch(e) { res.status(500).json({ error: 'Database initialization failed' }); }
});

app.use('/api', apiKeyAuth);
app.use('/api', sessionAuth);

app.use('/api/products',         require('./routes/products'));
app.use('/api/categories',       require('./routes/categories'));
app.use('/api/customers',        require('./routes/customers'));
app.use('/api/transactions',     require('./routes/transactions'));
app.use('/api/employees',        require('./routes/employees'));
app.use('/api/reports',          require('./routes/reports'));
app.use('/api/settings',         require('./routes/settings'));
app.use('/api/branches',         require('./routes/branches'));
app.use('/api/suppliers',        require('./routes/suppliers'));
app.use('/api/purchase-orders',  require('./routes/purchase-orders'));
app.use('/api/purchase-requests',require('./routes/purchase-requests'));
app.use('/api/security-groups',  require('./routes/security-groups'));
app.use('/api/quotations',       require('./routes/quotations'));
app.use('/api/accounts',         require('./routes/accounts'));
app.use('/api/transfers',        require('./routes/transfers'));
app.use('/api/crm',              require('./routes/crm'));
app.use('/api/commissions',      require('./routes/commissions'));
app.use('/api/email',            require('./routes/email'));
app.use('/api/warehouse',        require('./routes/warehouse'));
app.use('/api/drawers',          require('./routes/drawers'));
app.use('/api/promotions',       require('./routes/promotions'));
app.use('/api/discount-cards',   require('./routes/discount-cards'));
app.use('/api/cash-back-cards',  require('./routes/cash-back-cards'));
app.use('/api/denominations',    require('./routes/denominations'));
app.use('/api/woocommerce',      woocommerceRouter);
app.use('/api/api-keys',         require('./routes/api-keys'));
app.use('/api/rentals',          require('./routes/rentals'));
app.use('/api/layaway',          require('./routes/layaway'));
app.use('/api/work-orders',      require('./routes/work-orders'));
app.use('/api/technician-compensation', require('./routes/technician-compensation'));

app.use('/api', (err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.message || 'Request failed' });
});

app.get('*', sendEnhancedIndex);

if (!process.env.VERCEL) {
  app.listen(PORT, () => { console.log(`\n  POS System running at http://localhost:${PORT}\n`); });

  setInterval(async () => {
    try {
      await ensureReady();
      const { rows: [iRow] } = await db.execute({ sql: "SELECT value FROM settings WHERE key='woo_sync_interval'", args: [] });
      const mins = parseInt(iRow?.value || '0');
      if (!mins) return;
      const { rows: [lRow] } = await db.execute({ sql: "SELECT value FROM settings WHERE key='woo_last_auto_sync'", args: [] });
      const last = lRow?.value ? new Date(lRow.value) : new Date(0);
      if ((Date.now() - last.getTime()) / 60000 >= mins) wooSyncAll().catch(() => {});
    } catch (e) {}
  }, 60000);

  setInterval(async () => {
    try {
      await ensureReady();
      const { rows: overdue } = await db.execute({ sql: "SELECT * FROM rental_agreements WHERE status='active' AND due_date < date('now') AND overdue_notified_at IS NULL", args: [] });
      for (const agreement of overdue) {
        try {
          await db.execute({ sql: 'UPDATE rental_agreements SET overdue_notified_at = CURRENT_TIMESTAMP WHERE id = ?', args: [agreement.id] });
          await logActivity({ customerId: agreement.customer_id, employeeId: agreement.employee_id, type: 'rental', subject: `Rental ${agreement.agreement_number} is overdue (due ${agreement.due_date})`, dueDate: agreement.due_date, completed: false });
        } catch(e) {}
      }
    } catch (e) {}
  }, 30 * 60000);
}

module.exports = app;
