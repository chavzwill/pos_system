'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const repo=path.join(__dirname,'..');
const routePath=path.join(repo,'routes','employee-customer-pickup-desk.js');
const mountPath=path.join(repo,'routes','employee-end-shift-assistant.js');
const uiPath=path.join(repo,'public','customer-pickup-desk-ui.js');
const deferredPath=path.join(repo,'public','shell-deferred.js');
const route=fs.existsSync(routePath)?fs.readFileSync(routePath,'utf8'):'';
const mount=fs.existsSync(mountPath)?fs.readFileSync(mountPath,'utf8'):'';
const ui=fs.existsSync(uiPath)?fs.readFileSync(uiPath,'utf8'):'';
const deferred=fs.existsSync(deferredPath)?fs.readFileSync(deferredPath,'utf8'):'';
if(route)new vm.Script(route,{filename:'employee-customer-pickup-desk.js'});if(ui)new vm.Script(ui,{filename:'customer-pickup-desk-ui.js'});
const checks=[
 ['Pickup Desk route exists',route.includes("router.get('/customer-pickups")],
 ['Pickup Desk is read only',!route.includes("router.post('/customer-pickups")&&!route.includes("router.patch('/customer-pickups")&&!route.includes("router.put('/customer-pickups")&&!route.includes("router.delete('/customer-pickups")],
 ['Pickup Desk is mounted under employee assist',mount.includes("require('./employee-customer-pickup-desk')")],
 ['Ready repair pickups are included',route.includes('work_orders')&&route.includes("awaiting_pickup")],
 ['Ready rental issues are included',route.includes('rental_agreements')&&route.includes("awaiting_issue")],
 ['Customer identity is shown',route.includes('customer_name')&&route.includes('phone')],
 ['Branch scope is enforced',route.includes('default_branch_id')&&route.includes('branch_id')],
 ['Waiting time or ready-since evidence is exposed',route.includes('ready_since')||route.includes('waiting_since')||route.includes('age_minutes')],
 ['Authoritative workflow action and record identity are returned',route.includes('action')&&route.includes('record_id')&&route.includes('record_type')],
 ['Pickup Desk does not complete or issue records',!route.includes("status='completed'")&&!route.includes("status='picked_up'")&&!route.includes("status='issued'")],
 ['UI exposes Customer Pickup Desk',ui.includes('Customer Pickup Desk')&&ui.includes('data-customer-pickups')],
 ['UI explains the next human action',ui.includes('Open')&&ui.includes('ready')],
 ['UI preserves record context for authoritative handoff',ui.includes('record_id')&&ui.includes('record_type')],
 ['Authenticated shell loads Pickup Desk UI',deferred.includes("'/customer-pickup-desk-ui.js'"))
];
let failed=0;for(const [name,ok] of checks){if(ok)console.log(`PASS Pickup Desk: ${name}`);else{console.error(`FAIL Pickup Desk: ${name}`);failed++;}}
if(failed)process.exit(1);console.log(`Customer Pickup Desk contract OK (${checks.length} checks).`);
