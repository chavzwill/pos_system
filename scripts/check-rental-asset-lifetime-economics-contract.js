'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const route=read('routes/rental-asset-lifetime-economics.js'),guard=read('routes/rental-asset-economics-financial-guard.js'),trace=read('routes/inventory-traceability.js');
new vm.Script(route,{filename:'rental asset lifetime economics'});new vm.Script(guard,{filename:'rental asset financial guard'});
const checks=[
 ['rental asset financial guard is mounted before economics route',trace.includes("router.use('/rental-economics',require('./rental-asset-economics-financial-guard'))")&&trace.indexOf('rental-asset-economics-financial-guard')<trace.indexOf('rental-asset-lifetime-economics')],
 ['rental asset economics is mounted',trace.includes("router.use('/rental-economics',require('./rental-asset-lifetime-economics').router)")],
 ['asset registry preserves acquisition cost and evidence',route.includes('rental_assets')&&route.includes('acquisition_cost')&&route.includes('acquisition_evidence_ref')],
 ['asset registration financial evidence is permission guarded',guard.includes("requireAnyPermission('inventory_edit','reports_financial')")&&guard.includes('acquisition_evidence_ref')],
 ['placeholder acquisition evidence is rejected',guard.includes("'n/a'")&&guard.includes("'unknown'")&&guard.includes('meaningful acquisition')],
 ['current catalog cost is never used as acquisition history',!route.includes('p.cost')&&!route.includes('products.cost')&&route.includes('current_catalog_cost_forbidden:true')],
 ['serial assets are uniquely bound to inventory serial identity',route.includes('idx_rental_assets_serial')&&route.includes('serial_id')],
 ['serial registration validates product and branch identity',route.includes('Inventory serial does not match the rental product and branch')],
 ['asset allocations link exact rental agreement items',route.includes('rental_asset_allocations')&&route.includes('agreement_item_id')],
 ['an asset cannot have overlapping unresolved allocations',route.includes('already allocated to an unresolved rental')],
 ['asset allocation checks product and branch',route.includes('Rental asset product does not match the rental line')&&route.includes('agreement branch')],
 ['multi-unit rental revenue allocation method is explicit',route.includes("equal_share_per_issued_unit")&&route.includes('rai.rental_fee')],
 ['maintenance records direct cost and evidence',route.includes('rental_asset_maintenance')&&route.includes('direct_cost')&&route.includes('evidence_ref')],
 ['maintenance with cost requires evidence',route.includes('Cost evidence reference is required when maintenance has a direct cost')],
 ['allocated assets cannot silently enter maintenance',route.includes('Release the active rental allocation before putting the asset into maintenance')],
 ['downtime is derived from maintenance intervals',route.includes('downtime_hours')&&route.includes('julianday')],
 ['asset-level recoveries and direct losses require evidence',route.includes('rental_asset_economic_events')&&route.includes('damage_recovery')&&route.includes('unrecovered_damage_loss')],
 ['asset economic events require financial/writeoff authority',guard.includes("requireAnyPermission('reports_financial','inventory_writeoff_approve')")&&guard.includes('/economic-events')],
 ['disposal requires financial/writeoff authority and meaningful evidence',guard.includes('/dispose')&&guard.includes('disposal/sale/write-off evidence reference')],
 ['disposal is blocked while rental allocation remains open',route.includes('cannot be disposed while allocated to an unresolved rental')],
 ['lifetime contribution includes revenue recovery disposal acquisition maintenance and losses',route.includes('revenue+recoveries+disposal-acq-maintenance-otherCosts')],
 ['ROI is based on preserved acquisition cost',route.includes('return_on_acquisition_cost_pct')&&route.includes('100*contribution/acq')],
 ['economics discloses missing unrecorded costs rather than inventing them',route.includes('Unrecorded maintenance, downtime, insurance, financing, depreciation and overhead are not invented')],
 ['asset economics does not autonomously purchase dispose or alter unrelated financial records',route.includes('automatic_actions:false')&&!route.includes('INSERT INTO purchase_orders')&&!route.includes('UPDATE customers SET')&&!route.includes('INSERT INTO journal_entries')]
];
let failed=0;for(const [name,ok]of checks){console.log(`${ok?'PASS':'FAIL'} Rental asset lifetime economics: ${name}`);if(!ok)failed++;}if(failed){console.error(`Rental asset lifetime economics contract FAILED (${failed}/${checks.length} failed).`);process.exit(1)}console.log(`Rental asset lifetime economics contract OK (${checks.length} checks).`);