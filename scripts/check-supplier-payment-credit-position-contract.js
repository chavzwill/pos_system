'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const guard=read('routes/supplier-payment-loss-prevention.js');
const op=read('routes/supplier-payment-operation-guard.js');
const ui=read('public/supplier-ledger.js');
new vm.Script(guard,{filename:'supplier-payment-loss-prevention.js'});
new vm.Script(op,{filename:'supplier-payment-operation-guard.js'});
new vm.Script(ui,{filename:'supplier-ledger.js'});
const checks=[
 ['payment loss-prevention guard remains mounted before supplier ledger',read('server.js').indexOf("require('./routes/supplier-payment-loss-prevention')")<read('server.js').indexOf("require('./routes/supplier-ledger')")],
 ['credit-position preflight requires financial permission',guard.includes("router.get('/payments/credit-position',requirePermission('reports_financial')")],
 ['credit-position initializes recoverables and credit-note schemas',guard.includes('ensureSupplierRecoverablesSchema')&&guard.includes('creditNotes.ensureSchema')],
 ['open AP position includes prior cash payments and recoverable offsets',guard.includes('supplier_payment_allocations')&&guard.includes('supplier_recoverable_ap_allocations')],
 ['offset-ready amount only uses confirmed recoverables with accounting basis',guard.includes('JOIN supplier_recoverable_accounting_basis b ON b.claim_id=c.id')&&guard.includes("c.status IN ('confirmed','partially_recovered')")],
 ['unmatched formal credit-note value is separately measured',guard.includes('MAX(0,n.amount-n.applied_amount)')],
 ['matched but unsettled credit is separately visible',guard.includes('MAX(0,a.amount-a.settled_amount)')],
 ['identified unconfirmed claims remain a separate informational bucket',guard.includes("status='identified'")&&guard.includes('identified_unconfirmed_claims')],
 ['override trigger excludes merely identified claims',guard.includes('position.requires_override=position.offset_ready_recoverables>0.009||position.unmatched_credit_notes>0.009')],
 ['posting-time guard recomputes supplier credit position',guard.includes('const creditPosition=await supplierCreditPosition(supplierId)')],
 ['posting-time override requires independent supervisor',guard.includes('Independent supervisor authorization is required when paying through usable supplier credit.')],
 ['posting-time override requires meaningful reason',guard.includes('A meaningful reason is required to pay a supplier while usable supplier credit remains.')],
 ['posting-time override authority requires finance or security permission',guard.includes("can(p,'reports_financial')||can(p,'security_manage')")],
 ['credit override evidence is durable',guard.includes('CREATE TABLE IF NOT EXISTS supplier_payment_credit_override_events')],
 ['override evidence captures payment amount and supplier position',guard.includes('offset_ready_recoverables')&&guard.includes('unmatched_credit_notes')&&guard.includes('matched_unsettled_credit')&&guard.includes('identified_unconfirmed_claims')],
 ['override evidence is linked one-to-one with supplier payment',guard.includes('payment_id INTEGER NOT NULL UNIQUE REFERENCES supplier_payments(id)')],
 ['override evidence is persisted only after successful payment',guard.includes('res.statusCode>=200&&res.statusCode<300&&payload?.id')],
 ['UI preflights supplier credit before creating payment operation',ui.indexOf("api('/payments/credit-position?supplier_id='")<ui.indexOf('paymentOperationFor(d)')],
 ['UI shows offset-ready and unmatched credit separately',ui.includes('Offset-ready recoverables:')&&ui.includes('Unmatched formal credit notes:')],
 ['UI shows identified claims as context',ui.includes('Identified/unconfirmed claims:')],
 ['UI advises applying supplier credit before cash',ui.includes('Available supplier credit should be applied before sending more cash.')],
 ['UI requires independent finance PIN and reason before payment',ui.includes('Independent finance/supervisor PIN')&&ui.includes('Reason for paying cash instead of applying available supplier credit first')],
 ['browser payment fingerprint excludes override PIN and reason',ui.includes("'supplier_credit_override_pin','supplier_credit_override_reason'")],
 ['backend economic idempotency excludes all override metadata',op.includes("'supplier_credit_override_pin','supplier_credit_override_reason'")&&op.includes("'duplicate_payment_override_pin'")&&op.includes("'payment_similarity_override_pin'")],
 ['economic payment fields remain in idempotency hash',op.includes('crypto.createHash')&&!op.includes("'supplier_id'")],
 ['credit override metadata is removed before authoritative supplier-ledger write',guard.includes('delete req.body.supplier_credit_override_pin;delete req.body.supplier_credit_override_reason')],
 ['existing duplicate/similar payment checks remain active',guard.includes('duplicate_reference')&&guard.includes('same_supplier_amount_date')&&guard.includes('near_supplier_amount_date')],
 ['landed-cost reconciliation still occurs before payment credit review',guard.indexOf('await ensurePaymentLandedCosts(req,supplierId)')<guard.indexOf('const creditPosition=await supplierCreditPosition(supplierId)')]
];
let failed=0;
for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Supplier payment credit position: ${name}`);if(!ok)failed++;}
if(failed){console.error(`Supplier payment credit-position contract FAILED (${failed}/${checks.length} failed).`);process.exit(1);}
console.log(`Supplier payment credit-position contract OK (${checks.length} checks).`);
