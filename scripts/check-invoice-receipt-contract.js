'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const router=read('routes/purchase-receipt-invoice-links.js');
const mounted=read('routes/purchase-receiving-controls.js');
const ui=read('public/purchase-invoice-receipt-ui.js');
const deferred=read('public/shell-deferred.js');
const css=read('public/ui-workspaces.css');
const page=read('public/app-shell.html');
const gates=[
 ['Matches existing supplier AP invoice IDs and real receipt items',router.includes('supplier_invoices')&&router.includes('purchase_receipt_items')&&router.includes('purchase_receipts')],
 ['Every invoice receipt link carries a PO and immutable entry',router.includes('supplier_invoice_receipt_allocations')&&router.includes('trg_invoice_receipt_allocation_no_update')&&router.includes('trg_invoice_receipt_allocation_no_delete')],
 ['Supplier, PO and branch must agree',router.includes('SUPPLIER_MISMATCH')&&router.includes('PO_MISMATCH')&&router.includes('BRANCH_MISMATCH')],
 ['Unaccepted, cross-PO and overbilled quantity are refused',router.includes('INVALID_RECEIPT')&&router.includes('RECEIPT_ALREADY_BILLED')&&router.includes('receipt.quantity_received')],
 ['Link mutation requires an idempotency key and transactional write',router.includes("headers['idempotency-key']")&&router.includes("db.transaction('write')")&&router.includes('IDEMPOTENCY_CONFLICT')],
 ['Paid invoice cannot be changed without separate correction',router.includes('PAID_INVOICE_LOCKED')&&router.includes('supplier_payment_allocations')],
 ['Existing payment match control must be present and updated',router.includes('supplier_invoice_match_controls')&&router.includes("status==='matched'")&&router.includes('receipt_amount_variance')],
 ['Unit costs, invoice subtotal and delivered amounts are reconciled',router.includes('invoice_line_cents')&&router.includes('receipt_unit_cost_variance')&&router.includes('expected=cash(invoice.subtotal)')],
 ['Never writes inventory, retail prices or supplier payable amount',!router.includes('UPDATE products SET')&&!router.includes('UPDATE branch_inventory')&&!router.includes('UPDATE supplier_invoices SET subtotal')&&!router.includes('INSERT INTO supplier_invoices')],
 ['Permissions and branch boundary protect matching',router.includes("requireAnyPermission('purchasing_receive','reports_financial')")&&router.includes('assertBranch(req,po)')],
 ['UI distinguishes captured documents from posted AP invoices',ui.includes('Captured — not posted')&&ui.includes('Posted to AP')&&ui.includes('captured_invoice_id')&&ui.includes('receipt_item_id')&&ui.includes('invoice_unit_cost')],
 ['Review UI exposes a link action',ui.includes('tt-ir-launch')&&ui.includes('Link supplier invoice')],
 ['Invoice records are explicitly not mistaken for uploaded PDFs',ui.includes('private, durable storage')],
 ['New script loads through the authenticated deferred shell',deferred.includes("'/purchase-invoice-receipt-ui.js'")],
 ['UI CSS is integrated in authoritative sheet with phone breakpoint',css.includes('.tt-ir__panel')&&css.includes('@media(max-width:680px)')],
 ['Shell deferred script cache key is coordinated',(()=>{const v=deferred.match(/const VERSION='([^']+)'/);return !!v&&page.includes('/shell-deferred.js?v='+v[1])})()],
 ['Route is reachable under PO receiving controls',mounted.includes("router.use('/invoice-receipts',require('./purchase-receipt-invoice-links'))")]
];
let fail=0;for(const [description,ok] of gates){console.log((ok?'PASS':'FAIL')+' Invoice-receipt: '+description);if(!ok)fail++;}
assert.equal(fail,0,fail+' invoice matching contract(s) failed');
console.log('PASS supplier invoice receipt linking contracts: '+gates.length+'/'+gates.length);
