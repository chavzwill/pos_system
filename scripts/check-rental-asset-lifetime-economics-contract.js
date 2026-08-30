'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const route=read('routes/rental-asset-lifetime-economics.js'),guard=read('routes/rental-asset-economics-financial-guard.js'),integration=read('routes/rental-asset-workflow-integration.js'),loss=read('routes/rental-loss-prevention.js'),trace=read('routes/inventory-traceability.js');
new vm.Script(route,{filename:'rental asset lifetime economics'});new vm.Script(guard,{filename:'rental asset financial guard'});new vm.Script(integration,{filename:'rental asset workflow integration'});
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
 ['asset economics does not autonomously purchase dispose or alter unrelated financial records',route.includes('automatic_actions:false')&&!route.includes('INSERT INTO purchase_orders')&&!route.includes('UPDATE customers SET')&&!route.includes('INSERT INTO journal_entries')],
 ['normal rental loss-prevention chain mounts asset workflow integration first',loss.includes("router.use(require('./rental-asset-workflow-integration'))")&&loss.indexOf('rental-asset-workflow-integration')<loss.indexOf('rental-missing-asset-disposition')],
 ['rental workspace exposes exact asset candidates and assignments',integration.includes('/agreements/:id/asset-candidates')&&integration.includes('/agreements/:id/asset-assignments')&&integration.includes('explicit_asset_assignment')],
 ['tracked rental issue fails closed until physical asset assignment is complete',integration.includes('rental_asset_assignment_required')&&integration.includes('Physical rental asset assignment is incomplete')],
 ['asset assignment prevents product branch mismatch and overlapping rentals',integration.includes('does not match the rental product and branch')&&integration.includes('already assigned to another unresolved rental')],
 ['missing rental declaration requires exact allocated asset identity',integration.includes('rental_asset_identity_required')&&integration.includes('Selected rental asset is not allocated to this rental item')],
 ['missing disposition stores physical rental asset identity',integration.includes('rental_asset_id')&&integration.includes('UPDATE rental_missing_asset_dispositions SET rental_asset_id')],
 ['approved missing disposition releases allocation and marks asset lost',integration.includes("status='lost'")&&integration.includes('Missing asset disposition RMA-')&&integration.includes('released_at=COALESCE')],
 ['missing disposition avoids double-counting asset economic loss',integration.includes('double-counting is explicitly avoided')&&!integration.includes("event_type,'unrecovered_damage_loss'" )],
 ['full physical return automatically releases asset allocations',integration.includes("release_reason='Physical rental returned'")&&integration.includes("agreement?.status)==='returned'" )],
 ['return inspection can automatically send damaged assets to maintenance',integration.includes('asset_conditions')&&integration.includes("status='maintenance'")&&integration.includes('return_inspection')]
];
let failed=0;for(const [name,ok]of checks){console.log(`${ok?'PASS':'FAIL'} Rental asset lifetime economics: ${name}`);if(!ok)failed++;}if(failed){console.error(`Rental asset lifetime economics contract FAILED (${failed}/${checks.length} failed).`);process.exit(1)}console.log(`Rental asset lifetime economics contract OK (${checks.length} checks).`);
