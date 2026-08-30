'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const route=read('routes/logistics-commercial-handoff.js'),parent=read('routes/logistics-intelligence.js'),ui=read('public/logistics-commercial-handoff.js'),deferred=read('public/shell-deferred.js');
new vm.Script(route,{filename:'logistics commercial handoff'});new vm.Script(parent,{filename:'logistics intelligence'});new vm.Script(ui,{filename:'logistics commercial handoff ui'});
const checks=[
 ['commercial handoff is mounted inside logistics',parent.includes("router.use(require('./logistics-commercial-handoff'))")],
 ['dispatch source documents preserve immutable commercial snapshots',route.includes('dispatch_source_documents')&&route.includes('snapshot_json')&&route.includes('document_number')],
 ['purchase orders can create supplier pickup jobs',route.includes('/from-purchase-order/:id')&&route.includes("jobType:'supplier_pickup'")],
 ['supplier pickup carries supplier identity contact and address',route.includes('supplier_contact')&&route.includes('supplier_phone')&&route.includes('supplier_email')&&route.includes('supplierAddress')],
 ['supplier pickup requires usable supplier address',route.includes('Supplier pickup cannot be dispatched until the supplier has a usable address')],
 ['supplier pickup destination is the receiving branch',route.includes('destination=branchAddr(po)')&&route.includes('receiving branch')],
 ['draft or cancelled PO cannot silently enter dispatch',route.includes("['sent','approved','partial']")],
 ['PO items are frozen into dispatch evidence',route.includes('purchase_order_items')&&route.includes('snapshot:{purchase_order:')],
 ['completed sales invoices can create customer delivery jobs',route.includes('/from-sales-invoice/:id')&&route.includes("jobType:'customer_delivery'")&&route.includes("String(tx.status)!=='completed'")],
 ['sales delivery carries customer contact and address',route.includes('customer_phone')&&route.includes('customer_email')&&route.includes('customerAddress')],
 ['sales invoice items are frozen into dispatch evidence',route.includes('transaction_items')&&route.includes("document_kind:'sales_invoice'")],
 ['rental delivery and pickup are distinct dispatch jobs',route.includes("jobType:direction==='delivery'?'rental_delivery':'rental_pickup'")],
 ['rental logistics respects configured delivery pickup requirements',route.includes('delivery_required')&&route.includes('pickup_required')],
 ['rental logistics prefers recorded rental delivery address',route.includes("String(ra.delivery_address||'').trim()||addr(ra)")],
 ['rental invoice agreement and customer snapshot travel together',route.includes("document_kind:'rental_invoice'")&&route.includes('agreement_number')&&route.includes('checkout_invoice_number')],
 ['duplicate open commercial dispatch jobs are idempotent',route.includes('async function existing')&&route.includes("status NOT IN ('completed','cancelled')")],
 ['commercial handoff records an auditable dispatch event',route.includes("'commercial_document_handoff'")],
 ['dispatcher can retrieve the exact source document packet',route.includes('/jobs/:id/source-document')],
 ['purchasing UI exposes PO dispatch handoff',ui.includes('Send PO to Dispatch')&&ui.includes('/from-purchase-order/')],
 ['sales UI exposes invoice dispatch handoff',ui.includes('Send invoice to Dispatch')&&ui.includes('/from-sales-invoice/')],
 ['rental UI exposes separate delivery and pickup handoffs',ui.includes('Send rental delivery')&&ui.includes('Send rental pickup')],
 ['dispatch UI surfaces document party contact and address packet',ui.includes('data-dispatch-packet')&&ui.includes('contact_phone')&&ui.includes('address_line')],
 ['dispatch packet exposes view and print document control',ui.includes('View / print document')&&ui.includes('window.print()')&&ui.includes('openDocument(d)')],
 ['printed document is rendered from immutable snapshot line items',ui.includes('d.snapshot?.items')&&ui.includes('Frozen handoff copy captured for logistics execution')],
 ['printed document explains snapshot immutability',ui.includes('does not silently rewrite itself')&&ui.includes('originating PO, invoice or rental record later changes')],
 ['document renderer HTML-escapes commercial source values',ui.includes('const esc=')&&ui.includes('esc(d.party_name)')&&ui.includes('esc(d.document_number)')],
 ['commercial handoff UI is deferred through the application shell',deferred.includes('/logistics-commercial-handoff.js')]
];
let failed=0;for(const [name,ok]of checks){console.log(`${ok?'PASS':'FAIL'} Commercial logistics handoff: ${name}`);if(!ok)failed++;}
if(failed){console.error(`Commercial logistics handoff contract FAILED (${failed}/${checks.length} failed).`);process.exit(1)}
console.log(`Commercial logistics handoff contract OK (${checks.length} checks).`);
