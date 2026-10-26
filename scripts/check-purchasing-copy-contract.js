'use strict';
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const ui=read('public/purchasing-workspace.js');
const css=read('public/ui-workspaces.css');
const html=read('public/app-shell.html');
const loader=read('public/workspace-loader-hardening.js');
const checks=[
 ['Only creator-permitted staff see document copy',ui.includes("canCreate(state.tab)?")&&ui.includes('data-copy-document')],
 ['Copy action uses selected details rather than list summaries',ui.includes('const x=state.selected,type=state.tab;')&&ui.includes('Array.isArray(x.items)')],
 ['Copy prepares the existing composer, not a write request',ui.includes('function copySelected()')&&ui.includes('render();focusComposer(type);')],
 ['Copy preserves catalog item identity, quantity, cost',ui.includes('function copiedLine(item={})')&&ui.includes('item.quantity_ordered??item.quantity??1')&&ui.includes('item.unit_cost??0')],
 ['Copy does not clone original IDs, approval or receipt state',!ui.slice(ui.indexOf('function copiedLine('),ui.indexOf('function updateLineStatus')).includes('quantity_received:')&&!ui.slice(ui.indexOf('function copySelected()'),ui.indexOf('function updateLineStatus')).includes('status:x.status')],
 ['Copied PO review includes purpose and beneficiary',ui.includes("approval_purpose:type==='po'?String(x.approval_purpose")&&ui.includes("requested_for:type==='po'?String(x.requested_for")],
 ['Copied PR preserves request type and department',ui.includes("x.request_type==='internal_use'")&&ui.includes("String(x.department||'')")],
 ['Old scheduled delivery dates are cleared',ui.includes("date:'',department:type==='pr'")],
 ['Source document is never auto submitted',ui.includes('a new number is assigned only when saved.')||ui.includes('A new number is assigned only when saved.')],
 ['Duplicate line uses new editable object',ui.includes('state.composer.items.splice(index+1,0,copiedLine(line))')],
 ['Copy and remove buttons remain separate direct children',ui.includes('data-duplicate-line=')&&ui.includes('data-remove-line=')],
 ['Narrow mobile copy buttons remain within row',css.includes('.tt-purch__compose-line>.tt-purch__duplicate-line')&&css.includes('grid-template-columns:minmax(0,1fr) minmax(0,1fr) 48px 44px!important')],
 ['Cache version coordinated with shell',(()=>{const match=loader.match(/const VERSION='([^']+)'/);return !!match&&html.includes('/ui-workspaces.css?v='+match[1])&&read('public/app-shell.js').includes('?v='+match[1]);})()]
];
for(const [name,pass] of checks)console.log((pass?'PASS':'FAIL')+' Purchasing copy: '+name);
if(checks.some(([,pass])=>!pass))process.exit(1);
console.log('Purchasing copy contract OK ('+checks.length+' checks).');
