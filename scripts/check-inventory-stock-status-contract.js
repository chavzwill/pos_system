'use strict';
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const server=read('server.js');
const route=read('routes/inventory-stock-status.js');
const lib=read('lib/inventory-stock-status.js');
const checkout=read('routes/retail-checkout-hardening.js');
const perms=read('lib/permissions.js');
const checks=[
  ['stock status route mounted',server.includes("/api/inventory-stock-status', require('./routes/inventory-stock-status')")],
  ['restricted stock balance ledger exists',lib.includes('inventory_stock_status_balances')],
  ['status event audit ledger exists',lib.includes('inventory_stock_status_events')],
  ['inspection stock is restricted',lib.includes("'inspection','blocked','quarantine','damaged','expired'")],
  ['status moves require reason evidence',lib.includes('A stock-status movement reason is required')],
  ['status moves cannot exceed available stock',lib.includes('state.available+1e-9<qty')&&lib.includes('are available for disposition')&&lib.includes('getActiveReservedQty')],
  ['actor identity comes from authenticated employee',route.includes('employeeId:req.employee?.id')],
  ['granular disposition permission exists',perms.includes("{ key: 'inventory_disposition' }")],
  ['POS checkout reads disposition-aware availability',checkout.includes("require('../lib/inventory-stock-status')")],
  ['POS checkout excludes restricted stock',checkout.includes('state.restricted') && checkout.includes('state.available < qty')],
];
let failed=0;
for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Inventory stock status: ${name}`);if(!ok)failed++;}
if(failed){console.error(`Inventory stock-status contract FAILED (${failed}/${checks.length} failed).`);process.exit(1);}
console.log(`Inventory stock-status contract OK (${checks.length} checks).`);
