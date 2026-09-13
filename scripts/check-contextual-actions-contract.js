'use strict';
const fs=require('fs'),path=require('path');
const root=path.join(__dirname,'..','public');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');
const home=read('employee-workspace-home.js'),assist=read('employee-assist-ui.js');
const wo=read('work-orders-workspace.js'),rent=read('rentals-workspace.js'),purch=read('purchasing-workspace.js');
const inv=read('inventory-workspace.js'),log=read('logistics-intelligence.js');
const checks=[
 ['My Day preserves record identity',home.includes('data-record-id')&&home.includes('data-record-type')],
 ['My Day delegates contextual opening',home.includes('TotalToolsEmployeeAssist?.openContext')],
 ['Search results preserve record identity',assist.includes('data-record-id')&&assist.includes('openContext({action:b.dataset.action')],
 ['Employee assist has context router',assist.includes('async function openContext')&&assist.includes('openRecord')],
 ['Repairs can open an exact work order',wo.includes('openRecord:(id)=>open({recordId:id})')],
 ['Rentals can open an exact agreement',rent.includes('openRecord:(id)=>open({recordId:id})')],
 ['Purchasing can open an exact request or PO',purch.includes('openRecord:(id,opts={})=>open({...opts,recordId:id})')],
 ['Inventory can open an exact item',inv.includes('openRecord:(id)=>open({recordId:id})')],
 ['Dispatch can focus an exact job',log.includes('data-job="${j.id}"')&&log.includes('openRecord:(id)=>open({recordId:id})')]
];let failed=0;
for(const [name,ok] of checks){
 if(ok)console.log(`PASS Contextual actions: ${name}`);
 else{console.error(`FAIL Contextual actions: ${name}`);failed++;}
}
if(failed)process.exit(1);
console.log(`Contextual actions contract OK (${checks.length} checks).`);
