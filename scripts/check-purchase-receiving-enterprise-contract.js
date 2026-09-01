'use strict';
const fs=require('fs'),path=require('path');const root=path.join(__dirname,'..');const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const lib=read('lib/purchase-receiving-controls.js'),receive=read('routes/purchase-receipt-traceability.js'),control=read('routes/purchase-receiving-controls.js'),uom=read('routes/purchase-receipt-uom-guard.js');
const checks=[
 ['product-level inspection policy exists',lib.includes('product_receiving_controls')&&lib.includes('inspection_required')],
 ['product-level overreceipt tolerance exists',lib.includes('overreceipt_tolerance_pct')],
 ['receipt exception ledger is durable',lib.includes('purchase_receipt_exceptions')],
 ['quality hold ledger is durable',lib.includes('purchase_receipt_quality_holds')],
 ['overreceipt beyond tolerance requires approval',lib.includes('exceeds the configured')&&lib.includes("can(req.employee?.permissions,'purchasing_approve')")],
 ['overreceipt requires reason evidence',lib.includes('Over-receipt of ${item.product_name} requires an exception reason')],
 ['short-close requires purchasing approval',lib.includes('Closing a shortage for ${item.product_name} requires purchasing approval')],
 ['short-close requires reason evidence',lib.includes('Closing a shortage for ${item.product_name} requires an exception reason')],
 ['UOM normalization no longer blocks approved receiving exceptions',!uom.includes('but only ${remaining}')&&!uom.includes('baseQuantity-remaining')],
 ['UOM evidence is attached to request for atomic posting',uom.includes('req.receiptUomEvidence=evidence')],
 ['receipt UOM evidence is posted in same transaction as receipt item',receive.includes("sourceType:'purchase_receipt'")&&receive.includes('snapshot(tx')],
 ['receipt UOM snapshot links to actual receipt item identity',receive.includes('sourceLineId:receiptItemId')],
 ['inspection policy is resolved before stock posting',receive.indexOf('getReceivingControl')<receive.indexOf("UPDATE products SET stock_qty=stock_qty+?")],
 ['receipt exceptions and holds post in same DB transaction as stock',receive.includes('recordReceiptControls(tx')],
 ['inspection receipt is moved out of sellable stock',lib.includes("fromStatus:'available',toStatus:'inspection'")],
 ['PO completion understands approved shortages',receive.includes('isPoItemClosed(tx,i)')&&lib.includes("exception_type='shortage'")],
 ['quality release requires purchasing approval',control.includes("router.post('/quality-holds/:id/release',requirePermission('purchasing_approve')")],
 ['quality release requires explicit disposition reason',control.includes('Inspection disposition reason is required')],
 ['quality release moves inventory status atomically',control.includes('moveStockStatus(tx')&&control.includes('await tx.commit()')],
 ['quality release only operates on active inspection hold',control.includes("hold.status!=='inspection'")],
 ['receiving policy administration requires approval authority',control.includes("router.put('/products/:productId',requirePermission('purchasing_approve')")],
 ['receipt workflow mounts receiving-control API',receive.includes("router.use('/receiving-controls',require('./purchase-receiving-controls'))")]
];
let failed=0;for(const[n,ok]of checks){console.log(`${ok?'PASS':'FAIL'} Purchase receiving enterprise: ${n}`);if(!ok)failed++;}if(failed){console.error(`Purchase receiving enterprise contract FAILED (${failed}/${checks.length} failed).`);process.exit(1)}console.log(`Purchase receiving enterprise contract OK (${checks.length} checks).`);
