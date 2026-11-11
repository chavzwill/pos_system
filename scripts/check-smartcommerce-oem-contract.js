const fs = require('fs');
const assert = require('assert');

const database = fs.readFileSync('database.js', 'utf8');
const products = fs.readFileSync('routes/products.js', 'utf8');
const commerce = fs.readFileSync('routes/commerce-sync.js', 'utf8');
const catalogUi = fs.readFileSync('public/catalog-admin-workspace.js', 'utf8');
const apiKeyAuth = fs.readFileSync('lib/apiKeyAuth.js', 'utf8');

const checks = [
  [database.includes('manufacturer_part_number TEXT'), 'new databases include manufacturer_part_number'],
  [database.includes('ALTER TABLE products ADD COLUMN manufacturer_part_number TEXT'), 'existing databases migrate manufacturer_part_number additively'],
  [products.includes('manufacturer_part_number, p.name') || products.includes('p.manufacturer_part_number, p.name'), 'branch-scoped product reads expose manufacturer part number'],
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
];

for (const [ok, message] of checks) assert.ok(ok, message);
console.log(`SmartCommerce OEM part identity contract passed (${checks.length} invariants).`);
