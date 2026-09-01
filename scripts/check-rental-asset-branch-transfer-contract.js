'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const route=read('routes/rental-asset-branch-transfers.js'),trace=read('routes/inventory-traceability.js'),ui=read('public/rental-fleet-transfer.js'),shell=read('public/shell-deferred.js'),syntax=read('scripts/check-client-syntax.js');
new vm.Script(route,{filename:'rental asset branch transfers'});new vm.Script(ui,{filename:'rental fleet transfer ui'});
const checks=[
 ['exact rental transfer route is mounted before destructive disposition flows',trace.includes("require('./rental-asset-branch-transfers')")&&trace.indexOf('rental-asset-branch-transfers')<trace.indexOf('rental-asset-disposal')&&trace.indexOf('rental-asset-branch-transfers')<trace.indexOf('rental-asset-sales')],
 ['transfer evidence table binds exact asset product serial and both branches',route.includes('rental_asset_branch_transfers')&&route.includes('asset_id INTEGER NOT NULL')&&route.includes('serial_id INTEGER NOT NULL')&&route.includes('from_branch_id INTEGER NOT NULL')&&route.includes('to_branch_id INTEGER NOT NULL')],
 ['only one open transfer can exist for a physical rental asset',route.includes('idx_rental_asset_branch_transfer_open')&&route.includes("WHERE status IN ('pending','in_transit')")],
 ['branch transfer requires a serialized physical rental identity',route.includes('Exact rental fleet branch transfer requires a serialized physical asset identity')&&route.includes('serial_branch_id')],
 ['asset and serial branch mismatch fails closed before transfer',route.includes('Rental asset and serial branch identity are already inconsistent; reconcile them before transfer.')],
 ['active rental allocation blocks fleet relocation',route.includes('cannot transfer branches while allocated to an unresolved rental')],
 ['open maintenance blocks fleet relocation',route.includes('Complete or formally close maintenance before transferring this rental asset')],
 ['terminal lost sold and disposed states are excluded from transfer eligibility',route.includes("new Set(['active','retired','awaiting_sale','internal_use','reserve','parts_donor','long_term_storage'])")&&!route.includes("new Set(['active','retired','awaiting_sale','internal_use','reserve','parts_donor','long_term_storage','sold'")],
 ['opening a transfer removes the asset and serial from ordinary availability',route.includes("status='transfer_pending'")&&route.includes("inventory_serials SET status='transfer_pending'")],
 ['dispatch removes exactly one unit from source branch stock',route.includes("stock_qty=stock_qty-1")&&route.includes("-1,'rental_asset_transfer_dispatch'")],
 ['dispatch reconciles global available stock instead of incrementally guessing',route.includes('SELECT COALESCE(SUM(stock_qty),0) qty FROM branch_inventory')&&route.includes('UPDATE products SET stock_qty=?')],
 ['dispatch removes preserved valuation composition from the source branch pool',route.includes('removeFromPool')&&route.includes("'rental_asset_branch_transfer'")&&route.includes('tracked_value')],
 ['dispatch marks both asset and serial in transit',route.includes("rental_assets SET status='in_transit'")&&route.includes("inventory_serials SET status='in_transit'")],
 ['in-transit transfer cannot be cancelled as though the asset never left',route.includes('Only a transfer that has not been physically dispatched can be cancelled.')],
 ['receipt adds exactly one unit to destination branch stock',route.includes('ON CONFLICT(product_id,branch_id) DO UPDATE SET stock_qty=stock_qty+1')&&route.includes("1,'rental_asset_transfer_receive'")],
 ['receipt restores the same valuation composition to the destination branch pool',route.includes('addComposition')&&route.includes('legacy_quantity')&&route.includes('untracked_quantity')],
 ['receipt atomically moves rental asset and serial branch identity together',route.includes('UPDATE rental_assets SET branch_id=?,status=?')&&route.includes('UPDATE inventory_serials SET branch_id=?,status=?,bin_id=NULL')],
 ['destination receipt deliberately requires local bin placement rather than inventing a bin',route.includes('bin_assignment_required:true')&&route.includes('destination bin assignment intentionally requires local placement')],
 ['inventory serial evidence records requested dispatched received and cancelled states',route.includes('rental_transfer_requested')&&route.includes('rental_transfer_dispatched')&&route.includes('rental_transfer_received')&&route.includes('rental_transfer_cancelled')],
 ['fleet lifecycle history records every relocation transition',route.includes('branch_transfer_requested')&&route.includes('branch_transfer_dispatched')&&route.includes('branch_transfer_received')&&route.includes('branch_transfer_cancelled')],
 ['employee fleet UI exposes transfer dispatch receive and cancellation controls',ui.includes('Transfer branch')&&ui.includes('Dispatch transfer')&&ui.includes('Receive transfer')&&ui.includes('Cancel transfer')],
 ['fleet UI communicates exact serial physical handoff semantics',ui.includes('one exact serialized rental asset')&&ui.includes('Source stock leaves only at dispatch')&&ui.includes('destination stock returns only when the exact serial is received')],
 ['transfer states are visible in the Fleet Management filter',ui.includes('transfer_pending')&&ui.includes('in_transit')],
 ['fleet transfer UI is deferred through the application shell',shell.includes("'/rental-fleet-transfer.js'")],
 ['fleet transfer UI is included in browser syntax certification',syntax.includes("'rental-fleet-transfer.js'" )]
];
let failed=0;for(const [name,ok]of checks){console.log(`${ok?'PASS':'FAIL'} Rental asset branch transfer: ${name}`);if(!ok)failed++;}
if(failed){console.error(`Rental asset branch transfer contract FAILED (${failed}/${checks.length} failed).`);process.exit(1)}
console.log(`Rental asset branch transfer contract OK (${checks.length} checks).`);
require('./check-rental-asset-sale-contract');
