'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const route=read('routes/operating-commitments.js');
const ui=read('public/supplier-ledger.js');
new vm.Script(route,{filename:'operating-commitments.js'});
new vm.Script(ui,{filename:'supplier-ledger-ui.js'});
const start=route.indexOf("router.get('/performance'");
const end=route.indexOf("router.get('/attention'",start);
const perf=route.slice(start,end);
const checks=[
 ['performance endpoint exists before generic commitment id route',start>0&&start<route.indexOf("router.get('/:id'")],
 ['performance endpoint inherits finance or purchasing authority',route.includes("router.use(requireAnyPermission('reports_financial','purchasing'))")],
 ['performance defaults to active commitments',perf.includes(`let where="oc.status='active'"`)],
 ['performance can be branch scoped',perf.includes("if(req.query.branch_id){where+=' AND oc.branch_id=?'")],
 ['performance can be category scoped',perf.includes("if(req.query.category){where+=' AND oc.category=?'")],
 ['performance uses linked invoice evidence grouped by service period',perf.includes('FROM operating_commitment_invoice_links l')&&perf.includes('GROUP BY l.commitment_id,l.service_period')],
 ['performance preserves chronological service-period ordering',perf.includes('ORDER BY l.commitment_id,l.service_period')],
 ['expected amount comes from commitment record',perf.includes('const expected=money(c.expected_amount)')],
 ['actual total sums linked invoice evidence',perf.includes('actualTotal=money(periods.reduce')],
 ['expected total scales by linked period count',perf.includes('expectedTotal=money(expected*count)')],
 ['total variance is actual minus expected',perf.includes('totalVariance=money(actualTotal-expectedTotal)')],
 ['over expected periods use monetary tolerance',perf.includes('actual_linked_amount)>expected+0.01')],
 ['under expected periods use monetary tolerance',perf.includes('actual_linked_amount)<expected-0.01')],
 ['on-target periods are derived from total minus over/under',perf.includes('const onTarget=count-over-under')],
 ['consecutive over-expected periods are derived from latest history backwards',perf.includes('for(let i=periods.length-1;i>=0;i--)')&&perf.includes('consecutiveOver++')],
 ['latest service period uses newest linked evidence',perf.includes('const latest=count?periods[count-1]:null')],
 ['prior service period is preserved for drift comparison',perf.includes('previous=count>1?periods[count-2]:null')],
 ['latest variance compares latest actual to commitment expected',perf.includes('latestVariance=count?money(latestActual-expected):0')],
 ['latest variance percent is derived from expected amount',perf.includes('latestVariance/expected')],
 ['period-over-period drift compares latest linked bill to prior linked bill',perf.includes('(latestActual-priorActual)/priorActual')],
 ['annualized expected uses commitment cadence helper',perf.includes('annualized(expected,c.cadence,c.custom_interval_days)')],
 ['annualized latest run rate uses same cadence basis',perf.includes('annualized(latestActual,c.cadence,c.custom_interval_days)')],
 ['two consecutive over-expected periods escalate high review',perf.includes('if(consecutiveOver>=2)')&&perf.includes("severity='high'")],
 ['multiple non-consecutive over-expected periods become medium review',perf.includes('else if(over>=2)')&&perf.includes("severity='medium'")],
 ['10 percent latest-vs-prior bill drift becomes review signal',perf.includes('periodDriftPct>=10')],
 ['20 percent latest-period overrun escalates high review',perf.includes('latestVariancePct>=20')&&perf.includes("severity='high'")],
 ['renewal within 90 days plus overspend escalates review',perf.includes('renewalDays<=90')&&perf.includes("(consecutiveOver>0||totalVariance>0.01)")],
 ['commitments without invoice history are labeled watch not fabricated as overspend',perf.includes("if(count===0){severity='watch'")],
 ['performance exposes transparent human-readable reasons',perf.includes('reasons.push')],
 ['performance exposes cumulative expected and actual',perf.includes('cumulative_expected')&&perf.includes('cumulative_linked_actual')],
 ['performance exposes cumulative variance',perf.includes('cumulative_variance')],
 ['performance exposes expected annualized active spend',perf.includes('annualized_expected_active')],
 ['performance exposes latest annualized run rate',perf.includes('annualized_latest_run_rate')],
 ['performance exposes renewals requiring review within 90 days',perf.includes('renewal_review_within_90_days')],
 ['performance sorts highest review first',perf.includes("const rank={high:3,medium:2,watch:1,normal:0}")],
 ['performance route is diagnostic and read only',perf.includes('Diagnostic commitment performance only.')&&!perf.includes('INSERT INTO')&&!perf.includes('UPDATE ')&&!perf.includes('DELETE FROM')],
 ['performance basis states it cannot amend contracts or financial records',perf.includes('do not amend contracts, invoices, AP, payments, allocations, or accounting entries')],
 ['UI exposes commitment Performance action',ui.includes('tt-operating-commitment-performance')&&ui.includes('Performance')],
 ['UI fetches branch-scoped commitment performance',ui.includes("rootApi('/operating-commitments/performance'+q)")],
 ['UI shows active commitments and high-review count',ui.includes("kpi('Active commitments'")&&ui.includes("kpi('High review'")],
 ['UI shows cumulative variance and expected annualized spend',ui.includes("kpi('Cumulative variance'")&&ui.includes("kpi('Annualized expected'")],
 ['UI shows latest annualized run rate and renewal count',ui.includes("kpi('Latest run rate'")&&ui.includes("kpi('Renewals ≤90d'")],
 ['UI shows expected versus latest actual spend',ui.includes('<th>Expected</th>')&&ui.includes('<th>Latest actual</th>')],
 ['UI shows total variance and period drift',ui.includes('<th>Total variance</th>')&&ui.includes('<th>Period drift</th>')],
 ['UI shows reasons for review',ui.includes('<th>Why review</th>')&&ui.includes("(x.reasons||[]).join('; ')")],
 ['performance UI shows diagnostic basis',ui.includes('<strong>Performance basis:</strong>')],
 ['performance UI contains no POST or financial mutation action',!ui.substring(ui.indexOf('async function showOperatingCommitmentPerformance'),ui.indexOf('async function linkOperatingCommitmentInvoice')).includes("method:'POST'")]
];
let failed=0;
for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Operating commitment performance: ${name}`);if(!ok)failed++;}
if(failed){console.error(`Operating commitment performance contract FAILED (${failed}/${checks.length} failed).`);process.exit(1);}
console.log(`Operating commitment performance contract OK (${checks.length} checks).`);
