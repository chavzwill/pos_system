'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const route=read('routes/rental-asset-disposal.js'),trace=read('routes/inventory-traceability.js'),ui=read('public/rental-fleet-disposal.js'),deferred=read('public/shell-deferred.js');
new vm.Script(route,{filename:'rental asset disposal'});new vm.Script(ui,{filename:'rental fleet disposal ui'});
const checks=[
 ['controlled disposal route is mounted before lifetime economics',trace.includes("require('./rental-asset-disposal')")&&trace.indexOf('rental-asset-disposal')<trace.indexOf('rental-asset-lifetime-economics')],
 ['disposal is distinct from fleet sale and rejects proceeds',route.includes('rental_asset_sale_required')&&route.includes('use the controlled Fleet Sale workflow')],
 ['active assets must be retired before disposal',route.includes('rental_asset_retirement_required')&&route.includes('Retire the asset from rental service before permanent disposal')],
 ['sold lost and disposed assets cannot re-enter disposal',route.includes("['sold','lost','disposed']")],
 ['open rental allocation blocks permanent disposal',route.includes('cannot be disposed while allocated to an unresolved rental')],
 ['open maintenance blocks permanent disposal',route.includes('Complete or formally close maintenance before permanent disposal')],
 ['disposal requires meaningful reason and evidence',route.includes('meaningful(reason,5)')&&route.includes('meaningful(evidence)')],
 ['disposal requires independent financial authorization',route.includes('disposal_authorizer_pin')&&route.includes('String(employee.id)===String(actorId')&&route.includes('rental_asset_disposal_independent_authorization')],
 ['physical stock is removed exactly once',route.includes("-1,'rental_asset_disposal'")&&route.includes('UPDATE branch_inventory SET stock_qty=stock_qty-1')],
 ['global stock is reconciled after disposal',route.includes('SELECT COALESCE(SUM(stock_qty),0) FROM branch_inventory')],
 ['cost removal uses tracked valuation before acquisition fallback',route.includes('valueStockAdjustment')&&route.includes('tracked_inventory_pool')&&route.includes('complete_asset_acquisition_evidence')],
 ['missing cost evidence fails accounting closed rather than inventing cost',route.includes("accountingStatus='blocked_missing_cost_evidence'")],
 ['inventory writeoff account is explicitly bootstrapped',route.includes("'5500','Inventory Loss & Write-offs'")],
 ['evidenced disposal posts writeoff against inventory',route.includes("code:'5500'")&&route.includes("code:'1200'")&&route.includes("sourceType:'rental_asset_disposal'")],
 ['serial identity is permanently marked disposed',route.includes("inventory_serials SET status='disposed'")],
 ['asset lifecycle becomes disposed with zero sale proceeds',route.includes("rental_assets SET status='disposed'")&&route.includes('disposal_value=0')],
 ['disposal evidence preserves actor authorizer movement cost and journal',route.includes('rental_asset_disposals')&&route.includes('authorized_by_employee_id')&&route.includes('stock_movement_id')&&route.includes('journal_id')],
 ['lifecycle history records disposal transition',route.includes('rental_asset_lifecycle_events')&&route.includes("'disposed'")],
 ['employee UI exposes permanent disposal only from owned retired states',ui.includes('Dispose permanently')&&ui.includes("'retired','internal_use','reserve','parts_donor','long_term_storage','awaiting_sale'")],
 ['employee UI requires independent authorizer pin and evidence',ui.includes('disposal_authorizer_pin')&&ui.includes('Evidence / write-off reference')],
 ['employee UI clearly redirects proceeds to Fleet Sale',ui.includes('If any money will be received')&&ui.includes('Fleet Sale')],
 ['employee UI is deferred-loaded',deferred.includes('/rental-fleet-disposal.js')]
];
let failed=0;for(const [name,ok]of checks){console.log(`${ok?'PASS':'FAIL'} Rental asset disposal: ${name}`);if(!ok)failed++;}if(failed){console.error(`Rental asset disposal contract FAILED (${failed}/${checks.length} failed).`);process.exit(1)}console.log(`Rental asset disposal contract OK (${checks.length} checks).`);
