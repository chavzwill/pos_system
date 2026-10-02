'use strict';

const { db } = require('../database');
const { can } = require('./permissions');

const PRODUCT_READ_PERMISSIONS = ['inventory', 'pos', 'purchasing', 'quotations', 'rentals', 'work_orders'];
const MACHINE_READ_PERMISSIONS = ['rentals', 'work_orders', 'inventory'];

function error(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function safeLimit(value, fallback = 20, max = 50) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(parsed, max)) : fallback;
}

function assertAny(employee, permissions) {
  if (!employee?.id) throw error('TT_AI_EMPLOYEE_REQUIRED', 'Authenticated employee context is required', 401);
  if (!permissions.some(key => can(employee.permissions, key))) {
    throw error('TT_AI_PERMISSION_DENIED', `Missing permission: one of ${permissions.join(', ')}`, 403);
  }
}

function resolveBranch(employee, requestedBranchId) {
  const defaultBranch = employee?.default_branch_id == null ? null : String(employee.default_branch_id);
  const requested = requestedBranchId == null || requestedBranchId === '' ? defaultBranch : String(requestedBranchId);
  if (!requested) throw error('TT_AI_BRANCH_REQUIRED', 'A branch context is required for TT AI operational reads', 400);
  if (defaultBranch && requested !== defaultBranch && !can(employee?.permissions, 'multi_branch_access')) {
    throw error('TT_AI_BRANCH_FORBIDDEN', 'You do not have access to the requested branch', 403);
  }
  return requested;
}

