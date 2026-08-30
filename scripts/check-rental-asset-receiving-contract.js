'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const receiving=read('routes/purchase-receipt-traceability.js'),bridge=read('lib/rental-asset-receiving.js'),trace=read('lib/inventory-traceability.js');
new vm.Script(receiving,{filename:'purchase receipt traceability'});new vm.Script(bridge,{filename:'rental asset receiving'});
const checks=[
 ['purchase receiving imports rental asset registration bridge',receiving.includes("require('../lib/rental-asset-receiving')")&&receiving.includes('registerRentalAssetsFromReceipt')],
 ['rental asset receiving schema initializes before receipt transaction',receiving.includes('await ensureRentalAssetReceiving()')],
 ['only explicitly rental-designated products become fleet assets',bridge.includes('is_rental')&&bridge.includes('if(!product||!Number(product.active)||!Number(product.is_rental))return []')],
 ['only serialized received identities auto-register as individual assets',bridge.includes("tracking_mode)!=='serial'")&&bridge.includes('identity.serials')],
 ['serial receipt identity already preserves unit cost and receipt source',trace.includes('unit_cost')&&trace.includes('purchase_receipt_item_id')&&trace.includes('recordReceiptIdentity')],
 ['asset acquisition cost comes from receipt unit-cost evidence',bridge.includes('acquisition_cost')&&bridge.includes('unitCost')&&!bridge.includes('products.cost')&&!bridge.includes('p.cost')],
 ['asset acquisition evidence references exact receipt line and serial',bridge.includes('purchase_receipt:')&&bridge.includes(':item:')&&bridge.includes(':serial:')],
 ['acquisition source table links asset receipt PO supplier and serial',bridge.includes('rental_asset_acquisition_sources')&&bridge.includes('purchase_receipt_id')&&bridge.includes('purchase_order_id')&&bridge.includes('supplier_id')&&bridge.includes('serial_id')],
 ['asset creation occurs in the same receiving transaction after serial identity creation',receiving.indexOf('recordReceiptIdentity(tx')<receiving.indexOf('registerRentalAssetsFromReceipt(tx')&&receiving.includes('await tx.commit()')],
 ['rental asset serial uniqueness prevents duplicate physical asset registration',bridge.includes('idx_rental_assets_serial')&&bridge.includes('WHERE serial_id=?')],
 ['asset product and branch derive from authoritative PO receiving context',receiving.includes('branchId:po.branch_id')&&receiving.includes('productId:item.product_id')],
 ['new assets start active and complete-evidence graded',bridge.includes("'complete','active'")],
 ['receipt response reports created rental assets',receiving.includes('rental_assets_created')&&receiving.includes('rental_assets_created_count')],
 ['ordinary merchandise is never silently converted into rental fleet assets',bridge.includes('Ordinary merchandise')&&bridge.includes('not flagged as rental inventory')]
];
let failed=0;for(const [name,ok]of checks){console.log(`${ok?'PASS':'FAIL'} Rental asset receiving: ${name}`);if(!ok)failed++;}if(failed){console.error(`Rental asset receiving contract FAILED (${failed}/${checks.length} failed).`);process.exit(1)}console.log(`Rental asset receiving contract OK (${checks.length} checks).`);
