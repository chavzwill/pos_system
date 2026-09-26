'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const guard=read('routes/supplier-payment-loss-prevention.js');
const ui=read('public/supplier-ledger.js');
new vm.Script(guard,{filename:'supplier-payment-loss-prevention.js'});
new vm.Script(ui,{filename:'supplier-ledger.js'});
const checks=[
 ['net-payment planner is finance permission protected',guard.includes("router.get('/payments/net-plan',requirePermission('reports_financial')")],
 ['planner uses only posted non-void supplier invoices',guard.includes("si.status!='void'")&&guard.includes('balance_due')],
 ['planner subtracts both cash payments and prior recoverable AP offsets from invoice balances',guard.includes('supplier_payment_allocations')&&guard.includes('supplier_recoverable_ap_allocations')],
 ['planner offset pool requires recognized accounting basis',guard.includes('JOIN supplier_recoverable_accounting_basis b ON b.claim_id=c.id')],
 ['planner offset pool is limited to confirmed or partially recovered claims',guard.includes("c.status IN ('confirmed','partially_recovered')")],
 ['planner excludes identified unconfirmed claims from cash reduction',!guard.substring(guard.indexOf('async function supplierNetPaymentPlan'),guard.indexOf("router.get('/payments/net-plan'")).includes("status='identified'")],
 ['unmatched formal credit notes are reported separately',guard.includes('unmatched_formal_credit_notes:unmatchedCredits')],
 ['unmatched credit notes do not reduce minimum cash directly',guard.includes('minimum_cash_after_current_offsets:money(Math.max(0,openAp-proposedOffset))')],
 ['planner does not double count matched credit-note applications as separate cash reduction',!guard.substring(guard.indexOf('async function supplierNetPaymentPlan'),guard.indexOf("router.get('/payments/net-plan'")).includes('supplier_credit_note_applications')],
 ['planner produces exact claim-to-invoice suggested offsets',guard.includes('claim_id:claim.id')&&guard.includes('supplier_invoice_id:inv.id')&&guard.includes('amount:applied')],
 ['planner applies offsets oldest-due invoice first',guard.includes("ORDER BY CASE WHEN si.due_date IS NULL THEN 1 ELSE 0 END,si.due_date,si.invoice_date,si.id")],
 ['planner never allocates more than invoice or claim balance',guard.includes('Math.min(invoiceLeft,claimLeft)')],
 ['planner reports unused eligible recoverables',guard.includes('unused_offset_ready_recoverables')],
 ['branch-specific plan scopes invoices by branch',guard.includes("invoiceBranch=' AND si.branch_id=?'")],
 ['branch-specific plan scopes recoverables to branch or global claims',guard.includes("claimBranch=' AND (c.branch_id=? OR c.branch_id IS NULL)'")],
 ['branch-specific plan scopes credit notes to branch or global documents',guard.includes("creditBranch=' AND (n.branch_id=? OR n.branch_id IS NULL)'")],
 ['planner explicitly states it is read only',guard.includes('Read-only payment plan. It does not post recoverable settlements')],
 ['planner route contains no mutation statement',!guard.substring(guard.indexOf("router.get('/payments/net-plan'"),guard.indexOf("router.get('/payments/credit-position'")).includes('INSERT INTO')],
 ['UI runs net plan before creating idempotent payment operation',ui.indexOf("api('/payments/net-plan'+suffix)")<ui.indexOf('paymentOperationFor(d)')],
 ['UI shows open AP proposed offsets and minimum cash',ui.includes('Open AP:')&&ui.includes('Proposed AP offsets:')&&ui.includes('Minimum cash after current offsets:')],
 ['UI shows unmatched formal credits separately',ui.includes('Unmatched formal credit notes:')],
 ['UI displays suggested claim-to-invoice offsets',ui.includes('Suggested offsets:')&&ui.includes("x.claim_number+' → '+x.invoice_number")],
 ['UI explicitly states plan posts nothing',ui.includes('This is a read-only plan; no credit or payment has been posted.')],
 ['existing authoritative payment guard remains after planner preflight',ui.indexOf('if(position.requires_override)')>ui.indexOf("api('/payments/net-plan'+suffix)")],
 ['planner does not weaken independent override requirement',ui.includes('Independent finance/supervisor PIN')&&ui.includes('supplier_credit_override_reason')]
];
let failed=0;
for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Supplier net payment plan: ${name}`);if(!ok)failed++;}
if(failed){console.error(`Supplier net-payment plan contract FAILED (${failed}/${checks.length} failed).`);process.exit(1);}
console.log(`Supplier net-payment plan contract OK (${checks.length} checks).`);
