'use strict';
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const server=read('server.js');
const lib=read('lib/inventory-traceability.js');
const route=read('routes/inventory-traceability.js');
const receive=read('routes/purchase-receipt-traceability.js');
const checks=[
  ['traceability API mounted',server.includes("/api/inventory-traceability', require('./routes/inventory-traceability')")],
  ['traceable receiving mounted before legacy hardening',server.indexOf("purchase-receipt-traceability")<server.indexOf("purchase-order-hardening")],
  ['product tracking profiles exist',lib.includes('inventory_tracking_profiles')],
  ['lot identity ledger exists',lib.includes('inventory_lots')],
  ['serial identity ledger exists',lib.includes('inventory_serials')],
  ['identity event audit ledger exists',lib.includes('inventory_identity_events')],
  ['serial numbers are globally unique',lib.includes('serial_number TEXT NOT NULL UNIQUE')],
  ['serial receipt count must match received quantity',lib.includes('serials.length!==receiptQty')&&lib.includes('Serial-tracked receipt requires exactly ${receiptQty} serial numbers')],
  ['duplicate serials in same receipt are rejected',lib.includes('Duplicate serial number supplied in the same receipt')],
  ['previously seen serials are rejected',lib.includes('already exists in inventory history')],
  ['lot quantities must reconcile to receipt quantity',lib.includes('Lot allocations must total the received quantity')],
  ['expiry requirement is enforced',lib.includes('Expiry date is required for every received lot')&&lib.includes('Expiry date is required for every serial-controlled unit')],
  ['manufacture date requirement is enforced',lib.includes('Manufacture date is required for every received lot')],
  ['tracking mode cannot be silently changed after identity history',route.includes('Tracking mode cannot be changed after serial/lot identity history exists')],
  ['receiving branch is mandatory for inventory receipt',receive.includes('A receiving branch is required before inventory can be received')],
  ['identity validation happens before stock mutation',receive.indexOf('validateReceiptIdentity')<receive.indexOf('UPDATE products SET stock_qty=stock_qty+?')],
  ['receipt identity is linked to receipt item evidence',receive.includes('receiptItemId')&&lib.includes('purchase_receipt_item_id')],
  ['serial/lot events record authenticated actor',receive.includes('employeeId:actor(req)')],
  ['expiry-oriented lot query exists',route.includes('expiring_before')],
  ['serial lookup endpoint exists',route.includes("router.get('/serials'")]
];
let failed=0;for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Inventory traceability: ${name}`);if(!ok)failed++;}
if(failed){console.error(`Inventory traceability contract FAILED (${failed}/${checks.length} failed).`);process.exit(1);}
console.log(`Inventory traceability contract OK (${checks.length} checks).`);
