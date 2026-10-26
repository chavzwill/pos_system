'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const read=name=>fs.readFileSync(path.join(__dirname,'..',name),'utf8');
const route=read('routes/purchase-receiving-review.js');
const mount=read('routes/purchase-receiving-controls.js');
const ui=read('public/purchase-receiving-review-ui.js');
const fast=read('public/purchase-fast-receiving.js');
const css=read('public/ui-workspaces.css');
const deferred=read('public/shell-deferred.js');
const cases=[
 ['uses authoritative PO and purchase line IDs',route.includes('purchase_orders')&&route.includes('purchase_order_items')],
 ['existing shortage/overage ledger remains source of truth',route.includes('purchase_receipt_exceptions')&&route.includes("exception_type='shortage'")],
 ['backorder is outstanding quantity less approved closed shortages',route.includes('backorder_qty:Math.max(0')&&route.includes('closed_shortage')],
 ['supplier follow-up history is append-only',route.includes('purchase_backorder_updates')&&route.includes('trg_po_backorders_no_update')],
 ['backorder follow-up never modifies stock, order qty or PO status',!route.includes('UPDATE purchase_order_items')&&!route.includes('UPDATE branch_inventory')&&!route.includes('UPDATE stock_movements')],
 ['pricing only begins after actual received stock',route.includes("'RECEIPT_REQUIRED'")&&route.includes('line.quantity_received')],
 ['retail prices do not change when a proposal is submitted',route.includes('purchase_retail_price_proposals')&&route.indexOf('UPDATE products SET price=')>route.indexOf("router.post('/price-proposals/:id/decision'")],
 ['price decision requires inventory_edit AND purchasing_approve',route.includes("requirePermission('purchasing_approve'),requirePermission('inventory_edit')")],
 ['price approver must be a different staff member',route.includes('SEPARATE_APPROVER_REQUIRED')],
 ['stale retail price comparison protects concurrent pricing',route.includes('AND ROUND(price*100)=?')&&route.includes('RETAIL_PRICE_CHANGED')],
 ['price proposals cannot be silently removed',route.includes('trg_po_price_no_delete')&&route.includes('idx_po_price_pending')],
 ['rejecting a proposal does not update retail price',route.includes("if(choice==='approve')")],
 ['review APIs are mounted under receiving controls',mount.includes("router.use('/review',require('./purchase-receiving-review'))")],
 ['review available from authenticated deferred shell',deferred.includes("'/purchase-receiving-review-ui.js'")],
 ['purchase screen has a review launcher',ui.includes('tt-rr-launch')&&ui.includes('Receiving exceptions & pricing')],
 ['fast receiving links to review after receipt',fast.includes('tt-fr-review')&&fast.includes('window.TotalToolsReceivingReview')],
 ['responsive review styles use authoritative stylesheet',css.includes('.tt-rr__panel')&&css.includes('@media(max-width:680px)')]
];
let failures=0;for(const [name,valid] of cases){console.log((valid?'PASS':'FAIL')+' Receiving review: '+name);if(!valid)failures++;}
assert.equal(failures,0,'Receiving review contract has failing expectations');
console.log('PASS receiving-review contract: '+cases.length+'/'+cases.length);
