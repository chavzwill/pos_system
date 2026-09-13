'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const repo=path.join(__dirname,'..'),root=path.join(repo,'public');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');
const home=read('employee-workspace-home.js'),assist=read('employee-assist-ui.js');
const wo=read('work-orders-workspace.js'),rent=read('rentals-workspace.js'),purch=read('purchasing-workspace.js');
const inv=read('inventory-workspace.js'),log=read('logistics-intelligence.js');
const loader=read('workspace-loader-hardening.js'),shell=read('app-shell.js');
const endShift=fs.readFileSync(path.join(repo,'routes','employee-end-shift-assistant.js'),'utf8');
new vm.Script(endShift,{filename:'employee-end-shift-assistant.js'});
const employeeAssistRoute=fs.readFileSync(path.join(repo,'routes','employee-assist.js'),'utf8');
new vm.Script(employeeAssistRoute,{filename:'employee-assist.js'});
const checks=[
 ['My Day preserves record identity',home.includes('data-record-id')&&home.includes('data-record-type')],
 ['My Day delegates contextual opening',home.includes('TotalToolsEmployeeAssist?.openContext')],
 ['Search results preserve record identity',assist.includes('data-record-id')&&assist.includes('openContext({action:b.dataset.action')],
 ['Employee assist has context router',assist.includes('async function openContext')&&assist.includes('openRecord')],
 ['Repairs can open an exact work order',wo.includes('openRecord:(id)=>open({recordId:id})')],
 ['Rentals can open an exact agreement',rent.includes('openRecord:(id)=>open({recordId:id})')],
 ['Purchasing can open an exact request or PO',purch.includes('openRecord:(id,opts={})=>open({...opts,recordId:id})')],
 ['Inventory can open an exact item',inv.includes('openRecord:(id)=>open({recordId:id})')],
 ['Dispatch can focus an exact job',log.includes('data-job="${j.id}"')&&log.includes('openRecord:(id)=>open({recordId:id})')],
 ['Deferred loader preserves context',loader.includes("openFeature(key,title='Workspace',options={})")&&loader.includes('api.open(options||{})')],
 ['Fast shell preserves context',shell.includes('openFeature(key,title,options={})')&&shell.includes('api.open(options||{})')],
 ['Employee assist loads deferred workspace with record context',assist.includes('TotalToolsWorkspaceLoader?.open')&&assist.includes('await loader(hit[2],action,{recordId:id')],
 ['Employee assist exports contextual opener',assist.includes('openHandovers,openEndShift,openContext')],
 ['End shift is mounted under employee assist',employeeAssistRoute.includes("router.use(require('./employee-end-shift-assistant'))")],
 ['End shift blocks sign-out readiness on an open drawer',endShift.includes("severity:'blocking'")&&endShift.includes('ready_to_sign_out:openDrawers.length===0')],
 ['End shift does not auto-close operational records',!endShift.includes("UPDATE drawer_sessions SET status='closed'")&&!endShift.includes("UPDATE dispatch_jobs SET status='completed'")],
 ['End shift creates attributable handover evidence',endShift.includes('INSERT INTO shift_handovers')&&endShift.includes('req.employee.id')],
 ['End shift handover is idempotent while still open',endShift.includes("record_type='end_shift' AND status='open'")&&endShift.includes('UPDATE shift_handovers SET priority=')],
 ['End shift UI is available from employee tools',assist.includes('data-ea-end-shift')&&assist.includes('async function openEndShift()')],
 ['Sign out is only rendered when server says ready',assist.includes("d.ready_to_sign_out?'<button id=\"tt-ea-signout\"")],
 ['Purchase requests waiting for review use authoritative submitted state',employeeAssistRoute.includes("status IN ('submitted','approved')")&&!employeeAssistRoute.includes("status IN ('pending','approved')")],
 ['Approval inbox is permission aware',employeeAssistRoute.includes("router.get('/approvals'")&&employeeAssistRoute.includes("allowed(req,['purchase_requests','purchasing'])")],
 ['Approval inbox is branch scoped and submitted only',employeeAssistRoute.includes("pr.status='submitted'")&&employeeAssistRoute.includes("(? IS NULL OR pr.branch_id=?)")],
 ['Approval inbox does not bypass purchasing decision authority',!employeeAssistRoute.includes('UPDATE purchase_requests SET status')],
 ['Approval UI opens exact request for review',assist.includes('data-ea-approvals')&&assist.includes('async function openApprovals()')&&assist.includes("type:'Purchase request'"))
];
let failed=0;
for(const [name,ok] of checks){if(ok)console.log(`PASS Contextual actions: ${name}`);else{console.error(`FAIL Contextual actions: ${name}`);failed++;}}
if(failed)process.exit(1);
console.log(`Contextual actions contract OK (${checks.length} checks).`);
