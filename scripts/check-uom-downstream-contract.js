'use strict';
const fs=require('fs'),path=require('path');const root=path.join(__dirname,'..');const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const lib=read('lib/unit-of-measure.js'),server=read('server.js'),receipt=read('routes/purchase-receipt-uom-guard.js'),receiptCore=read('routes/purchase-receipt-traceability.js'),transfer=read('routes/transfer-uom-guard.js'),transferCore=read('routes/transfer-traceability-hardening.js');
const receiveRouteIndex=receiptCore.indexOf("router.patch('/:id/receive'");
const checks=[
 ['movement UOM mode exists',lib.includes("mode!=='movement'")],
 ['movement UOM uses active product conversions without sell purchase conflation',lib.includes("else if(mode==='sell')")&&lib.includes("mode!=='movement'")],
 ['purchase receipt UOM guard is mounted before receipt posting',receiptCore.indexOf("router.use(require('./purchase-receipt-uom-guard'))")>=0&&receiptCore.indexOf("purchase-receipt-uom-guard")<receiveRouteIndex],
 ['receiving can inherit original PO line UOM',receipt.includes("source_type='purchase_order'")&&receipt.includes('source_line_id=?')],
 ['receiving converts entered quantity to base quantity',receipt.includes('const baseQuantity=toBaseQuantity')&&receipt.includes('line.quantity_received=baseQuantity')],
 ['converted receiving quantity is capped by base open quantity',receipt.includes('baseQuantity-remaining>1e-9')],
 ['receipt UOM evidence is snapshotted',receipt.includes("sourceType:'purchase_receipt'")],
 ['receipt conversion executes as middleware before serial lot validation in receive handler',receiptCore.indexOf("router.use(require('./purchase-receipt-uom-guard'))")<receiveRouteIndex&&receiptCore.indexOf('validateReceiptIdentity',receiveRouteIndex)>receiveRouteIndex],
 ['transfer UOM guard is mounted before hardened transfer engine',server.indexOf("require('./routes/transfer-uom-guard')")>=0&&server.indexOf("require('./routes/transfer-uom-guard')")<server.indexOf("require('./routes/transfer-valuation-hardening')")],
 ['transfer quantities convert to base before inventory movement',transfer.includes("resolveProductUom(db,productId,line.uom_code||line.entered_uom||null,'movement')")&&transfer.includes('line.quantity=baseQuantity')],
 ['transfer retains entered UOM evidence',transfer.includes('entered_quantity')&&transfer.includes('entered_uom')&&transfer.includes('uom_factor_to_base')],
 ['transfer UOM evidence is linked to transfer lines',transfer.includes("sourceType:'branch_transfer'")&&transfer.includes('sourceLineId:lineId')],
 ['transfer core still performs exact serial lot traceability after UOM normalization',transferCore.includes('allocateIdentity')&&transferCore.includes('reserveTransferValuation')],
 ['post-document UOM snapshot failures remain fail-visible',receipt.includes('reconciliation required')&&transfer.includes('reconciliation required')]
];
let failed=0;for(const [n,ok] of checks){console.log(`${ok?'PASS':'FAIL'} UOM downstream: ${n}`);if(!ok)failed++;}if(failed){console.error(`UOM downstream contract FAILED (${failed}/${checks.length} failed).`);process.exit(1);}console.log(`UOM downstream contract OK (${checks.length} checks).`);
