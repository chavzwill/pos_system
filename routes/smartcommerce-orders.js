const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { db } = require('../database');
const { nextNumber } = require('../lib/nextNumber');
const { syncBinQty } = require('../lib/binSync');

const MAX_ITEMS = 200;
const REF_RE = /^[A-Za-z0-9_-]{1,120}$/;

function money(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n < 0 || n > 1e9) return null;
  return Math.round(n * 100) / 100;
}
function positiveId(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
function validRef(value) {
  return typeof value === 'string' && REF_RE.test(value);
}
function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function normalizedPayload(body) {
  const allowed = new Set([
    'external_order_id','external_quote_id','external_payment_reference',
    'external_customer_id','customer_id','branch_id','items','payment_method',
    'delivery_amount','service_amount','handling_amount'
  ]);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (Object.keys(body).some(k => !allowed.has(k))) return null;
  if (!validRef(body.external_order_id) || !validRef(body.external_payment_reference)) return null;
  if (body.payment_method !== 'online') return null;
  const branchId = positiveId(body.branch_id);
  if (!branchId) return null;
  const customerId = body.customer_id == null ? null : positiveId(body.customer_id);
  if (body.customer_id != null && !customerId) return null;
  for (const key of ['external_quote_id','external_customer_id']) {
    if (body[key] != null && !validRef(body[key])) return null;
  }
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > MAX_ITEMS) return null;
  const seen = new Set();
  const items = [];
  for (const raw of body.items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (Object.keys(raw).some(k => !['product_id','quantity'].includes(k))) return null;
    const productId = positiveId(raw.product_id);
    const quantity = Number(raw.quantity);
    if (!productId || !Number.isFinite(quantity) || quantity <= 0 || quantity > 1e6 || seen.has(productId)) return null;
    seen.add(productId);
    items.push({ product_id: productId, quantity });
  }
  const fees = {};
  for (const key of ['delivery_amount','service_amount','handling_amount']) {
    const value = money(body[key]);
    if (body[key] != null && value == null) return null;
    fees[key] = value || 0;
  }
  return {
    external_order_id: body.external_order_id,
    external_quote_id: body.external_quote_id || null,
    external_payment_reference: body.external_payment_reference,
    external_customer_id: body.external_customer_id || null,
    customer_id: customerId,
    branch_id: branchId,
    items,
    payment_method: 'online',
    ...fees,
  };
}
async function receiptForExternalOrder(externalOrderId) {
  const { rows: [bridge] } = await db.execute({
    sql: 'SELECT * FROM smartcommerce_orders WHERE external_order_id = ?',
    args: [externalOrderId],
  });
  if (!bridge || !bridge.transaction_id) return null;
  const { rows: [tx] } = await db.execute({
    sql: 'SELECT * FROM transactions WHERE id = ?',
    args: [bridge.transaction_id],
  });
  if (!tx) return null;
  const { rows: items } = await db.execute({
    sql: 'SELECT product_id, quantity FROM transaction_items WHERE transaction_id = ? AND product_id IS NOT NULL ORDER BY id',
    args: [tx.id],
  });
  return {
    id: Number(tx.id),
    external_order_id: bridge.external_order_id,
    external_quote_id: bridge.external_quote_id,
    external_payment_reference: bridge.external_payment_reference,
    external_customer_id: bridge.external_customer_id,
    customer_id: bridge.customer_id == null ? null : Number(bridge.customer_id),
    branch_id: Number(bridge.branch_id),
    items: items.map(item => ({ product_id: Number(item.product_id), quantity: Number(item.quantity) })),
    payment_method: 'online',
    delivery_amount: Number(bridge.delivery_amount || 0),
    service_amount: Number(bridge.service_amount || 0),
    handling_amount: Number(bridge.handling_amount || 0),
    total: Number(tx.total),
    status: String(tx.status || 'completed'),
    transaction_number: tx.transaction_number,
    created_at: tx.created_at,
  };
}

