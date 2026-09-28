'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const route=read('routes/supplier-ledger.js');
const ui=read('public/supplier-ledger.js');
new vm.Script(route,{filename:'supplier-ledger.js'});
new vm.Script(ui,{filename:'supplier-ledger-ui.js'});
const snapStart=route.indexOf("async function buildForecastSnapshot");
const snapEnd=route.indexOf("router.get('/cash-forecast'",snapStart);
const perfStart=route.indexOf("router.get('/cash-performance/");
const perfEnd=route.indexOf("router.get('/cash-forecast'",perfStart);
const snap=route.slice(snapStart,snapEnd),perf=route.slice(perfStart,perfEnd);
const checks=[
 ['forecast snapshot header is durable',route.includes('CREATE TABLE IF NOT EXISTS supplier_cash_forecast_snapshots')],
 ['forecast snapshot lines are durable',route.includes('CREATE TABLE IF NOT EXISTS supplier_cash_forecast_snapshot_lines')],
 ['snapshot lines are unique per invoice per baseline',route.includes('UNIQUE(snapshot_id,supplier_invoice_id)')],
 ['snapshot preserves branch horizon and summary evidence',route.includes('branch_id INTEGER REFERENCES branches(id)')&&route.includes('horizon_days INTEGER NOT NULL')&&route.includes("summary_json TEXT NOT NULL DEFAULT '{}'")],
 ['snapshot lines preserve planned cash and recoverable offsets',route.includes('planned_recoverable_offset REAL NOT NULL DEFAULT 0')&&route.includes('planned_cash REAL NOT NULL DEFAULT 0')],
 ['snapshot lines preserve timing opportunity evidence',route.includes('discount_deadline DATE')&&route.includes('discount_amount REAL NOT NULL DEFAULT 0')&&route.includes('late_fee_effective_date DATE')],
 ['snapshot builder uses open non-void invoices only',snap.includes("si.status!='void'")&&snap.includes('MAX(0,si.total-COALESCE(a.paid,0))>0.001')],
 ['snapshot invoice balance includes prior payments and AP offsets',snap.includes('supplier_payment_allocations')&&snap.includes('supplier_recoverable_ap_allocations')],
 ['snapshot eligible offsets require accounting basis',snap.includes('JOIN supplier_recoverable_accounting_basis b ON b.claim_id=c.id')],
 ['snapshot excludes matched unsettled credit reservations',snap.includes('c.confirmed_amount-c.recovered_amount-COALESCE(r.reserved,0)')],
 ['snapshot supports branch-scoped invoices',snap.includes("invoiceBranch=' AND si.branch_id=?'")],
 ['snapshot supports branch/global recoverables',snap.includes("recoverableBranch=' AND (c.branch_id=? OR c.branch_id IS NULL)'")],
 ['snapshot applies recoverables to earliest obligations',snap.includes("ORDER BY si.supplier_id,CASE WHEN si.due_date IS NULL THEN 1 ELSE 0 END,si.due_date,si.invoice_date,si.id")],
 ['snapshot offset never exceeds invoice or available recoverable',snap.includes('Math.min(balance,available)')],
 ['snapshot planned cash is balance less planned offset',snap.includes('const cash=money(balance-offset)')],
 ['snapshot discount signal requires explicit unexpired terms and unpaid invoice',snap.includes('discount>0&&discountIn!==null&&discountIn>=0&&paid<=0.009')],
 ['snapshot save requires financial permission',route.includes("router.post('/cash-forecast/snapshots', requirePermission('reports_financial')")],
 ['snapshot save is atomic',route.includes("const tx=await db.transaction('write');let committed=false")&&snap.includes('await tx.commit();committed=true')],
 ['snapshot save only writes forecast evidence tables',!snap.includes('INSERT INTO supplier_payments')&&!snap.includes('INSERT INTO supplier_recoverable_settlements')&&!snap.includes('UPDATE supplier_invoices')],
 ['snapshot listing requires financial permission',route.includes("router.get('/cash-forecast/snapshots', requirePermission('reports_financial')")],
 ['performance endpoint requires financial permission',route.includes("router.get('/cash-performance/:snapshotId', requirePermission('reports_financial')")],
 ['performance uses frozen snapshot lines rather than current plan',perf.includes('supplier_cash_forecast_snapshot_lines')],
 ['actual cash is constrained to post-snapshot activity and horizon date',perf.includes('datetime(p.created_at)>=datetime(?)')&&perf.includes('date(p.payment_date)<=date(?)')],
 ['actual offsets are constrained to post-snapshot activity and horizon date',perf.includes('datetime(rs.created_at)>=datetime(?)')&&perf.includes('date(rs.settlement_date)<=date(?)')],
 ['cash variance compares actual against planned cash',perf.includes('cash_variance:money(actualCash-plannedCash)')],
 ['offset variance compares actual against planned offsets',perf.includes('offset_variance:money(actualOffsets-plannedOffsets)')],
 ['early-cash signal requires payment before due date and no documented discount opportunity',perf.includes("String(cash.first_payment_date)<String(x.due_date)&&!Number(x.discount_actionable||0)")],
 ['expired-discount signal requires baseline actionable discount whose deadline passed',perf.includes('discountExpired=Number(x.discount_actionable||0)&&x.discount_deadline')],
 ['expired-discount signal is limited by planned cash/discount evidence',perf.includes('Math.min(Number(x.discount_amount||0),Number(x.planned_cash||0))')],
 ['performance recalculates current invoice balance from authoritative payments and offsets',perf.includes('SELECT MAX(0,si.total-COALESCE(a.paid,0)) balance')&&perf.includes('supplier_payment_allocations')&&perf.includes('supplier_recoverable_ap_allocations')],
 ['overdue carryover requires past due date and current balance',perf.includes("String(nowDate)>String(x.due_date)&&currentBalance>0.009")],
 ['performance basis explicitly labels indicators diagnostic',perf.includes('Diagnostic performance review only.')&&perf.includes('operational signals')],
 ['performance route contains no financial mutations',!perf.includes('INSERT INTO')&&!perf.includes('UPDATE ')&&!perf.includes('DELETE FROM')],
 ['UI exposes Save baseline',ui.includes('tt-supplier-forecast-save')&&ui.includes('Save baseline')],
 ['UI saves baseline server-side',ui.includes("api('/cash-forecast/snapshots',{method:'POST'")],
 ['UI exposes Review latest performance',ui.includes('tt-supplier-forecast-performance')&&ui.includes('Review latest performance')],
 ['UI reads latest saved baseline before performance',ui.includes("api('/cash-forecast/snapshots'+q)")&&ui.includes("api('/cash-performance/'+snaps[0].id)")],
 ['UI displays planned versus actual cash',ui.includes('Planned cash:')&&ui.includes('Actual cash within horizon:')&&ui.includes('Cash variance:')],
 ['UI displays planned versus actual offsets',ui.includes('Planned offsets:')&&ui.includes('Actual offsets:')],
 ['UI labels early cash as potential not definitive waste',ui.includes('Potentially early cash:')],
 ['UI labels expired discount as a signal',ui.includes('Expired discount opportunity signal:')],
 ['UI displays current overdue carryover',ui.includes('Current overdue carryover:')]
];
let failed=0;
for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Supplier cash performance: ${name}`);if(!ok)failed++;}
if(failed){console.error(`Supplier cash performance contract FAILED (${failed}/${checks.length} failed).`);process.exit(1);}
console.log(`Supplier cash performance contract OK (${checks.length} checks).`);
