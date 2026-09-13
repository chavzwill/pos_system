'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const repo=path.join(__dirname,'..');
const routePath=path.join(repo,'routes','employee-stock-finder.js');
const assistPath=path.join(repo,'routes','employee-assist.js');
const uiPath=path.join(repo,'public','employee-assist.js');
const route=fs.existsSync(routePath)?fs.readFileSync(routePath,'utf8'):'';
const assist=fs.existsSync(assistPath)?fs.readFileSync(assistPath,'utf8'):'';
const ui=fs.existsSync(uiPath)?fs.readFileSync(uiPath,'utf8'):'';
if(route)new vm.Script(route,{filename:'employee-stock-finder.js'});
const checks=[
 ['Stock Finder route exists',route.includes("router.get('/stock-finder")],
 ['Stock Finder is read only',!route.includes("router.post('/stock-finder")&&!route.includes("router.patch('/stock-finder")&&!route.includes("router.put('/stock-finder")&&!route.includes("router.delete('/stock-finder")],
 ['Stock Finder is mounted under employee assist',assist.includes("require('./employee-stock-finder')")],
 ['Search requires meaningful query',route.includes('q.length<2')],
 ['Branch on-hand and available quantities are separate',route.includes('on_hand')&&route.includes('available')&&route.includes('reserved')],
 ['Branch results expose exact bin guidance',route.includes('bin_code')&&route.includes('product_bin_assignments')],
 ['Incoming purchase orders expose expected date',route.includes('expected_date')&&route.includes('purchase_orders')],
 ['Pending transfers are included',route.includes('transfers')&&route.includes('transfer_items')],
 ['Alternatives require structured or staff-approved evidence',route.includes('product_substitutes')&&route.includes('confidence_label')],
 ['Unverified alternatives are labeled for verification',route.includes('Possible alternative')&&route.includes('verify first')],
 ['Route contains no physical stock mutation',!route.includes('UPDATE branch_inventory')&&!route.includes('UPDATE products SET stock_qty')&&!route.includes('inventory_movements')],
 ['UI exposes Stock Finder',ui.includes('Stock Finder')&&ui.includes('data-stock-finder')],
 ['UI offers existing workflow continuation',ui.includes('Start transfer')&&ui.includes('Open Purchasing')&&ui.includes('View item')]
];
let failed=0;for(const [name,ok] of checks){if(ok)console.log(`PASS Stock Finder: ${name}`);else{console.error(`FAIL Stock Finder: ${name}`);failed++;}}
if(failed)process.exit(1);console.log(`Stock Finder contract OK (${checks.length} checks).`);
