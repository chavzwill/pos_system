'use strict';
const fs=require('fs'),path=require('path');
const root=path.join(__dirname,'..','public');
const files=['accounting-intelligence.js','financial-controls-intelligence.js','cash-drawer-workspace.js','cashier-controls-workspace.js','ecommerce-operations-workspace.js','employee-workspace-home.js','employee-assist-ui.js','logistics-intelligence.js','guided-mode.js','guided-mode-orchestrator.js','guided-mode-exact-fallback.js','guided-mode-completion.js','guided-mode-role-context.js','operations-attention-center.js','purchasing-workspace.js'];
const banned=[
  'Inventory Intelligence','Dispatch Command Center','Logistics intelligence',
  'Cash Drawer & Reconciliation','Receipt Evidence','Receipt & payment evidence','Tender custody evidence',
  'Loading dispatch intelligence','Loading session evidence','Refreshing transaction evidence',
  'ERP Intelligence / Analytics','Use ERP / inventory intelligence'
];
const requiredStockPlanning=['guided-mode.js','guided-mode-orchestrator.js','guided-mode-exact-fallback.js','guided-mode-completion.js','guided-mode-role-context.js','operations-attention-center.js','purchasing-workspace.js'];
let failed=0;
for(const file of files){const text=fs.readFileSync(path.join(root,file),'utf8');for(const term of banned){if(text.includes(term)){console.error(`FAIL Human language: ${file} exposes "${term}"`);failed++;}}}
for(const file of requiredStockPlanning){const text=fs.readFileSync(path.join(root,file),'utf8');if(!text.includes('Stock Planning & Replenishment')){console.error(`FAIL Human language: ${file} is missing canonical stock-planning wording`);failed++;}}
const assist=fs.readFileSync(path.join(__dirname,'..','routes','employee-assist.js'),'utf8');
const ui=fs.readFileSync(path.join(root,'employee-assist-ui.js'),'utf8');
const required=[
 ['follow-ups are attributable to the signed-in employee',assist.includes("employee_id=? AND completed=0 AND type='follow_up'")],
 ['follow-ups complete only for the signed-in employee',assist.includes("employee_id=? AND completed=0 AND type='follow_up'")&&assist.includes("completed_at=CURRENT_TIMESTAMP")],
 ['My Day includes repair customer decisions',assist.includes('needs customer approval')&&assist.includes("'Work Orders'")],
 ['My Day includes dispatch exceptions',assist.includes('driver not assigned')&&assist.includes("'Dispatch & Deliveries'")],
 ['My Day includes overdue supplier bills',assist.includes('Supplier invoice')&&assist.includes("'Supplier Ledger & Payables'")],
 ['employee tools expose follow-ups',ui.includes('data-ea-followups')&&ui.includes('openFollowups')]
];
for(const [name,ok] of required){if(!ok){console.error(`FAIL Employee effort: ${name}`);failed++;}}
if(failed)process.exit(1);
console.log(`Human-language UI contract OK (${files.length} staff-facing surfaces checked; ${required.length} employee-effort checks).`);
