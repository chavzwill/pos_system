const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requireAuth, requireAnyPermission, can } = require('../lib/permissions');

const PRODUCT_READ_PERMISSIONS = ['inventory', 'pos', 'purchasing', 'quotations', 'rentals', 'work_orders'];
const MACHINE_READ_PERMISSIONS = ['rentals', 'work_orders', 'inventory'];

function rejectMachineCredential(req, res, next) {
  if (req.apiKey) return res.status(403).json({
    error: 'TT AI employee context requires an authenticated staff session',
    code: 'TT_AI_STAFF_SESSION_REQUIRED',
  });
  next();
}

function safeLimit(value, fallback = 20, max = 50) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(parsed, max)) : fallback;
}

function branchContext(req, res) {
  const defaultBranch = req.employee?.default_branch_id == null ? null : String(req.employee.default_branch_id);
  const requested = req.query.branch_id == null ? defaultBranch : String(req.query.branch_id);
  if (!requested) {
    res.status(400).json({
      error: 'A branch context is required for TT AI operational reads',
      code: 'TT_AI_BRANCH_REQUIRED',
    });
    return null;
  }
  if (defaultBranch && requested !== defaultBranch && !can(req.employee?.permissions, 'multi_branch_access')) {
    res.status(403).json({
      error: 'You do not have access to the requested branch',
      code: 'TT_AI_BRANCH_FORBIDDEN',
    });
    return null;
  }
  return requested;
}

function canSeeCost(req) {
  return can(req.employee?.permissions, 'purchasing') || can(req.employee?.permissions, 'reports_financial');
}

function productProjection(row, includeCost) {
  const result = {
    id: row.id,
    sku: row.sku,
    barcode: row.barcode,
    name: row.name,
    description: row.description,
    brand: row.brand_name,
    category: row.category_name,
    unit: row.unit,
    price: row.price,
    stock_qty: row.stock_qty,
    global_stock_qty: row.global_stock_qty,
    min_stock: row.min_stock,
    active: Number(row.active) !== 0,
    is_rental: Number(row.is_rental) !== 0,
    is_accessory: Number(row.is_accessory) !== 0,
    is_service: Number(row.is_service) !== 0,
    replacement_value: row.replacement_value,
    rental_rate_type: row.rental_rate_type,
    rental_rate: row.rental_rate,
    source: 'pos',
    authority: 'operational',
  };
  if (includeCost) result.cost = row.cost;
  return result;
}

async function searchProducts(req, res, { rentalsOnly = false } = {}) {
  const branchId = branchContext(req, res);
  if (!branchId) return;

  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.status(400).json({
    error: 'Search text must contain at least 2 characters',
    code: 'TT_AI_SEARCH_TOO_SHORT',
  });
  const limit = safeLimit(req.query.limit, 20, 50);
  const like = `%${q}%`;

  try {
    let sql = `SELECT p.id,p.sku,p.barcode,p.name,p.description,p.cost,p.unit,p.active,
      p.is_rental,p.is_accessory,p.is_service,p.replacement_value,p.rental_rate_type,p.rental_rate,
      p.stock_qty AS global_stock_qty,
      COALESCE(bi.stock_qty,0) AS stock_qty,
      COALESCE(bi.min_stock,p.min_stock) AS min_stock,
      MAX(0,ROUND(p.price*(1+COALESCE(b.price_tier_percent,0)/100.0),2)) AS price,
      c.name AS category_name,br.name AS brand_name
      FROM products p
      LEFT JOIN categories c ON c.id=p.category_id
      LEFT JOIN brands br ON br.id=p.brand_id
      LEFT JOIN branch_inventory bi ON bi.product_id=p.id AND bi.branch_id=?
      LEFT JOIN branches b ON b.id=?
      WHERE p.active=1
        AND (p.name LIKE ? OR p.sku LIKE ? OR p.barcode LIKE ?)`;
    const args = [branchId, branchId, like, like, like];
    if (rentalsOnly) sql += ' AND p.is_rental=1';
    sql += ' ORDER BY p.name LIMIT ?';
    args.push(limit);

    const { rows } = await db.execute({ sql, args });
    const includeCost = canSeeCost(req);
    return res.json({
      source: 'pos',
      authority: 'operational',
      branch_id: branchId,
      items: rows.map(row => productProjection(row, includeCost)),
    });
  } catch (error) {
    console.error('TT AI product read failed', {
      request_id: req.requestId || null,
      employee_id: req.employee?.id || null,
      message: String(error?.message || error).slice(0, 300),
    });
    return res.status(500).json({ error: 'Unable to read product data for TT AI', request_id: req.requestId || null });
  }
}

router.use(rejectMachineCredential);

router.get('/context', requireAuth, (req, res) => {
  const permissions = req.employee?.permissions || {};
  res.json({
    employee_id: req.employee.id,
    branch_id: req.employee.default_branch_id,
    security_group: req.employee.security_group_name || null,
    capabilities: {
      products: PRODUCT_READ_PERMISSIONS.some(key => can(permissions, key)),
      rental_machines: MACHINE_READ_PERMISSIONS.some(key => can(permissions, key)),
      cost_visibility: can(permissions, 'purchasing') || can(permissions, 'reports_financial'),
      multi_branch: can(permissions, 'multi_branch_access'),
      writes: false,
    },
  });
});

router.get(
  '/products/search',
  requireAnyPermission(...PRODUCT_READ_PERMISSIONS),
  (req, res) => searchProducts(req, res)
);

router.get(
  '/rental-machines/search',
  requireAnyPermission(...MACHINE_READ_PERMISSIONS),
  (req, res) => searchProducts(req, res, { rentalsOnly: true })
);

module.exports = router;
