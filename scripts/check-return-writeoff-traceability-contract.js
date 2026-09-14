'use strict';
const fs=require('fs');const path=require('path');const root=path.join(__dirname,'..');const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const server=read('server.js'),ret=read('routes/retail-return-traceability-guard.js'),retCore=read('routes/retail-return-hardening.js'),woff=read('routes/inventory-writeoff-traceability-guard.js'),woffCore=read('routes/inventory-writeoffs.js');
const checks=[
 ['return identity guard mounted',server.includes("/api/transactions', require('./routes/retail-return-traceability-guard')")],
 ['return hardening is actually mounted',server.includes("/api/transactions', require('./routes/retail-return-hardening')")],
 ['return identity guard runs before return hardening',server.indexOf('retail-return-traceability-guard')<server.indexOf('retail-return-hardening')],
 ['serial return must match original sale transaction',ret.includes("event_type='sold'")&&ret.includes('reference_id=?')],
 ['serial return quantity must match selected identity count',ret.includes('Serial-controlled return requires exactly ${qty} serial numbers')],
 ['serial return locks sold identity before commercial return',ret.includes("SET status='return_pending'")],
 ['failed return restores serial sold state',ret.includes("SET status='sold'")&&ret.includes('release(key')],
 ['successful serial return restores exact identity',ret.includes("SET status='available',branch_id=?")],
 ['lot return requires original lot numbers',ret.includes('Lot-controlled return requires the lot number(s) originally sold')],
 ['lot returns cannot exceed transaction-specific sold quantity',ret.includes('remaining returnable from this sale')],
 ['return lot quantity is restored to exact lot',ret.includes('SET available_quantity=available_quantity+?')],
 ['return identity allocation ledger prevents repeated identity returns',ret.includes('inventory_return_identity_allocations')],
 ['return identity failure is fail-visible',ret.includes('return requires reconciliation')],
 ['commercial return still uses cumulative quantity safeguards',retCore.includes('Max returnable')&&retCore.includes('returnedMap')],
 ['writeoff traceability guard mounted before writeoff engine',server.indexOf('inventory-writeoff-traceability-guard')<server.indexOf("require('./routes/inventory-writeoffs')")],
 ['writeoff workflow is actually mounted',server.includes("/api/inventory-writeoffs', require('./routes/inventory-writeoffs')")],
 ['tracked serial writeoff requires exact identity count',woff.includes('Serial-controlled write-off requires exactly ${qty} serial numbers')],
 ['tracked lot writeoff requires exact allocation',woff.includes('Lot-controlled write-off requires exact lot allocation')],
 ['writeoff approval preparation does not mutate serial state',!woff.includes("SET status='writeoff_pending'")&&woff.includes('req.writeoffIdentityApproval=')],
 ['writeoff approval rechecks lot live quantity transactionally',woffCore.includes('available_quantity>=?')&&woffCore.includes("writeoffError('WRITEOFF_IDENTITY_CHANGED')")],
 ['successful serial writeoff retires exact identity in core transaction',woffCore.includes("SET status='written_off'")],
 ['successful lot writeoff decrements exact lot in core transaction',woffCore.includes('SET available_quantity=available_quantity-?')],
 ['writeoff identity event is linked to writeoff source in core transaction',woffCore.includes("'inventory_writeoff'")&&woffCore.includes("'written_off'")],
 ['writeoff identity failure is staff-safe and rollback-driven',woffCore.includes("writeoffError('WRITEOFF_IDENTITY_CHANGED')")&&woffCore.includes('rollbackWriteoffQuietly')],
 ['writeoff core still preserves valuation and GL evidence',woffCore.includes('valueStockAdjustment')&&woffCore.includes('postSourceJournal')]
];
let failed=0;for(const [n,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Return/writeoff traceability: ${n}`);if(!ok)failed++;}if(failed){console.error(`Return/writeoff traceability contract FAILED (${failed}/${checks.length} failed).`);process.exit(1);}console.log(`Return/writeoff traceability contract OK (${checks.length} checks).`);
