'use strict';
const fs = require('node:fs');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

const form = read('public/purchasing-workspace.js');
const lookup = read('lib/predictive-lookup.js');
const backend = read('routes/purchase-orders.js');
const hardening = read('routes/purchase-order-hardening.js');
const css = read('public/ui-workspaces.css');

const checks = [
  ['PO still requires a document-level supplier', hardening.includes('A supplier is required for a purchase order')],
  ['Catalog results are active products without a supplier filter', lookup.includes('FROM products p') && lookup.includes('WHERE p.active=1') && !lookup.includes('p.supplier_id = ?')],
  ['PO editor still looks up canonical product records', form.includes("domain:'product'") && form.includes('includeVariations:false')],
  ['PO form explicitly supports supplier-independent items', form.includes('No product-to-supplier link is required')],
  ['One-off items explain stock reconciliation limits', form.includes('received stock is only reconciled after linking')],
  ['Backend accepts product ID without supplier equality restriction', backend.includes('SELECT * FROM products WHERE id = ?') && !backend.includes('product.supplier_id')],
  ['Zero negotiated cost is preserved', backend.includes('item.unit_cost ?? (product ? product.cost : 0)')],
  ['Narrow viewports retain receiving quantity', css.includes('.tt-purch__item>*:last-child{display:block!important}')],
  ['Mobile line-item grid and purchase unit are responsive', css.includes('.tt-purch__compose-line>.tt-purch-uom{grid-column:1/-1!important')],
  ['Mobile composer text avoids iOS auto-zoom', css.includes('.tt-purch__composer textarea{font-size:16px!important')]
];
for(const [name, pass] of checks) console.log((pass ? 'PASS' : 'FAIL') + ' PO supplier-neutral: ' + name);
if(checks.some(([,pass])=>!pass))process.exit(1);
console.log('PO supplier-neutral contract OK (' + checks.length + ' source checks).');
