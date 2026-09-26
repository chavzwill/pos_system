'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const guard=read('routes/supplier-payment-loss-prevention.js');
const ui=read('public/supplier-ledger.js');
new vm.Script(guard,{filename:'supplier-payment-loss-prevention.js'});
new vm.Script(ui,{filename:'supplier-ledger.js'});
const checks=[
 ['execution endpoint is finance permission protected',guard.includes("router.post('/payments/net-plan/apply',requirePermission('reports_financial')")],
 ['execution requires stable idempotency key',guard.includes('A stable Idempotency-Key of at least 16 characters is required')],
 ['execution journal is durable and keyed uniquely',guard.includes('CREATE TABLE IF NOT EXISTS supplier_net_payment_executions')&&guard.includes('operation_key TEXT NOT NULL UNIQUE')],
 ['execution replay checks supplier branch and plan hash',guard.includes('Number(prior.supplier_id)===supplierId')&&guard.includes('String(prior.expected_plan_hash)===expectedHash')],
 ['same idempotency key with different economics is rejected',guard.includes('Idempotency key was already used for a different supplier net-payment plan')],
 ['successful retry returns stored result instead of reapplying offsets',guard.includes('return res.json({...result,replayed:true})')],
 ['plan preview has deterministic economic hash',guard.includes("crypto.createHash('sha256')")&&guard.includes('suggested_offsets:(plan.suggested_offsets||[]).map')],
 ['preview returns plan hash to client',guard.includes('plan_hash:netPlanHash(plan)')],
 ['execution recomputes plan inside write transaction',guard.includes('supplierNetPaymentPlan(supplierId,branchId,tx)')],
 ['stale preview is rejected before writes',guard.includes("code:'SUPPLIER_NET_PLAN_STALE'")&&guard.indexOf("code:'SUPPLIER_NET_PLAN_STALE'")<guard.indexOf("INSERT INTO supplier_recoverable_settlements")],
 ['execution refuses empty offset plan',guard.includes('No eligible recoverable offsets remain to apply')],
 ['matched credit-note reservations are excluded from direct offset availability',guard.includes('claim.confirmed_amount||0)-Number(claim.recovered_amount||0)-Number(claim.matched_credit_reserved||0)')],
 ['execution revalidates recoverable supplier',guard.includes("Number(claim.supplier_id)!==supplierId")],
 ['execution revalidates accounting basis',guard.includes('Recoverable accounting basis is no longer available')],
 ['execution revalidates supplier invoice and supplier identity',guard.includes("SELECT * FROM supplier_invoices WHERE id=? AND status!='void'")&&guard.includes("Number(inv.supplier_id)!==supplierId")],
 ['branch-scoped execution revalidates invoice branch',guard.includes('Supplier invoice moved outside the selected branch scope')],
 ['execution recalculates invoice balance from payments plus prior offsets',guard.includes('supplier_payment_allocations WHERE supplier_invoice_id=?')&&guard.includes('supplier_recoverable_ap_allocations WHERE supplier_invoice_id=?')],
 ['execution refuses amount above current invoice balance',guard.includes('Supplier invoice balance changed during net-payment execution')],
 ['execution writes normal supplier recoverable AP-offset settlement',guard.includes("claim.id,'ap_offset',amount,reference,settlementDate")],
 ['execution evidence records plan source operation key hash and invoice',guard.includes("source:'supplier_net_payment_plan'")&&guard.includes('operationKey,planHash:expectedHash,supplierInvoiceId:inv.id')],
 ['execution writes exact supplier recoverable AP allocation',guard.includes('INSERT INTO supplier_recoverable_ap_allocations(settlement_id,claim_id,supplier_invoice_id,amount)')],
 ['execution updates claim recovered balance and lifecycle',guard.includes("claimStatus=newRecovered+0.01>=Number(claim.confirmed_amount||0)?'recovered':'partially_recovered'")],
 ['execution is atomic under one write transaction',guard.includes("const tx=await db.transaction('write');let committed=false")&&guard.includes('await tx.commit();committed=true')],
 ['failed execution rolls back',guard.includes("if(!committed)try{await tx.rollback();}catch{}")],
 ['execution result reports applied amount and remaining cash requirement',guard.includes('applied_amount:appliedAmount')&&guard.includes('minimum_cash_after_execution')],
 ['execution result labels accounting as pending source sync',guard.includes("accounting_status:'pending_source_sync'")],
 ['UI explicitly asks before applying offsets',ui.includes('Apply the proposed recoverable offsets to Accounts Payable now before sending cash?')],
 ['UI uses preview hash and deterministic idempotency key',ui.includes("const netKey='NETPLAN-'")&&ui.includes('plan_hash:plan.plan_hash')],
 ['UI does not silently rewrite cash amount after offsets',ui.includes("window.prompt('Enter the cash/bank amount you still intend to pay after offsets'")],
 ['UI blocks cash above remaining AP after offsets',ui.includes('Cash payment cannot exceed the remaining AP after the offsets you just applied.')],
 ['UI can finish with zero cash after offsets',ui.includes('No cash payment is required after the applied offsets.')],
 ['UI can stop after offsets without creating cash payment',ui.includes('Offsets were applied. No cash payment was recorded.')],
 ['UI refreshes supplier credit position after offset execution',ui.includes("position=await api('/payments/credit-position?supplier_id='")],
 ['authoritative cash payment guard still runs after offset execution',ui.indexOf('if(position.requires_override)')>ui.indexOf("api('/payments/net-plan/apply'")],
 ['direct offset planner excludes matched credit-note reservations',guard.includes('MAX(0,c.confirmed_amount-c.recovered_amount-COALESCE(r.reserved,0)) outstanding_amount')]
];
let failed=0;
for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Supplier net payment execution: ${name}`);if(!ok)failed++;}
if(failed){console.error(`Supplier net-payment execution contract FAILED (${failed}/${checks.length} failed).`);process.exit(1);}
console.log(`Supplier net-payment execution contract OK (${checks.length} checks).`);
