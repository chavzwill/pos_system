'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const route=read('routes/operating-commitments.js');
const ui=read('public/supplier-ledger.js');
new vm.Script(route,{filename:'operating-commitments.js'});
new vm.Script(ui,{filename:'supplier-ledger-ui.js'});
const recStart=route.indexOf("router.get('/:id/reconciliation'");
const recEnd=route.indexOf("router.patch('/:id/status'",recStart);
const reconciliation=route.slice(recStart,recEnd);
const linkStart=route.indexOf("router.post('/:id/invoice-links'");
const linkEnd=recStart;
const linking=route.slice(linkStart,linkEnd);
const checks=[
 ['invoice-link evidence table is durable',route.includes('CREATE TABLE IF NOT EXISTS operating_commitment_invoice_links')],
 ['invoice link references commitment and supplier invoice',route.includes('commitment_id INTEGER NOT NULL REFERENCES operating_commitments(id)')&&route.includes('supplier_invoice_id INTEGER NOT NULL REFERENCES supplier_invoices(id)')],
 ['invoice link preserves service period and linked amount',route.includes('service_period DATE NOT NULL')&&route.includes('linked_amount REAL NOT NULL')],
 ['same invoice/commitment/service period cannot be duplicated',route.includes('UNIQUE(commitment_id,supplier_invoice_id,service_period)')],
 ['invoice link records authenticated employee',route.includes('linked_by_employee_id INTEGER REFERENCES employees(id)')&&linking.includes('actor(req)')],
 ['link endpoint uses write transaction',linking.includes("const tx=await db.transaction('write');let committed=false")],
 ['link requires supplier invoice and service period',linking.includes('Supplier invoice and service period date are required')],
 ['link amount must be positive',linking.includes('Linked invoice amount must be greater than zero')],
 ['link requires existing commitment',linking.includes('Operating commitment not found')],
 ['cancelled commitment rejects new invoice links',linking.includes('Cancelled operating commitment cannot receive new invoice links')],
 ['link requires non-void supplier invoice',linking.includes("SELECT * FROM supplier_invoices WHERE id=? AND status!='void'")],
 ['linked invoice must match commitment supplier when supplier is known',linking.includes('Supplier invoice must belong to the operating commitment supplier')],
 ['linked invoice must match commitment branch when branch is known',linking.includes('Supplier invoice branch must match the operating commitment branch')],
 ['service period cannot precede commitment start',linking.includes('Service period cannot be before commitment start date')],
 ['service period cannot exceed commitment end',linking.includes('Service period cannot be after commitment end date')],
 ['sum of commitment links cannot exceed supplier invoice total',linking.includes('Commitment links cannot exceed the supplier invoice total')],
 ['link insert writes evidence only',linking.includes('INSERT INTO operating_commitment_invoice_links')&&!linking.includes('INSERT INTO supplier_invoices')&&!linking.includes('INSERT INTO supplier_payments')],
 ['link increments commitment source version',linking.includes('const nextVersion=Number(commitment.source_version||1)+1')],
 ['link emits SpendOS evidence event',linking.includes("'operating.commitment.invoice_linked'")&&linking.includes('enqueueSpendEvent')],
 ['SpendOS link event carries invoice ID number period and amount',linking.includes('supplierInvoiceId:String(invoiceId)')&&linking.includes('invoiceNumber:invoice.invoice_number')&&linking.includes('servicePeriod,linkedAmount')],
 ['link transaction commits atomically',linking.includes('await tx.commit();committed=true')],
 ['link failure rolls back',linking.includes("if(!committed)try{await tx.rollback();}catch{}")],
 ['duplicate link returns conflict',linking.includes('already linked to the commitment for that service period')],
 ['reconciliation endpoint is read only',reconciliation.includes("router.get('/:id/reconciliation'")&&!reconciliation.includes('INSERT INTO')&&!reconciliation.includes('UPDATE ')&&!reconciliation.includes('DELETE FROM')],
 ['reconciliation reads exact linked supplier invoices',reconciliation.includes('FROM operating_commitment_invoice_links l')&&reconciliation.includes('JOIN supplier_invoices si ON si.id=l.supplier_invoice_id')],
 ['reconciliation groups evidence by service period',reconciliation.includes('const periods=new Map()')&&reconciliation.includes('service_period:x.service_period')],
 ['period expected amount comes from commitment evidence',reconciliation.includes('expected_amount:money(commitment.expected_amount)')],
 ['period actual is sum of linked invoice amounts',reconciliation.includes('actual_linked_amount=money(p.actual_linked_amount+Number(x.linked_amount||0))')],
 ['variance is actual linked less expected',reconciliation.includes('const variance=money(p.actual_linked_amount-p.expected_amount)')],
 ['variance percent is derived from expected amount',reconciliation.includes('variance/p.expected_amount')],
 ['reconciliation distinguishes on target over and under expected',reconciliation.includes("'on_target':variance>0?'over_expected':'under_expected'")],
 ['reconciliation summary counts variance states',reconciliation.includes('over_expected:reconciled.filter')&&reconciliation.includes('under_expected:reconciled.filter')&&reconciliation.includes('on_target:reconciled.filter')],
 ['reconciliation states it cannot mutate invoice/AP/payment/accounting',reconciliation.includes('does not alter the supplier invoice, AP, payment, or accounting records')],
 ['attention joins current due-period invoice evidence',route.includes('current_period_linked_amount')&&route.includes('l.service_period=oc.next_due_date')],
 ['past due attention requires missing invoice evidence',route.includes("type:'missing_invoice_evidence'")&&route.includes('linkedForPeriod<=0.009')],
 ['upcoming due is suppressed when invoice evidence already exists',route.includes("type:'upcoming_due'")&&route.includes('linkedForPeriod<=0.009')],
 ['linked current period amount variance becomes attention',route.includes("type:'invoice_amount_variance'")&&route.includes('periodVariance')],
 ['large current-period variance escalates priority',route.includes("priority:pct>=0.2?'high':'medium'")],
 ['UI exposes Match invoice action',ui.includes('data-commit-link')&&ui.includes('Match invoice')],
 ['UI exposes Reconcile action',ui.includes('data-commit-reconcile')&&ui.includes('Reconcile')],
 ['UI suggests same supplier/branch open invoices',ui.includes("state.invoices||[]")&&ui.includes('commitment.supplier_id')&&ui.includes('commitment.branch_id')],
 ['UI captures service period linked amount and optional evidence note',ui.includes('Service period date (YYYY-MM-DD)')&&ui.includes('Amount of this supplier invoice that belongs to the commitment period')&&ui.includes('Link note / evidence reference')],
 ['UI posts only commitment invoice-link evidence from match action',ui.includes("rootApi('/operating-commitments/'+commitment.id+'/invoice-links',{method:'POST'")],
 ['UI reconciliation displays expected linked variance and status',ui.includes("money(x.expected_amount)")&&ui.includes("money(x.actual_linked_amount)")&&ui.includes("money(x.variance)")&&ui.includes("String(x.status||'').replaceAll('_',' ')")],
 ['UI reconciliation surfaces total variance',ui.includes('Total variance: ')],
 ['match/reconcile UI does not create supplier payments',!ui.substring(ui.indexOf('async function linkOperatingCommitmentInvoice'),ui.indexOf('function showOperatingCommitmentForm')).includes("api('/payments'")]
];
let failed=0;
for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Operating commitment reconciliation: ${name}`);if(!ok)failed++;}
if(failed){console.error(`Operating commitment reconciliation contract FAILED (${failed}/${checks.length} failed).`);process.exit(1);}
console.log(`Operating commitment reconciliation contract OK (${checks.length} checks).`);
