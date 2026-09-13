'use strict';
const fs=require('fs'),path=require('path');
const root=path.join(__dirname,'..','public');
const files=['accounting-intelligence.js','financial-controls-intelligence.js','cash-drawer-workspace.js','cashier-controls-workspace.js','ecommerce-operations-workspace.js','employee-workspace-home.js','logistics-intelligence.js','guided-mode.js'];
const banned=[
  'Inventory Intelligence','Accounting Intelligence','Dispatch Command Center','Logistics intelligence',
  'Cash Drawer & Reconciliation','Receipt Evidence','Receipt & payment evidence','Tender custody evidence',
  'Loading dispatch intelligence','Loading session evidence','Refreshing transaction evidence',
  'ERP Intelligence / Analytics','Use ERP / inventory intelligence'
];
let failed=0;
for(const file of files){const text=fs.readFileSync(path.join(root,file),'utf8');for(const term of banned){if(text.includes(term)){console.error(`FAIL Human language: ${file} exposes "${term}"`);failed++;}}}
if(failed)process.exit(1);
console.log(`Human-language UI contract OK (${files.length} staff-facing surfaces checked).`);
