'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const guide=read('public/guided-mode.js');
const fallback=read('public/guided-mode-exact-fallback.js');
new vm.Script(guide,{filename:'guided-mode.js'});
new vm.Script(fallback,{filename:'guided-mode-exact-fallback.js'});
const checks=[
 ['Guide Me includes supplier recovery journey',guide.includes("id:'supplier-recovery'")&&guide.includes("title:'Recover money owed by a supplier'")],
 ['supplier recovery keywords cover recoverables credit notes returns shortages and statements',guide.includes("'supplier recoverable'")&&guide.includes("'supplier credit note'")&&guide.includes("'supplier return'")&&guide.includes("'shorted goods'")&&guide.includes("'supplier statement'")],
 ['supplier recovery starts from Purchasing / Supplier Recoverables',guide.includes("find:['purchasing','supplier recoverables']")],
 ['supplier recovery distinguishes identified exposure from confirmed money owed',guide.includes('Identified exposure is not the same as confirmed money owed.')],
 ['supplier recovery routes evidence through credit notes returns or statements',guide.includes("find:['credit notes','supplier returns','statements']")],
 ['supplier recovery keeps settlement in controlled workflow',guide.includes('controlled recoverable/AP workflow')],
 ['supplier recovery explicitly says Guide Me never creates settlement',guide.includes('Guide Me never creates the settlement for you.')],
 ['Guide Me includes supplier payment control journey',guide.includes("id:'supplier-payment-control'")&&guide.includes("title:'Plan and pay suppliers safely'")],
 ['supplier payment guidance starts from posted supplier bills/AP authority',guide.includes('Formal AP begins from posted supplier invoices')],
 ['supplier payment guidance tells staff to review priorities and cash forecast first',guide.includes("find:['payment priorities','cash forecast']")],
 ['supplier payment guidance preserves documented discount and late-fee context',guide.includes('documented discounts')&&guide.includes('late-fee exposure')],
 ['supplier payment guidance routes actual payment through Record payment',guide.includes("find:['record payment']")],
 ['supplier payment guidance preserves backend recheck controls',guide.includes('recheck unused supplier credits, duplicate risk and the current net-payment plan')],
 ['supplier payment guidance prioritizes eligible offsets before cash',guide.includes('Apply eligible supplier recoverable offsets first')],
 ['supplier payment guidance preserves independent finance override authority',guide.includes('independent finance override remains authoritative')],
 ['Guide Me includes operating commitment journey',guide.includes("id:'operating-spend'")&&guide.includes("title:'Review recurring operating costs and commitments'")],
 ['operating commitment keywords cover recurring expenses lease utilities software and maintenance',guide.includes("'recurring expenses'")&&guide.includes("'rent lease'")&&guide.includes("'utilities'")&&guide.includes("'software subscriptions'")&&guide.includes("'maintenance contract'")],
 ['operating commitment guidance starts from Supplier Bills & Payments',guide.includes("find:['supplier bills & payments']")],
 ['operating commitment guidance reviews expected cadence allocation due and renewal evidence',guide.includes('expected recurring amount, cadence, allocation target, next due date and renewal evidence')],
 ['operating commitment guidance routes invoice evidence through Match invoice and Reconcile',guide.includes("find:['match invoice','reconcile']")],
 ['operating commitment guidance states matching does not change AP',guide.includes('Matching is evidence only and does not change AP.')],
 ['operating commitment guidance exposes Performance for drift and renewals',guide.includes("find:['performance']")&&guide.includes('bill drift')&&guide.includes('renewals')],
 ['exact fallback includes supplier recovery task',fallback.includes("'Recover money owed by a supplier'")],
 ['exact fallback includes supplier payment task',fallback.includes("'Plan and pay suppliers safely'")],
 ['exact fallback includes operating commitment task',fallback.includes("'Review recurring operating costs and commitments'")],
 ['fallback recovery targets real UI labels',fallback.includes("['credit notes','supplier returns','statements']")],
 ['fallback payment targets real UI labels',fallback.includes("['payment priorities','cash forecast']")],
 ['fallback commitments target match reconcile performance controls',fallback.includes("['match invoice','reconcile']")&&fallback.includes("4:['performance']")],
 ['SpendOS Guide Me tasks contain no direct API or mutation call',!guide.substring(guide.indexOf("id:'supplier-recovery'"),guide.indexOf("id:'erp'")).includes('fetch(')&&!guide.substring(guide.indexOf("id:'supplier-recovery'"),guide.indexOf("id:'erp'")).includes("method:'POST'")],
 ['SpendOS Guide Me task copy does not imply automatic financial decisions',guide.includes('never creates the settlement')&&guide.includes('override remains authoritative')&&guide.includes('Matching is evidence only')]
];
let failed=0;
for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} SpendOS Guide Me: ${name}`);if(!ok)failed++;}
if(failed){console.error(`SpendOS Guide Me contract FAILED (${failed}/${checks.length} failed).`);process.exit(1);}
console.log(`SpendOS Guide Me contract OK (${checks.length} checks).`);
