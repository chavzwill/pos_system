const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission } = require('../lib/permissions');

let schemaReady = false;
async function ensureSchema() {
  if (schemaReady) return;
  await db.batch([
    { sql: `CREATE TABLE IF NOT EXISTS held_sale_recall_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      held_transaction_id INTEGER NOT NULL UNIQUE,
      held_transaction_number TEXT,
      completed_transaction_id INTEGER NOT NULL UNIQUE,
      completed_transaction_number TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )` },
    { sql: 'CREATE INDEX IF NOT EXISTS idx_held_sale_recall_completed ON held_sale_recall_links(completed_transaction_id)' },
  ], 'write');
  schemaReady = true;
}

router.use(async (req, res, next) => {
  try { await ensureSchema(); next(); }
  catch (e) { res.status(500).json({ error: 'Held-sale integrity initialization failed', detail: e.message }); }
});

// A held sale is only a suspended intent, but its displayed value still needs to
// come from authoritative catalog evidence. Do not trust unit_price/tax_rate
// supplied by the browser when creating a hold.
router.post('/hold', requirePermission('pos_hold'), async (req, res, next) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return next();
    const authoritative = [];
    for (const line of items) {
      const productId = Number(line.product_id);
      const quantity = Number(line.quantity);
      if (!productId || !Number.isInteger(quantity) || quantity <= 0) {
        return res.status(400).json({ error: 'Every held-sale line requires a product and positive whole-number quantity' });
      }
      const { rows: [product] } = await db.execute({ sql: 'SELECT id,name,sku,price,tax_rate,active,is_service,is_rental FROM products WHERE id=?', args: [productId] });
      if (!product || !product.active) return res.status(400).json({ error: `Product ${productId} is unavailable` });
      if (product.is_service || product.is_rental) return res.status(400).json({ error: `${product.name} cannot be placed on a standard retail hold` });
      authoritative.push({
        ...line,
        product_id: product.id,
        product_name: product.name,
        sku: product.sku || '',
        quantity,
        unit_price: Number(product.price || 0),
        tax_rate: Number(product.tax_rate || 0),
      });
    }
    req.body.items = authoritative;
    next();
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Recall completion is intentionally two-stage in the current application:
// create the replacement sale, then close the hold. Preserve an idempotency link
// so a network/error retry cannot create the same recalled sale twice.
router.post('/', requirePermission('pos'), async (req, res, next) => {
  try {
    const heldId = Number(req.body?.source_hold_id || 0);
    if (!heldId) return next();

    const { rows: [held] } = await db.execute({ sql: `SELECT id,transaction_number,status,branch_id,customer_id FROM transactions WHERE id=?`, args: [heldId] });
    if (!held) return res.status(404).json({ error: 'Source held sale was not found' });

    const { rows: [link] } = await db.execute({ sql: 'SELECT * FROM held_sale_recall_links WHERE held_transaction_id=?', args: [heldId] });
    if (link) {
      const { rows: [completed] } = await db.execute({ sql: `SELECT * FROM transactions WHERE id=? AND status='completed'`, args: [link.completed_transaction_id] });
      if (!completed) return res.status(409).json({ error: 'Held-sale recall evidence points to a missing completed transaction' });
      completed.recall_replayed = true;
      completed.source_hold_id = heldId;
      return res.json(completed);
    }

    if (held.status !== 'hold') return res.status(409).json({ error: 'Source held sale is no longer open for recall' });
    if (req.body.branch_id && String(req.body.branch_id) !== String(held.branch_id || '')) {
      return res.status(409).json({ error: 'A recalled sale must be completed in the same branch as its hold' });
    }
    if (req.body.customer_id && String(req.body.customer_id) !== String(held.customer_id || '')) {
      return res.status(409).json({ error: 'A recalled sale cannot silently change the held-sale customer' });
    }

    const originalJson = res.json.bind(res);
    res.json = function(payload) {
      if (res.statusCode >= 200 && res.statusCode < 300 && payload?.id && payload?.transaction_number) {
        Promise.resolve().then(async () => {
          await db.execute({
            sql: `INSERT OR IGNORE INTO held_sale_recall_links(held_transaction_id,held_transaction_number,completed_transaction_id,completed_transaction_number) VALUES(?,?,?,?)`,
            args: [heldId, held.transaction_number || null, payload.id, payload.transaction_number || null],
          });
          payload.source_hold_id = heldId;
          originalJson(payload);
        }).catch(error => {
          console.error('Held-sale recall link preservation failed:', error);
          if (!res.headersSent) res.status(500);
          originalJson({ error: 'The sale was created but recall evidence could not be preserved. Do not retry until the transaction is reviewed.', completed_transaction_id: payload.id, completed_transaction_number: payload.transaction_number });
        });
        return res;
      }
      return originalJson(payload);
    };
    next();
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
