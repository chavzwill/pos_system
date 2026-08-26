'use strict';
const fs=require('fs');const path=require('path');const root=path.join(__dirname,'..');const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const server=read('server.js'),guard=read('routes/cycle-count-traceability-guard.js'),status=read('routes/inventory-stock-status.js'),idStatus=read('lib/inventory-identity-status.js');
const checks=[
 ['cycle identity guard mounted before cycle hardening',server.indexOf('cycle-count-traceability-guard')>=0&&server.indexOf('cycle-count-traceability-guard')<server.indexOf("require('./routes/cycle-count-hardening')")],
 ['cycle serial observations require scanned identity count',guard.includes('requires exactly ${counted} scanned serial numbers')],
 ['unknown serials fail closed to reconciliation',guard.includes('Serial ${sn} is unknown')],
 ['cross-branch serial gains are rejected',guard.includes('belongs to another branch')],
 ['nonphysical serial states cannot be counted silently',guard.includes('cannot be counted as physical branch stock without reconciliation')],
 ['lot counts require lot and stock status identity',guard.includes('requires lot and stock-status quantities')],
 ['lot observations must equal counted quantity',guard.includes('must total counted quantity ${counted}')],
 ['identity observations are preserved separately',guard.includes('cycle_count_identity_observations')],
 ['serial approval derives exact missing identities',guard.includes('const missing=expected.filter')],
 ['serial variance must reconcile with quantity variance',guard.includes('Serial identity variance for ${item.product_name}')],
 ['missing serial becomes count_missing',guard.includes("SET status='count_missing'")],
 ['restricted missing serial reduces restricted aggregate',guard.includes('inventory_stock_status_balances SET quantity=quantity-1')],
 ['lot count reconciles by lot and status',guard.includes('inventory_lot_status_balances')&&guard.includes('stock_status')],
 ['lot identity variance must equal quantity variance',guard.includes('Lot/status identity variance for ${item.product_name}')],
 ['lot available identity is adjusted exactly',guard.includes('SET available_quantity=available_quantity+?')],
 ['restricted lot identity updates aggregate status',guard.includes('ON CONFLICT(product_id,branch_id,status) DO UPDATE SET quantity=quantity+excluded.quantity')],
 ['identity events link count adjustments to cycle count',guard.includes("'cycle_count'")&&guard.includes("'count_adjustment'"))],
 ['post-quantity identity failure is fail-visible',guard.includes('cycle count requires reconciliation')],
 ['identity reconciliation ledger exists',guard.includes('cycle_count_identity_reconciliations')],
 ['stock disposition now invokes identity movement atomically',status.includes('moveIdentityStatus(tx')&&status.indexOf('moveIdentityStatus(tx')<status.indexOf('moveStockStatus(tx')],
 ['serial disposition requires exact serial count',idStatus.includes('Serial-controlled disposition requires exactly ${qty} serial numbers')],
 ['lot disposition requires exact allocation',idStatus.includes('Lot-controlled disposition requires exact lot allocation')],
 ['serial disposition is optimistic guarded',idStatus.includes('changed during disposition; reload and retry')],
 ['lot restricted balances are explicit',idStatus.includes('inventory_lot_status_balances')],
 ['identity availability endpoint exposes serial or lot status evidence',status.includes("tracking_mode:'serial'")&&status.includes("tracking_mode:'lot'")]
];
let failed=0;for(const [n,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Cycle identity: ${n}`);if(!ok)failed++;}if(failed){console.error(`Cycle identity contract FAILED (${failed}/${checks.length} failed).`);process.exit(1);}console.log(`Cycle identity contract OK (${checks.length} checks).`);