router.get('/:externalOrderId', async (req, res) => {
  if (!req.apiKey) return res.status(401).json({ error: 'API key required' });
  if (!validRef(req.params.externalOrderId)) return res.status(400).json({ error: 'Invalid external order id' });
  try {
    const receipt = await receiptForExternalOrder(req.params.externalOrderId);
    if (!receipt) return res.status(404).json({ error: 'SmartCommerce order not found' });
    return res.json(receipt);
  } catch (e) {
    return res.status(500).json({ error: 'SmartCommerce order lookup failed' });
  }
});

router.post('/', async (req, res) => {
  if (!req.apiKey) return res.status(401).json({ error: 'API key required' });
  const payload = normalizedPayload(req.body);
  if (!payload) return res.status(422).json({ error: 'Invalid SmartCommerce order payload' });
  const payloadHash = stableHash(payload);

  try {
    const existing = await receiptForExternalOrder(payload.external_order_id);
    if (existing) {
      const { rows: [bridge] } = await db.execute({
        sql: 'SELECT payload_hash FROM smartcommerce_orders WHERE external_order_id = ?',
        args: [payload.external_order_id],
      });
      if (!bridge || bridge.payload_hash !== payloadHash) {
        return res.status(409).json({ error: 'External order id already exists with different order data' });
      }
      return res.json(existing);
    }

    const { rows: [branch] } = await db.execute({ sql: 'SELECT id FROM branches WHERE id = ? AND active = 1', args: [payload.branch_id] });
    if (!branch) return res.status(422).json({ error: 'Branch not found or inactive' });
    if (payload.customer_id) {
      const { rows: [customer] } = await db.execute({ sql: 'SELECT id FROM customers WHERE id = ? AND active = 1', args: [payload.customer_id] });
      if (!customer) return res.status(422).json({ error: 'Customer not found or inactive' });
    }

    let subtotal = 0;
    let taxAmount = 0;
    const processed = [];
    for (const item of payload.items) {
      const { rows: [product] } = await db.execute({ sql: 'SELECT * FROM products WHERE id = ? AND active = 1', args: [item.product_id] });
      if (!product) return res.status(422).json({ error: `Product ${item.product_id} not found or inactive` });
      const { rows: [branchStock] } = await db.execute({
        sql: 'SELECT stock_qty FROM branch_inventory WHERE product_id = ? AND branch_id = ?',
        args: [item.product_id, payload.branch_id],
      });
      if (!branchStock || Number(branchStock.stock_qty) < item.quantity) {
        return res.status(409).json({ error: `Insufficient branch stock for product ${item.product_id}` });
      }
      const unitPrice = money(product.price);
      if (unitPrice == null) return res.status(422).json({ error: `Invalid price for product ${item.product_id}` });
      const lineTotal = Math.round(unitPrice * item.quantity * 100) / 100;
      const lineTax = Math.round(lineTotal * Number(product.tax_rate || 0)) / 100;
      subtotal = Math.round((subtotal + lineTotal) * 100) / 100;
      taxAmount = Math.round((taxAmount + lineTax) * 100) / 100;
      processed.push({ product, quantity: item.quantity, unitPrice, lineTotal, lineTax });
    }
    const feeTotal = Math.round((payload.delivery_amount + payload.service_amount + payload.handling_amount) * 100) / 100;
    const total = Math.round((subtotal + taxAmount + feeTotal) * 100) / 100;

    const tx = await db.transaction('write');
    let committed = false;
    try {
      const { rows: duplicateRows } = await tx.execute({
        sql: 'SELECT payload_hash, transaction_id FROM smartcommerce_orders WHERE external_order_id = ?',
        args: [payload.external_order_id],
      });
      const duplicate = duplicateRows[0];
      if (duplicate) {
        await tx.rollback();
        if (duplicate.payload_hash !== payloadHash) return res.status(409).json({ error: 'External order id already exists with different order data' });
        const replay = await receiptForExternalOrder(payload.external_order_id);
        return replay ? res.json(replay) : res.status(409).json({ error: 'Existing SmartCommerce order is incomplete' });
      }

      const transactionNumber = await nextNumber(tx, 'transactions', 'transaction_number', 'TXN-', 6);
      const txResult = await tx.execute({
        sql: `INSERT INTO transactions
          (transaction_number,customer_id,employee_id,branch_id,subtotal,tax_amount,discount_amount,total,payment_method,amount_tendered,change_amount,status,notes,approval_code,source)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [
          transactionNumber, payload.customer_id, null, payload.branch_id, subtotal, taxAmount, 0, total,
          'online', total, 0, 'completed', `SmartCommerce order ${payload.external_order_id}`,
          payload.external_payment_reference, 'online'
        ],
      });
      const transactionId = Number(txResult.lastInsertRowid);

      await tx.execute({
        sql: 'INSERT INTO transaction_payments (transaction_id,payment_method,amount,approval_code) VALUES (?,?,?,?)',
        args: [transactionId, 'online', total, payload.external_payment_reference],
      });

      for (const line of processed) {
        await tx.execute({
          sql: `INSERT INTO transaction_items
            (transaction_id,product_id,product_name,sku,quantity,unit_price,discount_amount,tax_amount,total)
            VALUES (?,?,?,?,?,?,?,?,?)`,
          args: [
            transactionId, line.product.id, line.product.name, line.product.sku, line.quantity,
            line.unitPrice, 0, line.lineTax, line.lineTotal
          ],
        });
        const stockUpdate = await tx.execute({
          sql: 'UPDATE branch_inventory SET stock_qty = stock_qty - ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND branch_id = ? AND stock_qty >= ?',
          args: [line.quantity, line.product.id, payload.branch_id, line.quantity],
        });
        if (Number(stockUpdate.rowsAffected || 0) !== 1) throw new Error(`INSUFFICIENT_BRANCH_STOCK:${line.product.id}`);
        await tx.execute({ sql: 'UPDATE products SET stock_qty = MAX(0, stock_qty - ?) WHERE id = ?', args: [line.quantity, line.product.id] });
        await syncBinQty(tx, line.product.id, payload.branch_id, -line.quantity);
        await tx.execute({
          sql: 'INSERT INTO stock_movements (product_id,branch_id,quantity_change,type,reference,reason) VALUES (?,?,?,?,?,?)',
          args: [line.product.id, payload.branch_id, -line.quantity, 'sale', payload.external_order_id, 'SmartCommerce paid order'],
        });
      }

      await tx.execute({
        sql: `INSERT INTO smartcommerce_orders
          (external_order_id,external_quote_id,external_payment_reference,external_customer_id,customer_id,branch_id,transaction_id,
           delivery_amount,service_amount,handling_amount,payload_hash,status)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [
          payload.external_order_id, payload.external_quote_id, payload.external_payment_reference,
          payload.external_customer_id, payload.customer_id, payload.branch_id, transactionId,
          payload.delivery_amount, payload.service_amount, payload.handling_amount, payloadHash, 'completed'
        ],
      });

      if (payload.customer_id) {
        const loyaltyPts = Math.floor(total * 0.5);
        await tx.execute({
          sql: 'UPDATE customers SET loyalty_points = loyalty_points + ?, total_spent = total_spent + ? WHERE id = ?',
          args: [loyaltyPts, total, payload.customer_id],
        });
      }

      await tx.commit();
      committed = true;
      return res.status(201).json(await receiptForExternalOrder(payload.external_order_id));
    } catch (e) {
      if (!committed) {
        try { await tx.rollback(); } catch {}
      }
      if (String(e && e.message || '').startsWith('INSUFFICIENT_BRANCH_STOCK:')) {
        return res.status(409).json({ error: 'Inventory changed before the order could be committed' });
      }
      if (/UNIQUE|constraint/i.test(String(e && e.message || ''))) {
        const replay = await receiptForExternalOrder(payload.external_order_id);
        if (replay) return res.json(replay);
      }
      return res.status(500).json({ error: 'SmartCommerce order could not be committed' });
    }
  } catch (e) {
    return res.status(500).json({ error: 'SmartCommerce order service unavailable' });
  }
});

module.exports = router;
