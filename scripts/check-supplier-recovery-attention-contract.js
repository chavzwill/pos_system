'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const route=read('routes/supplier-recovery-attention.js');
const credit=read('routes/supplier-credit-notes.js');
const server=read('server.js');
const ui=read('public/index.html');
new vm.Script(route,{filename:'supplier-recovery-attention.js'});
const checks=[
 ['recovery attention route is mounted',server.includes("app.use('/api/supplier-recovery-attention'")],
 ['attention route requires purchasing or finance authority',route.includes("requireAnyPermission('purchasing','reports_financial','accounts')")],
 ['attention engine initializes recoverables and credit-note schemas',route.includes('ensureSupplierRecoverablesSchema')&&route.includes('creditNotes.ensureSchema')],
 ['attention engine is read only',!route.includes('router.post(')&&!route.includes('router.put(')&&!route.includes('router.patch(')&&!route.includes('router.delete(')],
 ['unconfirmed claims become attention items',route.includes("type:'unconfirmed_claim'")&&route.includes('Supplier obligation has been identified but is still not confirmed.')],
 ['unconfirmed claim age escalates severity',route.includes('critical:45,high:21,medium:7')],
 ['overdue confirmed recoverables are surfaced',route.includes("type:'overdue_recoverable'")&&route.includes('Confirmed supplier recoverable is past its due date.')],
 ['stale confirmed recoverables without due date are surfaced',route.includes("type:'stale_confirmed'")&&route.includes('has remained unsettled for an extended period')],
 ['unresolved accounting basis is surfaced',route.includes("type:'accounting_unresolved'")&&route.includes("evidence?.accountingBasis?.status==='unresolved'")],
 ['dispatched returns without supplier confirmation are surfaced',route.includes("type:'return_no_supplier_response'")&&route.includes('Goods were dispatched back to the supplier but no confirmed supplier credit is recorded.')],
 ['return follow-up uses the linked recoverable claim',route.includes('claim_id:r.recoverable_claim_id')],
 ['unmatched supplier credit-note balances are surfaced',route.includes("type:'unmatched_credit_note'")&&route.includes('not yet matched to recoverable claims')],
 ['matched credit notes not settled to AP are surfaced',route.includes("type:'matched_not_settled'")&&route.includes('has not been applied to Accounts Payable')],
 ['credit-note attention uses settled application evidence',route.includes('SUM(a.amount-a.settled_amount)')],
 ['attention results are priority ranked',route.includes('items.sort((a,b)=>b.rank-a.rank')],
 ['summary counts severity without changing source records',route.includes('summary[x.severity]')&&!route.includes('UPDATE supplier_recoverable_claims')],
 ['headline amount deduplicates overlapping claim exceptions',route.includes("const riskKey='claim:'+x.claim_id")&&route.includes('Math.max(Number(uniqueRisk.get(riskKey)||0)')],
 ['matched-but-unsettled credit notes are excluded from duplicate headline risk',route.includes("else if(x.type==='unmatched_credit_note'&&x.credit_note_id)")],
 ['unmatched credit-note balances remain represented in headline risk',route.includes("const riskKey='unmatched-credit:'+x.credit_note_id")],
 ['credit-note list returns settled-to-AP aggregate',credit.includes('SUM(a.settled_amount)')&&credit.includes('settled_amount')],
 ['recoverables workspace loads recovery attention',ui.includes("this.api('GET','/supplier-recovery-attention')")],
 ['UI labels attention as derived and non-mutating',ui.includes('Derived from authoritative supplier-return, recoverable, credit-note and AP evidence. This queue does not change balances.')],
 ['UI exposes de-duplicated amount at risk and severity counts',ui.includes('Amount at risk')&&ui.includes('Critical')&&ui.includes('Open attention')],
 ['UI exposes reason and next human action',ui.includes('<th>Why it matters</th>')&&ui.includes('<th>Next action</th>')],
 ['UI keeps normal financial actions in authoritative recoverables table',ui.includes('_confirmSupplierRecoverable')&&ui.includes('_recoverSupplierRecoverable')]
];
let failed=0;
for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Supplier recovery attention: ${name}`);if(!ok)failed++;}
if(failed){console.error(`Supplier recovery attention contract FAILED (${failed}/${checks.length} failed).`);process.exit(1);}
console.log(`Supplier recovery attention contract OK (${checks.length} checks).`);
