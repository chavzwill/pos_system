'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const repo=path.join(__dirname,'..');
const routePath=path.join(repo,'routes','employee-stock-finder.js');
const mountPath=path.join(repo,'routes','employee-end-shift-assistant.js');
const uiPath=path.join(repo,'public','stock-finder-ui.js');
const sellUiPath=path.join(repo,'public','stock-finder-sell-action.js');
const deferredPath=path.join(repo,'public','shell-deferred.js');
const route=fs.existsSync(routePath)?fs.readFileSync(routePath,'utf8'):'';
const mount=fs.existsSync(mountPath)?fs.readFileSync(mountPath,'utf8'):'';
const ui=fs.existsSync(uiPath)?fs.readFileSync(uiPath,'utf8'):'';
const sellUi=fs.existsSync(sellUiPath)?fs.readFileSync(sellUiPath,'utf8'):'';
const deferred=fs.existsSync(deferredPath)?fs.readFileSync(deferredPath,'utf8'):'';
if(route)new vm.Script(route,{filename:'employee-stock-finder.js'});if(ui)new vm.Script(ui,{filename:'stock-finder-ui.js'});if(sellUi)new vm.Script(sellUi,{filename:'stock-finder-sell-action.js'});
const checks=[
 ['Stock Finder route exists',route.includes("router.get('/stock-finder")],
 ['Stock Finder is read only',!route.includes("router.post('/stock-finder")&&!route.includes("router.patch('/stock-finder")&&!route.includes("router.put('/stock-finder")&&!route.includes("router.delete('/stock-finder")],
 ['Stock Finder is mounted under employee assist',mount.includes("require('./employee-stock-finder')")],
 ['Search requires meaningful query',route.includes('q.length<2')],
 ['Branch on-hand and available quantities are separate',route.includes('on_hand')&&route.includes('available')&&route.includes('reserved')],
 ['Branch results expose exact bin guidance',route.includes('bin_code')&&route.includes('product_bin_assignments')],
 ['Incoming purchase orders expose expected date',route.includes('expected_date')&&route.includes('purchase_orders')],
 ['Branch-restricted staff do not receive other-branch incoming PO rows',route.includes('canSeeOtherBranches')&&route.includes('purchase_orders=purchase_orders.filter')],
 ['Pending transfers are included',route.includes('branch_transfers')&&route.includes('branch_transfer_items')],
 ['Alternatives require structured or staff-approved evidence',route.includes('product_substitutes')&&route.includes('confidence_label')],
 ['Unverified alternatives are labeled for verification',route.includes('Possible alternative')&&route.includes('verify first')],
 ['Route contains no physical stock mutation',!route.includes('UPDATE branch_inventory')&&!route.includes('UPDATE products SET stock_qty')&&!route.includes('inventory_movements')],
 ['UI exposes Stock Finder',ui.includes('Stock Finder')&&ui.includes('data-stock-finder')],
 ['UI offers view transfer and purchasing continuation',ui.includes('Start transfer')&&ui.includes('Open Purchasing')&&ui.includes('View item')],
 ['Sell enhancer offers POS continuation',sellUi.includes('Sell item')&&sellUi.includes("action:'Sales'")],
 ['Authenticated shell loads both Stock Finder enhancers',deferred.includes("'/stock-finder-ui.js'")&&deferred.includes("'/stock-finder-sell-action.js'")]
];
let failed=0;for(const [name,ok] of checks){if(ok)console.log(`PASS Stock Finder: ${name}`);else{console.error(`FAIL Stock Finder: ${name}`);failed++;}}
if(failed)process.exit(1);console.log(`Stock Finder contract OK (${checks.length} checks).`);
