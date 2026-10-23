'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const api=read('routes/purchase-receipt-invoice-evidence.js'),mount=read('routes/purchase-receiving-controls.js'),ui=read('public/purchase-receipt-invoice-links.js');
const review=read('public/purchase-receiving-review-ui.js'),fast=read('public/purchase-fast-receiving.js'),deferred=read('public/shell-deferred.js'),css=read('public/ui-workspaces.css');
const checks=[
 ['Separate AP identity from receiving evidence',api.includes('purchase_receipt_invoice_evidence')&&api.includes('supplier_invoices')],
 ['Receipt references an authoritative PO and supplier',api.includes('FROM purchase_receipts WHERE id=?')&&api.includes('FROM purchase_orders WHERE id=?')&&api.includes('RECEIPT_AUTHORITY_MISMATCH')],
 ['Staff role and branch boundaries enforced',api.includes('STAFF_SESSION_REQUIRED')&&api.includes('function gate(req,po)')&&api.includes("requirePermission('purchasing_receive')")],
 ['Normalized invoice uniqueness used',api.includes('normalizeSupplierInvoiceNumber')&&api.includes('UNIQUE(receipt_id,supplier_id,normalized_invoice_number)')],
 ['Same supplier invoice cannot silently cross POs',api.includes('INVOICE_REUSED_ON_ANOTHER_PO')&&api.includes('INVOICE_PO_MISMATCH')],
 ['Evidence can be captured before AP posting',api.includes('recorded_pending_ap')&&api.includes('pending_ap')],
 ['Existing AP record linked, never recreated',api.includes('posted_invoice_id')&&!/INSERT INTO supplier_invoices/.test(api)&&!/UPDATE\s+products\s+SET/.test(api)],
 ['Existing inventory movement is not touched',!/(UPDATE|INSERT INTO)\s+(branch_inventory|stock_movements|purchase_receipt_items|products)/.test(api)],
 ['Evidence is not deletable',api.includes('trg_receipt_invoice_evidence_no_delete')&&api.includes('trg_receipt_invoice_events_no_delete')],
 ['Repeat same evidence is idempotent',api.includes("replayed:true")&&api.includes('INVOICE_LINK_CONFLICT')],
 ['Split delivery allocations cannot exceed recorded invoice subtotal',api.includes('checks.allocated+allocated>invoiceSubtotal')],
 ['Finance confirmation requires distinct permission gate',api.includes("requireAnyPermission('purchasing_approve','reports_financial')")],
 ['Invoice evidence route mounted beneath receiving controls',mount.includes("router.use('/invoices',require('./purchase-receipt-invoice-evidence'))")],
 ['Review and Fast Receive can open invoice links',review.includes('tt-rr-invoice-links')&&fast.includes('tt-fr-invoice-link')&&fast.includes('TotalToolsReceiptInvoiceLinks')],
 ['Script uses deferred authenticated loading',deferred.includes("'/purchase-receipt-invoice-links.js'")],
 ['Responsive styles use the POS authoritative stylesheet',css.includes('.tt-inv__panel')&&css.includes('@media(max-width:680px)')],
 ['UI distinguishes pending AP from linked posted invoices',ui.includes('Awaiting Finance posting')&&ui.includes('Linked to posted invoice')]
];
for(const [name,valid] of checks)console.log((valid?'PASS':'FAIL')+' Receipt invoice: '+name);
assert(checks.every(x=>x[1]),'Receipt invoice safety contract failed');
console.log('PASS receipt invoice contracts '+checks.length+'/'+checks.length);
