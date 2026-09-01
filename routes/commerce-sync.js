const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission } = require('../lib/permissions');

// API keys bypass requirePermission after apiKeyAuth validates their scope.
// Browser staff need inventory permission to inspect the same integration data.
router.use(requirePermission('inventory'));
router.use('/catalog-cleanup-dependencies', require('./catalog-cleanup-dependencies'));

const CONTRACT_VERSION = '2026-08-23.1';

function publicProduct(p) {
  return {
    id: p.id, sku: p.sku, barcode: p.barcode, name: p.name, description: p.description,
    category_id: p.category_id, category_name: p.category_name || null,
    price: Number(p.price) || 0, tax_rate: Number(p.tax_rate) || 0, taxable: Number(p.taxable ?? 1) !== 0,
    stock_qty: Number(p.stock_qty) || 0, min_stock: Number(p.min_stock) || 0,
    active: Number(p.active) !== 0, online_available: Number(p.online_available || 0) !== 0,
    web_allotment: p.web_allotment == null ? null : Number(p.web_allotment), image_path: p.image_path || null,
    model_number: p.model_number || null, size: p.size || null, unit: p.unit || null,
    is_service: Number(p.is_service || 0) !== 0, is_rental: Number(p.is_rental || 0) !== 0,
    is_layaway_eligible: Number(p.is_layaway_eligible || 0) !== 0,
    rental: Number(p.is_rental || 0) !== 0 ? {
      classification: p.rental_classification || 'tool',
      daily_rate: Number(p.rental_rate) || 0,
      weekly_rate: Number(p.rental_weekly_rate) || 0,
      monthly_rate: Number(p.rental_monthly_rate) || 0,
      hourly_rate: Number(p.rental_hourly_rate) || 0,
      replacement_value: Number(p.replacement_value) || 0,
    } : null,
  };
}

router.get('/health', async (req, res) => {
  res.json({ service: 'total-tools-pos-commerce-sync', contract_version: CONTRACT_VERSION, generated_at: new Date().toISOString() });
});

router.get('/catalog', async (req, res) => {
  try {
    const includeInactive = String(req.query.include_inactive || '') === '1';
    const { rows: products } = await db.execute({
      sql: `SELECT p.*, c.name category_name FROM products p LEFT JOIN categories c ON c.id=p.category_id
            ${includeInactive ? '' : 'WHERE p.active=1'} ORDER BY p.id`, args: []
    });
    const ids = products.map(p => Number(p.id));
    let inventory = [], variations = [];
    if (ids.length) {
      const marks = ids.map(() => '?').join(',');
      ({ rows: inventory } = await db.execute({
        sql: `SELECT bi.product_id,bi.branch_id,b.name branch_name,b.currency,b.price_tier_percent,
                     bi.stock_qty,bi.min_stock,bi.updated_at
              FROM branch_inventory bi JOIN branches b ON b.id=bi.branch_id
              WHERE b.active=1 AND bi.product_id IN (${marks}) ORDER BY bi.product_id,b.name`, args: ids
      }));
      ({ rows: variations } = await db.execute({
        sql: `SELECT id,product_id,name,sku,barcode,attributes,price,price_modifier,stock_qty,min_stock,active
              FROM product_variations WHERE product_id IN (${marks}) ORDER BY product_id,id`, args: ids
      }));
    }
    const invMap = new Map(), varMap = new Map();
    for (const i of inventory) {
      const row = { branch_id:i.branch_id, branch_name:i.branch_name, currency:i.currency || null,
        price_tier_percent:Number(i.price_tier_percent)||0, stock_qty:Number(i.stock_qty)||0,
        min_stock:Number(i.min_stock)||0, updated_at:i.updated_at || null };
      if (!invMap.has(Number(i.product_id))) invMap.set(Number(i.product_id), []);
      invMap.get(Number(i.product_id)).push(row);
    }
    for (const v of variations) {
      const row = { id:v.id,name:v.name,sku:v.sku,barcode:v.barcode,attributes:v.attributes,
        price:v.price==null?null:Number(v.price),price_modifier:Number(v.price_modifier)||0,
        stock_qty:Number(v.stock_qty)||0,min_stock:Number(v.min_stock)||0,active:Number(v.active)!==0 };
      if (!varMap.has(Number(v.product_id))) varMap.set(Number(v.product_id), []);
      varMap.get(Number(v.product_id)).push(row);
    }
    res.json({
      contract_version: CONTRACT_VERSION, generated_at: new Date().toISOString(),
      products: products.map(p => ({ ...publicProduct(p), branches: invMap.get(Number(p.id)) || [], variations: varMap.get(Number(p.id)) || [] })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/availability/:sku', async (req, res) => {
  try {
    const { rows: [p] } = await db.execute({
      sql: `SELECT p.*,c.name category_name FROM products p LEFT JOIN categories c ON c.id=p.category_id
            WHERE lower(p.sku)=lower(?) LIMIT 1`, args: [req.params.sku]
    });
    if (!p || !Number(p.active)) return res.status(404).json({ error: 'Active product not found' });
    const { rows: branches } = await db.execute({
      sql: `SELECT bi.branch_id,b.name branch_name,b.currency,b.price_tier_percent,bi.stock_qty,bi.min_stock,bi.updated_at
            FROM branch_inventory bi JOIN branches b ON b.id=bi.branch_id
            WHERE bi.product_id=? AND b.active=1 ORDER BY b.name`, args: [p.id]
    });
    const webCap = p.web_allotment == null ? null : Math.max(0, Number(p.web_allotment) || 0);
    const availability = branches.map(b => {
      const stock = Math.max(0, Number(b.stock_qty) || 0);
      const sellable = Number(p.online_available || 0) ? (webCap == null ? stock : Math.min(stock, webCap)) : 0;
      const branchPrice = Math.max(0, Number((Number(p.price || 0) * (1 + (Number(b.price_tier_percent) || 0) / 100)).toFixed(2)));
      return { branch_id:b.branch_id, branch_name:b.branch_name, currency:b.currency || null,
        stock_qty:stock, sellable_online_qty:sellable, min_stock:Number(b.min_stock)||0,
        price:branchPrice, updated_at:b.updated_at || null };
    });
    res.json({ contract_version: CONTRACT_VERSION, generated_at:new Date().toISOString(), product:publicProduct(p), availability });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/inventory-changes', async (req, res) => {
  try {
    const since = String(req.query.since || '').trim();
    if (!since || Number.isNaN(Date.parse(since))) return res.status(400).json({ error: 'A valid ISO since timestamp is required' });
    const { rows } = await db.execute({
      sql: `SELECT bi.product_id,p.sku,bi.branch_id,b.name branch_name,bi.stock_qty,bi.min_stock,bi.updated_at
            FROM branch_inventory bi JOIN products p ON p.id=bi.product_id JOIN branches b ON b.id=bi.branch_id
            WHERE p.active=1 AND b.active=1 AND datetime(bi.updated_at)>=datetime(?)
            ORDER BY bi.updated_at,bi.product_id,bi.branch_id`, args: [since]
    });
    res.json({ contract_version:CONTRACT_VERSION, generated_at:new Date().toISOString(), since,
      changes:rows.map(x=>({ ...x,stock_qty:Number(x.stock_qty)||0,min_stock:Number(x.min_stock)||0 })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
