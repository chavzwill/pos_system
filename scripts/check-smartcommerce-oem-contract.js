const fs = require('fs');
const assert = require('assert');

const database = fs.readFileSync('database.js', 'utf8');
const products = fs.readFileSync('routes/products.js', 'utf8');
const commerce = fs.readFileSync('routes/commerce-sync.js', 'utf8');
const catalogUi = fs.readFileSync('public/catalog-admin-workspace.js', 'utf8');
const apiKeyAuth = fs.readFileSync('lib/apiKeyAuth.js', 'utf8');
const branches = fs.readFileSync('routes/branches.js', 'utf8');
const projection = require('../lib/smartcommerceReadProjection');

process.env.SMARTCOMMERCE_READ_API_KEY = 'smartcommerce-read-test-key-0123456789abcdef';
const {
  matchesSmartCommerceReadKey,
  requiredScope,
} = require('../lib/apiKeyAuth');
assert.equal(matchesSmartCommerceReadKey(process.env.SMARTCOMMERCE_READ_API_KEY), true, 'configured SmartCommerce read key must match');
assert.equal(matchesSmartCommerceReadKey('wrong-smartcommerce-read-test-key-0123456789abcdef'), false, 'wrong SmartCommerce read key must fail');
assert.equal(requiredScope('GET', '/api/branches'), 'products:read', 'branch directory must require products:read');
assert.equal(requiredScope('POST', '/api/products'), 'products:write', 'product writes must remain products:write');

// Verify real product projections cannot leak internal POS costs or staff data.
// Read API keys are read-only, but that alone does NOT make raw rows public.
const rawProduct = {
  id: 101, sku: 'CB-101', name: 'Chain brake', barcode: 'ABC',
  brand_name: 'STIHL', manufacturer_part_number: '1135 160 5400',
  price: 250, stock_qty: 40, branch_stock_qty: 0, branch_min_stock: 3,
  active: 1, online_available: 1, consolidated_into_product_id: null,
  cost: 125, supplier_id: 11, supplier_price: 100, rental_replacement_value: 900,
  internal_note: 'not public', customer_credit: 500,
};
assert.equal(projection.isPublishedProduct(rawProduct), true);
assert.equal(projection.isPublishedProduct({ ...rawProduct, active: 0 }), false);
assert.equal(projection.isPublishedProduct({ ...rawProduct, online_available: 0 }), false);
assert.equal(projection.isPublishedProduct({ ...rawProduct, consolidated_into_product_id: 200 }), false);
const projectedProduct = projection.publicProduct(rawProduct, '7');
assert.equal(projectedProduct.brand_name, 'STIHL');
assert.equal(projectedProduct.manufacturer_part_number, '1135 160 5400');
assert.equal(projectedProduct.branch_id, '7');
assert.equal(projectedProduct.branch_stock_qty, 0, 'branch out-of-stock must override global stock 40');
assert.equal(projectedProduct.branch_min_stock, 3);
assert.equal(projectedProduct.price, 250);
for (const field of ['cost', 'supplier_id', 'supplier_price', 'internal_note', 'customer_credit',
  'stock_qty', 'rental_replacement_value']) {
  assert.equal(Object.hasOwn(projectedProduct, field), false, `${field} must not reach read-only SmartCommerce`);
}
assert.equal(Object.hasOwn(projection.publicProduct(rawProduct), 'branch_stock_qty'), false);
const projectedBranch = projection.publicBranch({
  id: 7, name: 'Main', branch_code: 'BR-007', active: 1,
  phone: '876-555-0101', price_tier_percent: 15, employee_count: 14,
  manager: 'Private', accounting_code: 'secret',
});
assert.equal(projectedBranch.name, 'Main');
for (const field of ['manager', 'price_tier_percent', 'employee_count', 'accounting_code']) {
  assert.equal(Object.hasOwn(projectedBranch, field), false, `${field} must not leave branch directory`);
}


const checks = [
  [database.includes('manufacturer_part_number TEXT'), 'new databases include manufacturer_part_number'],
  [database.includes('ALTER TABLE products ADD COLUMN manufacturer_part_number TEXT'), 'existing databases migrate manufacturer_part_number additively'],
  [products.includes('p.manufacturer_part_number') && products.includes('p.model_number') && products.includes('p.price as list_price'), 'branch-scoped product reads expose manufacturer and model identity'],
  [products.includes('p.manufacturer_part_number LIKE ?'), 'product search can resolve manufacturer/OEM part numbers'],
  [products.includes('manufacturer_part_number||null'), 'product create/update persists manufacturer part number'],
  [products.includes("'manufacturer_part_number'"), 'CSV import/export includes manufacturer part number'],
  [commerce.includes('manufacturer_part_number: p.manufacturer_part_number || null'), 'commerce sync publishes manufacturer part number'],
  [commerce.includes("const CONTRACT_VERSION = '2026-11-11.1'"), 'commerce sync contract version is bumped for OEM identity'],
  [catalogUi.includes('name="manufacturer_part_number"'), 'catalog editor exposes manufacturer/OEM part number'],
  [catalogUi.includes('p.manufacturer_part_number].some'), 'catalog UI search includes manufacturer/OEM part number'],
  [apiKeyAuth.includes("prefix: '/api/branches'") && apiKeyAuth.includes("scope: 'products:read'"), 'read-only integration scope can resolve provider branches'],
  [apiKeyAuth.includes('SMARTCOMMERCE_READ_API_KEY') && apiKeyAuth.includes('crypto.timingSafeEqual'), 'SmartCommerce machine credential is environment-managed and timing-safe'],
  [apiKeyAuth.includes("needed !== 'products:read'") && apiKeyAuth.includes('SMARTCOMMERCE_READ_SCOPE_FORBIDDEN'), 'SmartCommerce machine credential fails closed outside products:read'],
  [apiKeyAuth.includes('allowedCatalogPath') && apiKeyAuth.includes('!allowedCatalogPath') &&
    apiKeyAuth.includes('/^\\/api\\/products\\/[0-9]+$/'), 'SmartCommerce credential rejects all unapproved product subpaths, exports and branch employee routes'],
  [products.includes('isSmartCommerceRead(req)') && products.includes('isPublishedProduct') && products.includes('publicProduct('),
    'SmartCommerce product endpoints enforce published-only response projections'],
  [branches.includes('isSmartCommerceRead(req)') && branches.includes('.map(publicBranch)'),
    'SmartCommerce branches exclude staffing and pricing internals'],
  [products.includes('category_id || category') && products.includes('if (sku)') && products.includes('if (barcode)'),
    'POS honors SmartCommerce category, SKU and barcode queries as parameterized exact filters'],
  [products.includes("SELECT MAX(0, ROUND(? * (1 + COALESCE(price_tier_percent,0)/100.0), 2)) AS price") &&
    products.includes("if (!branchPrice) return res.status(404)"),
    'POS product detail verifies the selected branch and applies the same branch pricing as search'],
  [apiKeyAuth.includes('publicQueryKeys') && apiKeyAuth.includes('SMARTCOMMERCE_READ_QUERY_FORBIDDEN') &&
    !apiKeyAuth.includes("'supplier_id',\n        'page'"),
    'dedicated catalogue credential rejects supplier and staff-only query filters'],
];

for (const [ok, message] of checks) assert.ok(ok, message);
console.log(`SmartCommerce OEM part identity contract passed (${checks.length} invariants).`);
