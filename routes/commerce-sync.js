const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission } = require('../lib/permissions');
const { resolveCanonicalProduct } = require('../lib/catalog-integrity');

// API keys bypass requirePermission after apiKeyAuth validates their scope.
// Browser staff need inventory permission to inspect the same integration data.
router.use(requirePermission('inventory'));
router.use('/catalog-cleanup-dependencies', require('./catalog-cleanup-dependencies'));

const CONTRACT_VERSION = '2026-09-20.1';

function publicProduct(p) {
  return {
    id: p.id, sku: p.sku, barcode: p.barcode, name: p.name, description: p.description,
    category_id: p.category_id, category_name: p.category_name || null,
    brand_id: p.brand_id || null, brand_name: p.brand_name || null,
    price: Number(p.price) || 0, tax_rate: Number(p.tax_rate) || 0, taxable: Number(p.taxable ?? 1) !== 0,
    stock_qty: Number(p.stock_qty) || 0, min_stock: Number(p.min_stock) || 0,
    active: Number(p.active) !== 0, catalog_status: p.catalog_status || 'active', online_available: Number(p.online_available || 0) !== 0,
    web_allotment: p.web_allotment == null ? null : Number(p.web_allotment), image_path: p.image_path || null,
    model_number: p.model_number || null, size: p.size || null, unit: p.unit || null,
    is_service: Number(p.is_service || 0) !== 0, is_rental: Number(p.is_rental || 0) !== 0,
    is_layaway_eligible: Number(p.is_layaway_eligible || 0) !== 0,
    consolidated_into_product_id: p.consolidated_into_product_id == null ? null : Number(p.consolidated_into_product_id),
    consolidated_into_sku: p.consolidated_into_sku || null,
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
      sql: `SELECT p.*, c.name category_name, br.name brand_name,
                     pc.survivor_product_id consolidated_into_product_id, sp.sku consolidated_into_sku
              FROM products p
              LEFT JOIN categories c ON c.id=p.category_id
              LEFT JOIN brands br ON br.id=p.brand_id
              LEFT JOIN catalog_product_consolidations pc ON pc.duplicate_product_id=p.id
              LEFT JOIN products sp ON sp.id=pc.survivor_product_id
              ${includeInactive ? '' : 'WHERE p.active=1'} ORDER BY p.id`, args: []
    });
    const { rows: categories } = await db.execute({sql:'SELECT id,name,description FROM categories ORDER BY name',args:[]});
    const { rows: brands } = await db.execute({sql:'SELECT id,name,description,logo_path,active FROM brands ORDER BY name',args:[]});
    const { rows: productConsolidations } = await db.execute({sql:`SELECT pc.duplicate_product_id,d.sku duplicate_sku,pc.survivor_product_id,s.sku survivor_sku,pc.created_at consolidated_at
      FROM catalog_product_consolidations pc
      JOIN products d ON d.id=pc.duplicate_product_id
      JOIN products s ON s.id=pc.survivor_product_id
      ORDER BY pc.created_at,pc.duplicate_product_id`,args:[]});
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
      categories: categories.map(c=>({id:c.id,name:c.name,description:c.description||null})),
      brands: brands.map(b=>({id:b.id,name:b.name,description:b.description||null,logo_path:b.logo_path||null,active:Number(b.active)!==0})),
      product_consolidations: productConsolidations.map(x=>({duplicate_product_id:Number(x.duplicate_product_id),duplicate_sku:x.duplicate_sku||null,survivor_product_id:Number(x.survivor_product_id),survivor_sku:x.survivor_sku||null,consolidated_at:x.consolidated_at||null})),
      products: products.map(p => ({ ...publicProduct(p), branches: invMap.get(Number(p.id)) || [], variations: varMap.get(Number(p.id)) || [] })),
    });
  } catch (e) {
    console.error('commerce_sync_catalog_error',{code:e?.code||'unknown'});
    res.status(500).json({error:'Unable to prepare the website catalog right now.',code:'COMMERCE_SYNC_CATALOG_UNAVAILABLE'});
  }
});

async function resolveCanonicalAvailability(requestedSku) {
  const { rows: [requested] } = await db.execute({
    sql: 'SELECT id,sku FROM products WHERE lower(sku)=lower(?) LIMIT 1',
    args: [requestedSku]
  });
  if (!requested) return null;
  const resolved = await resolveCanonicalProduct(requested.id);
  const { rows: [product] } = await db.execute({
    sql: `SELECT p.*,c.name category_name,br.name brand_name,
                 pc.survivor_product_id consolidated_into_product_id,sp.sku consolidated_into_sku
          FROM products p
          LEFT JOIN categories c ON c.id=p.category_id
          LEFT JOIN brands br ON br.id=p.brand_id
          LEFT JOIN catalog_product_consolidations pc ON pc.duplicate_product_id=p.id
          LEFT JOIN products sp ON sp.id=pc.survivor_product_id
          WHERE p.id=? LIMIT 1`,
    args: [resolved.canonical_product_id]
  });
  return { requested, resolved, product };
}

router.get('/availability/:sku', async (req, res) => {
  try {
    const resolvedAvailability = await resolveCanonicalAvailability(req.params.sku);
    if (!resolvedAvailability) return res.status(404).json({ error:'Product not found',code:'PRODUCT_NOT_FOUND' });
    const { requested, resolved, product:p } = resolvedAvailability;
    if (!p || !Number(p.active)) return res.status(404).json({ error:'The canonical product is not active.',code:'CANONICAL_PRODUCT_NOT_ACTIVE' });
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
    res.json({
      contract_version: CONTRACT_VERSION,
      generated_at:new Date().toISOString(),
      requested_sku: requested.sku,
      canonicalized: Boolean(resolved.is_consolidated),
      canonical_product_id: Number(resolved.canonical_product_id),
      canonical_sku: resolved.canonical_sku || p.sku || null,
      product:publicProduct(p),
      availability
    });
  } catch (e) {
    console.error('commerce_sync_availability_error',{code:e?.code||'unknown'});
    res.status(500).json({error:'Unable to check website availability right now.',code:'COMMERCE_SYNC_AVAILABILITY_UNAVAILABLE'});
  }
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
  } catch (e) {
    console.error('commerce_sync_inventory_changes_error',{code:e?.code||'unknown'});
    res.status(500).json({error:'Unable to prepare website inventory changes right now.',code:'COMMERCE_SYNC_INVENTORY_CHANGES_UNAVAILABLE'});
  }
});

module.exports = router;
