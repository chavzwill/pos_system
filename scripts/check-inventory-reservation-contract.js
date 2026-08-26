'use strict';
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const lib=read('lib/inventory-reservations.js');
const middleware=read('routes/retail-inventory-reservation.js');
const checkout=read('routes/retail-checkout-hardening.js');
const status=read('lib/inventory-stock-status.js');
const adjust=read('routes/inventory-adjustment-hardening.js');
const checks=[
 ['reservation ledger has TTL and release evidence',lib.includes('expires_at')&&lib.includes('released_at')&&lib.includes('release_reason')],
 ['active reservations are indexed by inventory identity',lib.includes('idx_inventory_reservation_active')&&lib.includes('variation_id')],
 ['stale reservations expire automatically',lib.includes("status='expired'")&&lib.includes("ttl_expired")],
 ['reservation acquisition occurs in a write transaction',middleware.includes("db.transaction('write')")&&middleware.includes('reserveLines(tx')],
 ['reservation availability is checked after existing reservations',lib.includes('getReservedQty')&&lib.includes('available<qty')],
 ['checkout reservation has bounded TTL',middleware.includes('ttlSeconds:120')],
 ['checkout releases reservation on success or failure',middleware.includes("res.on('finish'")&&middleware.includes("checkout_failed")],
 ['client disconnect releases reservation',middleware.includes("res.on('close'")&&middleware.includes('client_disconnected')],
 ['reservation middleware is mounted before checkout validation',checkout.includes("router.use(require('./retail-inventory-reservation'))")],
 ['checkout excludes its own reservation while validating',checkout.includes('excludeReservationKey:req.inventoryReservationKey')],
 ['variation availability subtracts competing reservations',checkout.includes('getReservedQty')&&checkout.includes('variation units available after reservations')],
 ['general availability exposes reserved quantity',status.includes('getActiveReservedQty')&&status.includes('reserved, available: Math.max(0, onHand - restricted - reserved)')],
 ['disposition cannot consume reserved available stock',status.includes('const state = await getAvailableQty')&&status.includes('units are available for disposition')],
 ['negative manual adjustment protects reserved/restricted stock',adjust.includes('unrestricted, unreserved units can be reduced')],
 ['manual adjustment uses granular adjustment permission',adjust.includes("requirePermission('inventory_adjust')")],
 ['multi-bin adjustment requires exact bin',adjust.includes('stored in multiple bins; select the exact bin being adjusted')],
 ['global adjustment is blocked when branch inventory exists',adjust.includes('global stock cannot be edited independently of branch inventory')]
];
let failed=0;
for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Inventory reservation: ${name}`);if(!ok)failed++;}
if(failed){console.error(`Inventory reservation contract FAILED (${failed}/${checks.length} failed).`);process.exit(1);}
console.log(`Inventory reservation contract OK (${checks.length} checks).`);
