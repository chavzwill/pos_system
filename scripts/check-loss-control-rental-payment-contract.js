'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const rentalGuard=read('routes/rental-loss-prevention.js'),rentalLeaks=read('routes/loss-control-rental-payment-leaks.js'),nearLeaks=read('routes/loss-control-supplier-payment-near-duplicates.js'),supplier=read('routes/supplier-payment-loss-prevention.js'),rentals=read('routes/rentals.js'),trace=read('routes/inventory-traceability.js'),server=read('server.js');
for(const [name,src] of [['rental loss prevention',rentalGuard],['rental/payment intelligence',rentalLeaks],['near-duplicate payment intelligence',nearLeaks],['supplier payment prevention',supplier]])new vm.Script(src,{filename:name});
const checks=[
 ['rental financial guard is mounted before authoritative rental route',server.indexOf("require('./routes/rental-loss-prevention')")>=0&&server.indexOf("require('./routes/rental-loss-prevention')")<server.indexOf("require('./routes/rentals')")],
 ['duration adjustment override requires supervisor evidence',rentalGuard.includes('duration_adjustment_override')&&rentalGuard.includes('Supervisor authorization is required for this rental financial override')],
 ['materially backdated returns require authorization',rentalGuard.includes("type:'backdated_return'")&&rentalGuard.includes('minutes_backdated')],
 ['damaged-condition return with zero fee is treated as an explicit waiver',rentalGuard.includes("type:'damage_fee_waiver'")&&rentalGuard.includes("requireAuth('damage_fee_waiver')")&&rentalGuard.includes('damageLike(incomingCondition)')],
 ['rental override PIN and reason are stripped before authoritative return processing',rentalGuard.includes('delete req.body.rental_override_pin')&&rentalGuard.includes('delete req.body.rental_override_reason')],
 ['rental balance collection blocks cash under-tender',rentalGuard.includes('Cash tendered cannot be less than the rental balance due')],
 ['cash rental balance collection requires drawer accountability',rentalGuard.includes('drawer_session_id')&&rentalGuard.includes("status='open'")],
 ['deposit refund is capped by the recorded deposit math',rentals.includes('Math.max(0, agreement.deposit_total - (damageFeeTotal + durationAdjustmentTotal + taxAdjustmentTotal))')],
 ['rental credit note cannot exceed actual refund due',rentals.includes('if (amt > refundDue + 0.01)')],
 ['deep rental/payment intelligence is mounted under loss control',trace.includes("router.use('/loss-control',require('./loss-control-rental-payment-leaks'))")],
 ['pause concentration reviews billing-suppression risk without inventing loss',rentalLeaks.includes("rental_pause_billing_suppression_review")&&rentalLeaks.includes('does not invent a monetary loss')],
 ['condition downgrade review requires returned damaged-condition evidence with zero fee',rentalLeaks.includes("rental_condition_downgrade_without_damage_charge")&&rentalLeaks.includes('COALESCE(rai.damage_fee,0)<=0.01')],
 ['condition downgrade uses inventory cost only as at-risk asset context',rentalLeaks.includes('inventory_value_exposed')&&rentalLeaks.includes('estimated_loss:0')],
 ['supplier same-day same-amount patterns are surfaced across branch context',rentalLeaks.includes("supplier_payment_same_day_same_amount")&&rentalLeaks.includes('branch_names')&&rentalLeaks.includes('duplicate-payment risk')],
 ['supplier payment prevention normalizes duplicate references',supplier.includes("replace(/[^A-Z0-9]/g,'')")&&supplier.includes("triggers.push('duplicate_reference')")],
 ['supplier payment prevention catches same supplier amount and date with different references',supplier.includes("triggers.push('same_supplier_amount_date')")&&supplier.includes('sameDayAmount')],
 ['supplier payment prevention also checks configurable adjacent-date and amount tolerances',supplier.includes('loss_control_supplier_payment_similarity_days')&&supplier.includes('loss_control_supplier_payment_similarity_amount_pct')&&supplier.includes('loss_control_supplier_payment_similarity_amount_abs')&&supplier.includes("triggers.push('near_supplier_amount_date')")],
 ['suspicious supplier payment requires independent approval',supplier.includes('Independent supervisor authorization is required for a suspicious supplier payment')],
 ['supplier similarity override evidence records day and amount differences',supplier.includes('day_difference')&&supplier.includes('amount_difference')&&supplier.includes('supplier_payment_similarity_override_events')],
 ['near-duplicate payment intelligence is mounted under loss control',trace.includes("router.use('/loss-control',require('./loss-control-supplier-payment-near-duplicates'))")],
 ['near-duplicate scanner compares supplier payments across configurable date and amount windows',nearLeaks.includes("signal_type:'supplier_payment_near_duplicate'")&&nearLeaks.includes('loss_control_supplier_payment_similarity_days')&&nearLeaks.includes('amount_tolerance_pct')],
 ['near-duplicate exposure is at-risk rather than automatically declared lost',nearLeaks.includes('estimated_loss:0')&&nearLeaks.includes('at_risk_value:exposure')],
 ['near-duplicate scanner is non-accusatory and read/review only',nearLeaks.includes('not findings of misconduct')&&nearLeaks.includes('No payment, supplier, invoice, bank or accounting record was changed automatically')],
 ['rental/payment scanner performs no autonomous financial mutation',rentalLeaks.includes('No rental, payment, inventory, supplier or disciplinary record was changed automatically')],
 ['rental/payment intelligence requires reports permission',rentalLeaks.includes("router.use(requirePermission('reports'))")&&nearLeaks.includes("router.use(requirePermission('reports'))")]
];
let failed=0;for(const [name,ok]of checks){console.log(`${ok?'PASS':'FAIL'} Rental/payment loss control: ${name}`);if(!ok)failed++;}if(failed){console.error(`Rental/payment loss-control contract FAILED (${failed}/${checks.length} failed).`);process.exit(1)}console.log(`Rental/payment loss-control contract OK (${checks.length} checks).`);