function canSeeCost(employee) {
  return can(employee?.permissions, 'purchasing') || can(employee?.permissions, 'reports_financial');
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

async function searchProducts({ employee, branchId, query, limit = 20, rentalsOnly = false }) {
  assertAny(employee, rentalsOnly ? MACHINE_READ_PERMISSIONS : PRODUCT_READ_PERMISSIONS);
  const resolvedBranch = resolveBranch(employee, branchId);
  const q = String(query || '').trim();
  if (q.length < 2) throw error('TT_AI_SEARCH_TOO_SHORT', 'Search text must contain at least 2 characters');
  const like = `%${q}%`;
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
  const args = [resolvedBranch, resolvedBranch, like, like, like];
  if (rentalsOnly) sql += ' AND p.is_rental=1';
  sql += ' ORDER BY p.name LIMIT ?';
  args.push(safeLimit(limit));
  const { rows } = await db.execute({ sql, args });
  return {
    source: 'pos',
    authority: 'operational',
    branch_id: resolvedBranch,
    items: rows.map(row => productProjection(row, canSeeCost(employee))),
  };
}

async function tableExists(name) {
  const { rows: [row] } = await db.execute({
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    args: [name],
  });
  return Boolean(row);
}

async function rentalAssetProjectionAvailable() {
  return (await tableExists('rental_assets')) && (await tableExists('inventory_serials'));
}

function rentalAssetProjection(row, includeCost) {
  const result = {
    id: row.id,
    asset_number: row.asset_number,
    product_id: row.product_id,
    product_name: row.product_name,
    sku: row.sku,
    branch_id: row.branch_id,
    branch_name: row.branch_name,
    serial_id: row.serial_id,
    serial_number: row.serial_number,
    status: row.status,
    acquisition_date: row.acquisition_date,
    acquisition_evidence_grade: row.acquisition_evidence_grade,
    created_at: row.created_at,
    updated_at: row.updated_at,
    source: 'pos',
    authority: 'operational',
  };
  if (includeCost) {
    result.acquisition_cost = row.acquisition_cost;
    result.acquisition_evidence_ref = row.acquisition_evidence_ref;
  }
  return result;
}

async function searchRentalAssets({ employee, branchId, query, limit = 20 }) {
  assertAny(employee, MACHINE_READ_PERMISSIONS);
  const resolvedBranch = resolveBranch(employee, branchId);
  const q = String(query || '').trim();
  if (q.length < 2) throw error('TT_AI_SEARCH_TOO_SHORT', 'Search text must contain at least 2 characters');
  if (!(await rentalAssetProjectionAvailable())) {
    return { source: 'pos', authority: 'operational', branch_id: resolvedBranch, tracking_available: false, items: [] };
  }
  const like = `%${q}%`;
  const { rows } = await db.execute({
    sql: `SELECT a.*,p.name product_name,p.sku,b.name branch_name,s.serial_number
      FROM rental_assets a
      JOIN products p ON p.id=a.product_id
      JOIN branches b ON b.id=a.branch_id
      LEFT JOIN inventory_serials s ON s.id=a.serial_id
      WHERE a.branch_id=?
        AND (a.asset_number LIKE ? OR s.serial_number LIKE ? OR p.name LIKE ? OR p.sku LIKE ?)
      ORDER BY a.asset_number
      LIMIT ?`,
    args: [resolvedBranch, like, like, like, like, safeLimit(limit)],
  });
  return {
    source: 'pos',
    authority: 'operational',
    branch_id: resolvedBranch,
    tracking_available: true,
    items: rows.map(row => rentalAssetProjection(row, canSeeCost(employee))),
  };
}

async function readRentalAsset({ employee, branchId, identifier }) {
  assertAny(employee, MACHINE_READ_PERMISSIONS);
  const resolvedBranch = resolveBranch(employee, branchId);
  if (!(await rentalAssetProjectionAvailable())) {
    throw error('TT_AI_ASSET_TRACKING_UNAVAILABLE', 'Rental asset tracking is not available', 404);
  }
  const value = String(identifier || '').trim();
  if (!value) throw error('TT_AI_ASSET_IDENTIFIER_REQUIRED', 'Rental asset identifier is required');
  const { rows: [row] } = await db.execute({
    sql: `SELECT a.*,p.name product_name,p.sku,b.name branch_name,s.serial_number
      FROM rental_assets a
      JOIN products p ON p.id=a.product_id
      JOIN branches b ON b.id=a.branch_id
      LEFT JOIN inventory_serials s ON s.id=a.serial_id
      WHERE a.branch_id=? AND (CAST(a.id AS TEXT)=? OR a.asset_number=? OR s.serial_number=?)
      LIMIT 1`,
    args: [resolvedBranch, value, value, value],
  });
  if (!row) throw error('TT_AI_ASSET_NOT_FOUND', 'Rental asset not found', 404);

  const result = rentalAssetProjection(row, canSeeCost(employee));
  result.allocations = [];
  result.maintenance = [];

  if (await tableExists('rental_asset_allocations')) {
    const { rows } = await db.execute({
      sql: `SELECT aa.id,aa.agreement_id,aa.agreement_item_id,aa.allocated_at,aa.released_at,aa.release_reason,
        ra.agreement_number,ra.status agreement_status
        FROM rental_asset_allocations aa
        LEFT JOIN rental_agreements ra ON ra.id=aa.agreement_id
        WHERE aa.asset_id=?
        ORDER BY aa.allocated_at DESC,aa.id DESC LIMIT 100`,
      args: [row.id],
    });
    result.allocations = rows;
  }

  if (await tableExists('rental_asset_maintenance')) {
    const { rows } = await db.execute({
      sql: `SELECT id,maintenance_type,started_at,ended_at,direct_cost,evidence_ref,notes
        FROM rental_asset_maintenance WHERE asset_id=? ORDER BY started_at DESC,id DESC LIMIT 100`,
      args: [row.id],
    });
    result.maintenance = rows.map(item => {
      if (canSeeCost(employee)) return item;
      const { direct_cost, ...safe } = item;
      return safe;
    });
  }
  return result;
}

async function executeTTAIReadTool(tool, input, employee) {
  switch (tool) {
    case 'pos.products.search':
      return searchProducts({ employee, branchId: input?.branchId, query: input?.query, limit: input?.limit });
    case 'pos.rental-machines.search':
      return searchProducts({ employee, branchId: input?.branchId, query: input?.query, limit: input?.limit, rentalsOnly: true });
    case 'pos.rental-assets.search':
      return searchRentalAssets({ employee, branchId: input?.branchId, query: input?.query, limit: input?.limit });
    case 'pos.rental-asset.read':
      return readRentalAsset({ employee, branchId: input?.branchId, identifier: input?.identifier });
    default:
      throw error('TT_AI_TOOL_NOT_ALLOWED', 'TT AI requested an unapproved POS read tool', 403);
  }
}

module.exports = {
  PRODUCT_READ_PERMISSIONS,
  MACHINE_READ_PERMISSIONS,
  resolveBranch,
  canSeeCost,
  searchProducts,
  searchRentalAssets,
  readRentalAsset,
  executeTTAIReadTool,
};
