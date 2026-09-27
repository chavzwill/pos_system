'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const route=read('routes/supplier-ledger.js');
const ui=read('public/supplier-ledger.js');
new vm.Script(route,{filename:'supplier-ledger.js'});
new vm.Script(ui,{filename:'supplier-ledger-ui.js'});
const start=route.indexOf("router.get('/cash-forecast'");
const end=route.indexOf("router.get('/payment-timing'",start);
const cash=route.slice(start,end);
const checks=[
 ['cash forecast requires financial permission',route.includes("router.get('/cash-forecast', requirePermission('reports_financial')")],
 ['cash forecast horizon is bounded',cash.includes('Math.min(Math.max(Number(req.query.horizon_days)||30,1),90)')],
 ['cash forecast supports branch scope',cash.includes("if(branchId){invoiceBranch=' AND si.branch_id=?'")],
 ['cash forecast uses only open non-void AP',cash.includes("si.status!='void'")&&cash.includes('MAX(0,si.total-COALESCE(a.paid,0))>0.001')],
 ['cash forecast invoice balance subtracts cash payments and recoverable offsets',cash.includes('supplier_payment_allocations')&&cash.includes('supplier_recoverable_ap_allocations')],
 ['eligible forecast offsets require recognized accounting basis',cash.includes('JOIN supplier_recoverable_accounting_basis b ON b.claim_id=c.id')],
 ['eligible forecast offsets exclude matched unsettled credit reservations',cash.includes('c.confirmed_amount-c.recovered_amount-COALESCE(r.reserved,0)')],
 ['branch forecast includes branch or global recoverables',cash.includes("recoverableBranch=' AND (c.branch_id=? OR c.branch_id IS NULL)'")],
 ['branch forecast includes branch or global credit notes',cash.includes("creditBranch=' AND (n.branch_id=? OR n.branch_id IS NULL)'")],
 ['forecast formal credits are kept separate from cash reduction',cash.includes('unmatched_formal_credit_notes:unmatchedCredit')],
 ['unmatched credit notes do not reduce minimum cash',cash.includes('minimum_cash_total:money(Math.max(0,openAp-(offsetReady-offsetLeft)))')],
 ['forecast does not use identified unconfirmed claims',!cash.includes("status='identified'")],
 ['recoverables are planned against earliest supplier obligations first',cash.includes("ORDER BY si.supplier_id,CASE WHEN si.due_date IS NULL THEN 1 ELSE 0 END,si.due_date,si.invoice_date,si.id")],
 ['planned recoverable offset cannot exceed invoice or offset pool',cash.includes('Math.min(balance,offsetLeft)')],
 ['forecast derives remaining cash after planned offset per invoice',cash.includes('const cashRemaining=money(balance-offset)')],
 ['forecast computes cash due within 7 days',cash.includes('if(dueIn<=7)due7=money(due7+cashRemaining)')],
 ['forecast computes cash due within 14 days',cash.includes('if(dueIn<=14)due14=money(due14+cashRemaining)')],
 ['forecast computes cash due within 30 days',cash.includes('if(dueIn<=30)due30=money(due30+cashRemaining)')],
 ['forecast computes configurable horizon cash',cash.includes('if(dueIn<=horizon)dueHorizon=money(dueHorizon+cashRemaining)')],
 ['forecast separately identifies overdue cash',cash.includes('if(dueIn<0)overdue=money(overdue+cashRemaining)')],
 ['forecast actionable discounts require explicit unexpired terms and unpaid invoice',cash.includes('discount>0&&discountIn!==null&&discountIn>=0&&paid<=0.009')],
 ['forecast discount benefit cannot exceed remaining planned cash',cash.includes('Math.min(discount,cashRemaining)')],
 ['late-fee exposure only remains when cash balance remains',cash.includes('cashRemaining>0.009&&lateFee>0')],
 ['late-fee exposure uses documented effective date within horizon',cash.includes('lateFeeIn!==null&&lateFeeIn<=horizon')],
 ['forecast summary includes minimum total cash',cash.includes("minimum_cash_total:sum('minimum_cash_total')")],
 ['forecast summary includes recoverable offsets',cash.includes("offset_ready_recoverables:sum('planned_recoverable_offsets')")],
 ['forecast summary includes unmatched formal credits separately',cash.includes("unmatched_formal_credit_notes:sum('unmatched_formal_credit_notes')")],
 ['forecast summary includes discount opportunities',cash.includes("actionable_discount_total:sum('actionable_discount_total')")],
 ['forecast summary includes late-fee exposure',cash.includes("stated_late_fee_exposure_within_horizon:sum('stated_late_fee_exposure_within_horizon')")],
 ['forecast clearly states read-only planning basis',cash.includes('Read-only cash forecast.')&&cash.includes('do not reduce forecast cash')],
 ['forecast route contains no financial mutations',!cash.includes('INSERT INTO')&&!cash.includes('UPDATE ')&&!cash.includes('DELETE FROM')],
 ['supplier ledger cold-start initializes credit-note schema',route.includes('supplierCreditNotes.ensureSchema')],
 ['UI exposes Cash forecast from supplier ledger toolbar',ui.includes('tt-supplier-ledger-forecast')&&ui.includes('Cash forecast')],
 ['UI fetches portfolio cash forecast',ui.includes("api('/cash-forecast?horizon_days=30'+branch)")],
 ['UI shows open AP offsets minimum cash and 7/14/30-day needs',ui.includes("kpi('Open AP'")&&ui.includes("kpi('Offsets available'")&&ui.includes("kpi('Minimum cash'")&&ui.includes("kpi('Due in 7 days'")&&ui.includes("kpi('Due in 14 days'")&&ui.includes("kpi('Due in 30 days'")],
 ['UI shows overdue and discount opportunity',ui.includes("kpi('Overdue'")&&ui.includes("kpi('Discounts available'")],
 ['UI shows supplier-level planned offsets and unmatched credits separately',ui.includes('<th>Planned offsets</th>')&&ui.includes('<th>Unmatched credits</th>')],
 ['UI presents forecast basis to finance',ui.includes('<strong>Forecast basis:</strong>')],
 ['forecast UI is read-only with no posting action',!ui.substring(ui.indexOf('async function showCashForecast'),ui.indexOf('function postInvoice')).includes("method:'POST'")]
];
let failed=0;
for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Supplier cash forecast: ${name}`);if(!ok)failed++;}
if(failed){console.error(`Supplier cash forecast contract FAILED (${failed}/${checks.length} failed).`);process.exit(1);}
console.log(`Supplier cash forecast contract OK (${checks.length} checks).`);
