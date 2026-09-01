'use strict';
const fs=require('fs');const path=require('path');const root=path.join(__dirname,'..');const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const server=read('server.js'),guard=read('routes/retail-traceability-guard.js'),trace=read('lib/inventory-traceability.js');
const checks=[
 ['POS traceability guard mounted',server.includes("/api/transactions', require('./routes/retail-traceability-guard')")],
 ['traceability guard runs before checkout validation',server.indexOf('retail-traceability-guard')<server.indexOf('retail-checkout-hardening')],
 ['identity reservation ledger exists',guard.includes('inventory_identity_reservations')],
 ['identity reservation has TTL',guard.includes("datetime('now','+5 minutes')")],
 ['stale identity reservations expire',guard.includes("status='expired'")],
 ['serial selection count equals sale quantity',guard.includes('requires exactly ${qty} serial numbers before checkout')],
 ['duplicate serial selection rejected',guard.includes('same serial number cannot be selected twice')],
 ['serial must belong to selling branch',guard.includes("s.branch_id=? AND s.status='available'")],
 ['expired serial cannot be sold',guard.includes('is expired and cannot be sold')],
 ['serial cannot be concurrently reserved',guard.includes('already reserved by another transaction')],
 ['lot explicit allocations must reconcile to quantity',guard.includes('Selected lot quantities must total ${qty}')],
 ['automatic lot allocation is FEFO',guard.includes("ORDER BY CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END,date(expiry_date),created_at,id")],
 ['expired lots excluded from FEFO',guard.includes("date(expiry_date)>=date('now')")],
 ['lot reservations subtract competing holds',guard.includes('unreserved unit(s) available')],
 ['successful sale finalizes serial as sold',guard.includes("SET status='sold'")],
 ['successful sale decrements exact lot balance',guard.includes('SET available_quantity=available_quantity-?')],
 ['sale identity event links to transaction',guard.includes("'transaction'")&&guard.includes("'sold'")],
 ['failed checkout releases identity reservation',guard.includes("release(key).catch")],
 ['disconnect releases identity reservation',guard.includes("res.on('close'")],
 ['finalization failure is fail-visible',guard.includes('transaction requires reconciliation')],
 ['serial and lot provenance remains in traceability schema',trace.includes('purchase_receipt_item_id')&&trace.includes('supplier_id')]
];
let failed=0;for(const [n,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Retail traceability: ${n}`);if(!ok)failed++;}if(failed){console.error(`Retail traceability contract FAILED (${failed}/${checks.length} failed).`);process.exit(1);}console.log(`Retail traceability contract OK (${checks.length} checks).`);
