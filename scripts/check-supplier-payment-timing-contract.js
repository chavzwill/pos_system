'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const route=read('routes/supplier-ledger.js');
const ui=read('public/supplier-ledger.js');
new vm.Script(route,{filename:'supplier-ledger.js'});
new vm.Script(ui,{filename:'supplier-ledger-ui.js'});
const timingStart=route.indexOf("router.get('/payment-timing'");
const timingEnd=route.indexOf("router.post('/invoices'",timingStart);
const timing=route.slice(timingStart,timingEnd);
const checks=[
 ['supplier invoices persist payment-term evidence reference',route.includes("ensureColumn('supplier_invoices','payment_terms_reference','TEXT')")],
 ['supplier invoices persist explicit discount deadline and amount',route.includes("ensureColumn('supplier_invoices','discount_deadline','DATE')")&&route.includes("ensureColumn('supplier_invoices','discount_amount','REAL NOT NULL DEFAULT 0')")],
 ['supplier invoices persist explicit late-fee effective date and amount',route.includes("ensureColumn('supplier_invoices','late_fee_effective_date','DATE')")&&route.includes("ensureColumn('supplier_invoices','late_fee_amount','REAL NOT NULL DEFAULT 0')")],
 ['negative term amounts are rejected',route.includes('payment-term amounts must be non-negative numbers')],
 ['discount amount requires documented deadline',route.includes('A documented discount deadline is required when an early-payment discount amount is recorded')],
 ['late-fee amount requires documented effective date',route.includes('A documented late-fee effective date is required when a late-fee amount is recorded')],
 ['discount or late-fee amount requires supplier terms reference',route.includes('Supplier payment-term reference is required for documented discount or late-fee amounts')],
 ['discount deadline cannot precede invoice date',route.includes('Discount deadline cannot be before supplier invoice date')],
 ['late-fee effective date cannot precede invoice date',route.includes('Late-fee effective date cannot be before supplier invoice date')],
 ['discount amount cannot exceed supplier invoice total',route.includes('Documented early-payment discount cannot exceed supplier invoice total')],
 ['invoice insert preserves all timing evidence fields',route.includes('payment_terms_reference,discount_deadline,discount_amount,late_fee_effective_date,late_fee_amount')],
 ['payment timing endpoint requires financial permission',route.includes("router.get('/payment-timing', requirePermission('reports_financial')")],
 ['timing endpoint uses only open non-void AP invoices',timing.includes("si.status!='void'")&&timing.includes('MAX(0,si.total-COALESCE(a.paid,0))>0.001')],
 ['timing endpoint respects supplier filter',timing.includes("if(supplierId){where+=' AND si.supplier_id=?'")],
 ['timing endpoint respects branch filter',timing.includes("if(branchId){where+=' AND si.branch_id=?'")],
 ['timing endpoint includes prior payments and AP offsets in balance',timing.includes('supplier_payment_allocations')&&timing.includes('supplier_recoverable_ap_allocations')],
 ['actionable discount requires explicit amount deadline and unpaid invoice',timing.includes('discount>0&&x.discount_deadline')&&timing.includes('paid<=0.009')],
 ['partial-payment discount terms require verification instead of assumption',timing.includes('partialDiscountNeedsVerification')&&timing.includes('paid>0.009')],
 ['expired discounts are not counted as actionable',timing.includes('discountIn>=0')],
 ['late fee is exposed as risk not posted liability',timing.includes('stated_late_fee_exposure')&&timing.includes('late_fee_amount')],
 ['timing endpoint identifies not-yet-due AP',timing.includes('not_yet_due_ap')&&timing.includes('dueIn>0')],
 ['timing endpoint identifies overdue AP',timing.includes('overdue_ap')&&timing.includes('dueIn<0')],
 ['timing endpoint states documented-terms basis',timing.includes('Timing guidance uses only explicit supplier invoice terms.')],
 ['timing endpoint contains no financial mutations',!timing.includes('INSERT INTO')&&!timing.includes('UPDATE ')&&!timing.includes('DELETE FROM')],
 ['posting UI captures supplier terms reference',ui.includes('Payment terms / supplier reference')],
 ['posting UI captures documented discount evidence',ui.includes('Early-payment discount deadline')&&ui.includes('Documented discount amount')],
 ['posting UI captures documented late-fee evidence',ui.includes('Late-fee effective date')&&ui.includes('Documented late-fee amount')],
 ['payment preflight fetches timing guidance before payment operation',ui.indexOf("api('/payment-timing'+suffix)")<ui.indexOf('paymentOperationFor(d)')],
 ['payment preflight displays documented discount opportunity',ui.includes('Documented discounts available:')&&ui.includes('Discount opportunities:')],
 ['payment preflight displays stated late-fee exposure',ui.includes('Stated late-fee exposure:')],
 ['payment preflight displays not-yet-due and overdue AP',ui.includes('AP not yet due:')&&ui.includes('Overdue AP:')],
 ['payment preflight warns partial discounts require supplier verification',ui.includes('partially paid invoices have discount terms that require supplier verification')],
 ['UI explicitly states timing guidance posts nothing',ui.includes('does not post discounts or late fees.')],
 ['timing guidance does not weaken recoverable offset execution',ui.indexOf("api('/payment-timing'+suffix)")<ui.indexOf("api('/payments/net-plan/apply'")],
 ['timing guidance does not weaken independent supplier-credit override',ui.includes('Independent finance/supervisor PIN')&&ui.includes('supplier_credit_override_reason')]
];
let failed=0;
for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Supplier payment timing: ${name}`);if(!ok)failed++;}
if(failed){console.error(`Supplier payment timing contract FAILED (${failed}/${checks.length} failed).`);process.exit(1);}
console.log(`Supplier payment timing contract OK (${checks.length} checks).`);
