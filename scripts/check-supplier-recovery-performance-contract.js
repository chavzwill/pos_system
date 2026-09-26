'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const route=read('routes/supplier-recovery-performance.js');
const server=read('server.js');
const ui=read('public/index.html');
new vm.Script(route,{filename:'supplier-recovery-performance.js'});
const checks=[
 ['supplier recovery performance route is mounted',server.includes("app.use('/api/supplier-recovery-performance'")],
 ['performance requires purchasing or finance authority',route.includes("requireAnyPermission('purchasing','reports_financial','accounts')")],
 ['performance initializes recoverables cases and credit-note schemas',route.includes('ensureSupplierRecoverablesSchema')&&route.includes('recoveryCases.ensureSchema')&&route.includes('creditNotes.ensureSchema')],
 ['performance route is read only',!route.includes('router.post(')&&!route.includes('router.patch(')&&!route.includes('router.put(')&&!route.includes('router.delete(')],
 ['performance uses authoritative claim balances',route.includes('confirmed_amount')&&route.includes('recovered_amount')&&route.includes('outstanding_total')],
 ['performance derives overdue balance from due dates',route.includes('overdue_outstanding')&&route.includes('c.due_date')],
 ['60-plus overdue exposure is separately visible',route.includes('overdue_60_plus')],
 ['unconfirmed claims are counted',route.includes("if(c.status==='identified')row.unconfirmed_count++")],
 ['accounting unresolved count comes from claim evidence',route.includes("ev?.accountingBasis?.status==='unresolved'")],
 ['confirmation days are derived from obligation to confirmed timestamps',route.includes("daysBetween(c.obligation_date||c.created_at,c.confirmed_at)")],
 ['recovery days are derived from confirmed to recovered timestamps',route.includes('daysBetween(c.confirmed_at,c.recovered_at)')],
 ['recovery rate uses recovered over confirmed amounts',route.includes('row.recovered_total/row.confirmed_total*100')],
 ['supplier disputes come from recovery cases',route.includes("if(c.status==='disputed')row.dispute_count++")],
 ['broken promises require past promise date and outstanding balance',route.includes("c.status==='promised'")&&route.includes('promised_settlement_date')&&route.includes('outstanding>0')],
 ['return response gaps require dispatched return and identified claim',route.includes("r.claim_status==='identified'")&&route.includes('age>=7')],
 ['unmatched supplier credit-note value is included',route.includes('unmatched_credit_note_value')&&route.includes('n.remaining_amount')],
 ['advisory levels are transparent named conditions not opaque score',route.includes("reasons.push('confirmed recoverables are overdue')")&&route.includes("reasons.push(Number(row.broken_promise_count||0)>0?'supplier settlement promise was missed'")],
 ['high advisory requires concrete 60-plus overdue or multiple unresolved accounting conditions',route.includes("Number(row.overdue_60_plus||0)>0||Number(row.unresolved_accounting_count||0)>=2")],
 ['performance engine does not block purchasing',!route.includes('blocked')&&!route.includes('suspend')&&!route.includes('reject_purchase')],
 ['performance summary separately reports outstanding overdue and unmatched credits',route.includes('total_outstanding')&&route.includes('total_overdue')&&route.includes('unmatched_credit_note_value')],
 ['UI loads supplier recovery performance',ui.includes("this.api('GET','/supplier-recovery-performance')")],
 ['UI explicitly says no hidden score or automatic supplier block',ui.includes('No supplier is automatically blocked or ranked by a hidden score')],
 ['UI exposes advisory reasons in plain language',ui.includes("const reasons=(s.advisory_reasons||[]).join('; ')")],
 ['UI exposes recovery rate and average confirmation/recovery days',ui.includes('<th>Recovery rate</th>')&&ui.includes('<th>Avg confirmation</th>')&&ui.includes('<th>Avg recovery</th>')],
 ['UI exposes disputes broken promises accounting gaps and unmatched credits',ui.includes('<th>Disputes</th>')&&ui.includes('<th>Broken promises</th>')&&ui.includes('<th>Accounting gaps</th>')&&ui.includes('<th>Unmatched credits</th>')]
];
let failed=0;
for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Supplier recovery performance: ${name}`);if(!ok)failed++;}
if(failed){console.error(`Supplier recovery performance contract FAILED (${failed}/${checks.length} failed).`);process.exit(1);}
console.log(`Supplier recovery performance contract OK (${checks.length} checks).`);
