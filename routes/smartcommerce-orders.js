const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { nextNumber } = require('../lib/nextNumber');
const { syncBinQty } = require('../lib/binSync');

let schemaReady;
async function ensureSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const statements = [
      "ALTER TABLE transactions ADD COLUMN external_order_id TEXT",
      "ALTER TABLE transactions ADD COLUMN external_quote_id TEXT",
      "ALTER TABLE transactions ADD COLUMN external_payment_reference TEXT",
      "ALTER TABLE transactions ADD COLUMN external_customer_id TEXT",
      "ALTER TABLE transactions ADD COLUMN delivery_amount REAL NOT NULL DEFAULT 0",
      "ALTER TABLE transactions ADD COLUMN service_amount REAL NOT NULL DEFAULT 0",
      "ALTER TABLE transactions ADD COLUMN handling_amount REAL NOT NULL DEFAULT 0",
    ];
    for (const sql of statements) {
      try { await db.execute({ sql, args: [] }); } catch (e) {
        if (!/duplicate column|already exists/i.test(String(e?.message || ''))) throw e;
      }
    }
    await db.execute({ sql: 'CREATE UNIQUE INDEX IF NOT EXISTS ux_transactions_external_order_id ON transactions(external_order_id) WHERE external_order_id IS NOT NULL', args: [] });
  })().catch((e) => { schemaReady = null; throw e; });
  return schemaReady;
}

function requireApiKey(req, res, next) {
  if (!req.apiKey) return res.status(401).json({ error: 'API key authentication required' });
  next();
}

function money(value, field) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n < 0) {
    const e = new Error(`${field} must be a non-negative number`);
    e.status = 400;
    throw e;
  }
  return parseFloat(n.toFixed(2));
}

async function loadTransactionByExternalId(externalOrderId) {
  const { rows: [tx] } = await db.execute({ sql: 'SELECT * FROM transactions WHERE external_order_id = ? LIMIT 1', args: [externalOrderId] });
  if (!tx) return null;
  const { rows: items } = await db.execute({ sql: 'SELECT * FROM transaction_items WHERE transaction_id = ? ORDER BY id', args: [tx.id] });
  const { rows: payments } = await db.execute({ sql: 'SELECT * FROM transaction_payments WHERE transaction_id = ? ORDER BY id', args: [tx.id] });
  return { ...tx, items, payments };
}

router.get('/:externalOrderId', requireApiKey, async (req, res) => {
  try {
    await ensureSchema();
    const externalOrderId = String(req.params.externalOrderId || '').trim();
    if (!externalOrderId || externalOrderId.length > 120) return res.status(400).json({ error: 'Invalid external order id' });
    const tx = await loadTransactionByExternalId(externalOrderId);
    if (!tx) return res.status(404).json({ error: 'SmartCommerce order not found' });
    res.json(tx);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Unable to reconcile SmartCommerce order' });
  }
});

