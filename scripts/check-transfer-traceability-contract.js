'use strict';
const fs=require('fs'),path=require('path');const root=path.join(__dirname,'..');const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const server=read('server.js'),shim=read('routes/transfer-valuation-hardening.js'),route=read('routes/transfer-traceability-hardening.js');
const checks=[
 ['traceable transfer route replaces valuation hardening',shim.includes("require('./transfer-traceability-hardening')")],
 ['hardened transfer remains before legacy transfer route',server.indexOf('transfer-valuation-hardening')<server.indexOf("require('./routes/transfers')")],
 ['transfer identity allocation ledger exists',route.includes('transfer_identity_allocations')],
 ['serial transfer count must match quantity',route.includes('requires exactly ${qty} serial numbers')],
 ['duplicate transfer serials are rejected',route.includes('same serial cannot appear twice')],
 ['serial must exist at source branch',route.includes("branch_id=? AND status='available'")],
 ['serial is marked in transit at dispatch',route.includes("SET status='in_transit'")],
 ['serial moves to destination branch on receipt',route.includes("branch_id=?,bin_id=?,status='available'")],
 ['lots allocate FEFO when not explicitly selected',route.includes("ORDER BY CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END,date(expiry_date),created_at,id")],
 ['expired lots are excluded from automatic allocation',route.includes("date(expiry_date)>=date('now')")],
 ['source lot available quantity is decremented',route.includes('available_quantity=available_quantity-?')],
 ['destination lot identity is recreated with provenance',route.includes('purchase_receipt_item_id,supplier_id')],
 ['partial receipts cannot exceed tracked identity in transit',route.includes('exceeds tracked serial/lot identity still in transit')],
 ['cancellation restores serial identity to source',route.includes("status='available',branch_id=?")],
 ['cancellation restores source lot quantity',route.includes('available_quantity=available_quantity+?')],
 ['tracked bin-controlled source requires exact bin',route.includes('requires exact source bin identity')],
 ['tracked destination requires explicit bin where bin controlled',route.includes('Destination bin is required for tracked inventory')],
 ['valuation remains integrated at dispatch',route.includes('reserveTransferValuation')],
 ['valuation remains integrated at receipt',route.includes('receiveTransferValuation')],
 ['valuation remains integrated at cancellation',route.includes('cancelTransferValuation')],
 ['identity events record transfer out',route.includes("'transfer_out'")],
 ['identity events record transfer in',route.includes("'transfer_in'")],
 ['identity events record cancellation',route.includes("'transfer_cancelled'")]
];
let failed=0;for(const [n,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Transfer traceability: ${n}`);if(!ok)failed++;}if(failed){console.error(`Transfer traceability contract FAILED (${failed}/${checks.length} failed).`);process.exit(1);}console.log(`Transfer traceability contract OK (${checks.length} checks).`);
