'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const route=read('routes/supplier-ledger.js');
const ui=read('public/supplier-ledger.js');
new vm.Script(route,{filename:'supplier-ledger.js'});
new vm.Script(ui,{filename:'supplier-ledger-ui.js'});
const start=route.indexOf("router.get('/payment-priorities'");
const end=route.indexOf("router.get('/payment-timing'",start);
const q=route.slice(start,end);
const checks=[
 ['payment-priority queue requires financial permission',route.includes("router.get('/payment-priorities', requirePermission('reports_financial')")],
 ['queue supports branch scope for invoices',q.includes("invoiceBranch=' AND si.branch_id=?'")],
 ['queue uses only open non-void invoices',q.includes("si.status!='void'")&&q.includes('MAX(0,si.total-COALESCE(a.paid,0))>0.001')],
 ['queue invoice balance subtracts cash payments and recoverable offsets',q.includes('supplier_payment_allocations')&&q.includes('supplier_recoverable_ap_allocations')],
 ['queue eligible offsets require recognized accounting basis',q.includes('JOIN supplier_recoverable_accounting_basis b ON b.claim_id=c.id')],
 ['queue eligible offsets exclude matched unsettled credit-note reservations',q.includes('c.confirmed_amount-c.recovered_amount-COALESCE(r.reserved,0)')],
 ['queue branch scope includes branch/global recoverables',q.includes("recBranch=' AND (c.branch_id=? OR c.branch_id IS NULL)'")],
 ['queue branch scope includes branch/global formal credits',q.includes("creditBranch=' AND (n.branch_id=? OR n.branch_id IS NULL)'")],
 ['recoverables are consumed in supplier invoice due-date order',q.includes("ORDER BY si.supplier_id,COALESCE(si.due_date,si.invoice_date),si.id")],
 ['planned offset cannot exceed invoice or remaining recoverable pool',q.includes('Math.min(balance,available)')],
 ['cash-after-offset is explicit',q.includes('const cashAfterOffset=money(balance-plannedOffset)')],
 ['overdue obligations receive highest base urgency',q.includes("score+=100+Math.min(30,Math.abs(dueIn))")],
 ['due within 3 days is explicitly prioritized',q.includes("dueIn<=3")&&q.includes("score+=75")],
 ['due within 7 days is explicitly prioritized',q.includes("dueIn<=7")&&q.includes("score+=55")],
 ['due within 14 days is lower urgency than 7-day obligations',q.includes("dueIn<=14")&&q.includes("score+=30")],
 ['discount urgency requires documented amount and unexpired deadline',q.includes('discount>0&&discountIn!==null&&discountIn>=0')],
 ['discount urgency requires effectively unpaid invoice',q.includes('paid<=0.009')],
 ['discount urgency requires cash still remaining after offsets',q.includes('cashAfterOffset>0.009')],
 ['nearer documented discount deadline receives higher score',q.includes("discountIn<=2?85:discountIn<=5?60:35")],
 ['late-fee risk requires documented amount/effective date and remaining cash',q.includes('lateFee>0&&lateFeeIn!==null&&lateFeeIn>=0&&lateFeeIn<=7&&cashAfterOffset>0.009')],
 ['nearer late-fee date receives higher score',q.includes("lateFeeIn<=2?70:45")],
 ['full recoverable coverage lowers cash-payment urgency',q.includes("score-=35")&&q.includes('fully covered by eligible recoverable offset')],
 ['partial recoverable coverage lowers cash-payment urgency modestly',q.includes("score-=15")&&q.includes('Partly coverable by eligible recoverable offset')],
 ['unmatched formal supplier credit is visible but not treated as settlement',q.includes("score-=10")&&q.includes('Unmatched formal supplier credit exists')],
 ['queue does not subtract unmatched credits from cash-after-offset',q.includes('cash_after_offset:cashAfterOffset')&&!q.includes('cashAfterOffset-unmatchedCredit')],
 ['queue assigns transparent priority bands',q.includes("score>=120?'critical':score>=80?'high':score>=40?'medium':'low'")],
 ['queue sorts by score then cash exposure',q.includes('b.priority_score-a.priority_score||b.cash_after_offset-a.cash_after_offset')],
 ['queue summary counts priority bands',q.includes("critical:items.filter(x=>x.priority==='critical').length")&&q.includes("high:items.filter(x=>x.priority==='high').length")],
 ['queue summary shows cash after offsets',q.includes('cash_after_offsets:money(items.reduce')],
 ['queue summary shows documented discount opportunity',q.includes('documented_discount_opportunity')],
 ['queue explicitly states it is review-only',q.includes('Review priority only.')&&q.includes('do not approve, schedule, or execute payments')],
 ['queue endpoint contains no financial mutations',!q.includes('INSERT INTO')&&!q.includes('UPDATE ')&&!q.includes('DELETE FROM')],
 ['UI exposes Payment priorities',ui.includes('tt-supplier-ledger-priorities')&&ui.includes('Payment priorities')],
 ['UI fetches payment-priority queue',ui.includes("api('/payment-priorities'+q)")],
 ['UI displays priority score and reason',ui.includes('Score ')&&ui.includes('Why review now')],
 ['UI displays planned offset and cash after offset separately',ui.includes('<th>Planned offset</th>')&&ui.includes('<th>Cash after offset</th>')],
 ['UI displays queue basis',ui.includes('<strong>Queue basis:</strong>')],
 ['priority UI has no payment mutation action',!ui.substring(ui.indexOf('async function showPaymentPriorities'),ui.indexOf('async function showCashForecast')).includes("method:'POST'")],
 ['actual supplier payment remains a separate secured workflow',ui.includes('function recordPayment()')&&ui.includes("api('/payments',{method:'POST'")]
];
let failed=0;
for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Supplier payment priority: ${name}`);if(!ok)failed++;}
if(failed){console.error(`Supplier payment priority contract FAILED (${failed}/${checks.length} failed).`);process.exit(1);}
console.log(`Supplier payment priority contract OK (${checks.length} checks).`);