router.post('/', requireApiKey, async (req, res) => {
  try {
    await ensureSchema();
    const {
      external_order_id,
      external_quote_id,
      external_payment_reference,
      external_customer_id,
      customer_id,
      employee_id,
      branch_id: requestedBranchId,
      items,
      payment_method,
      notes,
      delivery_amount,
      service_amount,
      handling_amount,
      tax_exempt,
      tax_exemption_number,
      approval_code,
    } = req.body || {};

    const externalOrderId = String(external_order_id || '').trim();
    if (!externalOrderId || externalOrderId.length > 120) return res.status(400).json({ error: 'external_order_id is required' });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'No items in transaction' });

    const existing = await loadTransactionByExternalId(externalOrderId);
    if (existing) return res.status(200).json({ ...existing, idempotent_replay: true });

    let branchId = requestedBranchId || null;
    if (!branchId) {
      const { rows: [setting] } = await db.execute({ sql: "SELECT value FROM settings WHERE key='woo_sync_branch_id'", args: [] });
      if (setting?.value) branchId = setting.value;
    }
    if (!branchId) return res.status(409).json({ error: 'Ecommerce fulfilment branch is not configured' });

    const delivery = money(delivery_amount, 'delivery_amount');
    const service = money(service_amount, 'service_amount');
    const handling = money(handling_amount, 'handling_amount');
    const isTaxExempt = tax_exempt ? 1 : 0;
    const method = String(payment_method || 'online').trim() || 'online';

    if (method === 'credit') {
      if (!customer_id) return res.status(400).json({ error: 'Credit orders require a customer_id' });
      const { rows: [creditCustomer] } = await db.execute({ sql: 'SELECT customer_type, credit_enabled, account_blocked FROM customers WHERE id = ? LIMIT 1', args: [customer_id] });
      if (!creditCustomer) return res.status(400).json({ error: 'Customer not found' });
      if (creditCustomer.customer_type !== 'credit' || !creditCustomer.credit_enabled) return res.status(403).json({ error: 'Customer does not have an enabled credit account' });
      if (creditCustomer.account_blocked) return res.status(403).json({ error: 'Customer credit account is blocked' });
    }

    let subtotal = 0;
    let taxAmount = 0;
    const processedItems = [];
    for (const requested of items) {
      const productId = Number(requested.product_id);
      const quantity = Number(requested.quantity);
      if (!Number.isInteger(productId) || productId <= 0 || !Number.isFinite(quantity) || quantity <= 0) {
        return res.status(400).json({ error: 'Each item requires a valid product_id and positive quantity' });
      }
      const { rows: [product] } = await db.execute({ sql: 'SELECT * FROM products WHERE id = ? AND active = 1', args: [productId] });
      if (!product) return res.status(409).json({ error: `Product ${productId} is unavailable` });
      const { rows: [branchStock] } = await db.execute({ sql: 'SELECT stock_qty FROM branch_inventory WHERE product_id = ? AND branch_id = ? LIMIT 1', args: [productId, branchId] });
      const available = Number(branchStock?.stock_qty ?? 0);
      if (available < quantity) return res.status(409).json({ error: `Insufficient stock for ${product.name}`, product_id: productId, requested: quantity, available });

      const unitPrice = Number(product.price || 0);
      const lineTotal = parseFloat((unitPrice * quantity).toFixed(2));
      const lineTax = isTaxExempt ? 0 : parseFloat((lineTotal * Number(product.tax_rate || 0) / 100).toFixed(2));
      subtotal += lineTotal;
      taxAmount += lineTax;
      processedItems.push({ product, quantity, unitPrice, lineTotal, lineTax });
    }

    subtotal = parseFloat(subtotal.toFixed(2));
    taxAmount = parseFloat(taxAmount.toFixed(2));
    const total = parseFloat((subtotal + taxAmount + delivery + service + handling).toFixed(2));
    const transactionNumber = await nextNumber(db, 'transactions', 'transaction_number', 'TXN-', 6);

    const txn = await db.transaction('write');
    let committed = false;
    try {
      const duplicateCheck = await txn.execute({ sql: 'SELECT id FROM transactions WHERE external_order_id = ? LIMIT 1', args: [externalOrderId] });
      if (duplicateCheck.rows?.[0]) {
        await txn.rollback();
        const replay = await loadTransactionByExternalId(externalOrderId);
        return res.status(200).json({ ...replay, idempotent_replay: true });
      }

      for (const line of processedItems) {
        const reserved = await txn.execute({
          sql: 'UPDATE branch_inventory SET stock_qty = stock_qty - ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND branch_id = ? AND stock_qty >= ?',
          args: [line.quantity, line.product.id, branchId, line.quantity],
        });
        if (!reserved.rowsAffected) {
          const e = new Error(`Insufficient stock for ${line.product.name}`);
          e.status = 409;
          throw e;
        }
      }

      const txResult = await txn.execute({
        sql: `INSERT INTO transactions (
          transaction_number, customer_id, employee_id, branch_id, subtotal, tax_amount,
          discount_amount, total, payment_method, amount_tendered, change_amount, status, notes,
          tax_exempt, tax_exemption_number, approval_code, source,
          external_order_id, external_quote_id, external_payment_reference, external_customer_id,
          delivery_amount, service_amount, handling_amount
        ) VALUES (?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [
          transactionNumber, customer_id || null, employee_id || 1, branchId, subtotal, taxAmount,
          total, method, method === 'credit' ? 0 : total, 0, 'completed', notes || null,
          isTaxExempt, tax_exemption_number || null, approval_code || null, 'online',
          externalOrderId, external_quote_id || null, external_payment_reference || null, external_customer_id || null,
          delivery, service, handling,
        ],
      });
      const txId = Number(txResult.lastInsertRowid);

      await txn.execute({ sql: 'INSERT INTO transaction_payments (transaction_id, payment_method, amount, approval_code) VALUES (?,?,?,?)', args: [txId, method, total, approval_code || null] });

      for (const line of processedItems) {
        await txn.execute({
          sql: `INSERT INTO transaction_items (transaction_id,product_id,product_name,sku,quantity,unit_price,discount_amount,tax_amount,total) VALUES (?,?,?,?,?,?,0,?,?)`,
          args: [txId, line.product.id, line.product.name, line.product.sku || '', line.quantity, line.unitPrice, line.lineTax, line.lineTotal],
        });
        await txn.execute({ sql: 'UPDATE products SET stock_qty = MAX(0, stock_qty - ?) WHERE id = ?', args: [line.quantity, line.product.id] });
        await syncBinQty(txn, line.product.id, branchId, -line.quantity);
      }

      if (customer_id) {
        const loyaltyPts = Math.floor(total * 0.5);
        await txn.execute({ sql: 'UPDATE customers SET loyalty_points = loyalty_points + ?, total_spent = total_spent + ? WHERE id = ?', args: [loyaltyPts, total, customer_id] });
        if (method === 'credit') await txn.execute({ sql: 'UPDATE customers SET account_balance = account_balance + ? WHERE id = ?', args: [total, customer_id] });
      }

      await txn.commit();
      committed = true;
      const saved = await loadTransactionByExternalId(externalOrderId);
      res.status(201).json(saved);
    } catch (e) {
      if (!committed) {
        try { await txn.rollback(); } catch (_) {}
      }
      if (/unique|constraint/i.test(String(e?.message || ''))) {
        const replay = await loadTransactionByExternalId(externalOrderId);
        if (replay) return res.status(200).json({ ...replay, idempotent_replay: true });
      }
      throw e;
    }
  } catch (e) {
    console.error('smartcommerce_order_error', { message: e?.message || 'unknown' });
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Unable to create SmartCommerce order' });
  }
});

module.exports = router;
