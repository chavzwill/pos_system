'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const route=read('routes/rental-active-buyout.js'),trace=read('routes/inventory-traceability.js'),ui=read('public/rental-fleet-management.js'),deferred=read('public/shell-deferred.js');
new vm.Script(route,{filename:'rental active buyout'});new vm.Script(ui,{filename:'rental fleet management'});
const checks=[
 ['active buyout is mounted before ordinary fleet sale',trace.includes("require('./rental-active-buyout')")&&trace.indexOf('rental-active-buyout')<trace.indexOf('rental-asset-sales')],
 ['buyout requires an active issued rental allocation',route.includes("agreement_status)!=='active'")&&route.includes('aa.released_at IS NULL')],
 ['buyout is restricted to a clean single unresolved unit',route.includes('active_buyout_clean_single_unit_required')&&route.includes('already_resolved')&&route.includes('outstanding')],
 ['paused rental buyout is blocked',route.includes('Resume the rental before calculating an active buyout')],
 ['actual rental time is recalculated with authoritative feeFor',route.includes('feeFor(')&&route.includes('duration_adjustment')&&route.includes('rental_tax_adjustment')],
 ['closed pause time is excluded from buyout billing',route.includes('rental_agreement_pauses')&&route.includes('effectiveNow')],
 ['refundable deposit is applied once to combined settlement',route.includes('deposit_applied_to_buyout_total')&&route.includes('deposit_applied')&&route.includes("code:'2200'")],
 ['negative refund-shaped buyout fails closed',route.includes('active_buyout_negative_settlement')],
 ['cash requires authenticated matching open drawer',route.includes('Cash active buyout requires the authenticated cashier')&&route.includes("d.status!=='open'")&&route.includes('d.employee_id')&&route.includes('d.branch_id')],
 ['external non-cash methods require payment evidence',route.includes('External payment/reference evidence is required')],
 ['charge-account buyout respects customer eligibility and credit limit',route.includes('customer_type')&&route.includes('account_blocked')&&route.includes('credit_limit')],
 ['exact physical asset is removed from branch inventory',route.includes("'rental_active_buyout'")&&route.includes('UPDATE branch_inventory SET stock_qty=stock_qty-1')],
 ['inventory cost removal uses tracked valuation before acquisition fallback',route.includes('valueStockAdjustment')&&route.includes('tracked_inventory_pool')&&route.includes('complete_asset_acquisition_evidence')],
 ['buyout posts sale revenue rental adjustment deposit release and tax accounting',route.includes("code:'4000'")&&route.includes("code:'4200'")&&route.includes("code:'2200'")&&route.includes("code:'2100'")],
 ['sold cost posts COGS only with defensible evidence',route.includes("sourceType:'rental_active_buyout_cogs'")&&route.includes("code:'5000'")&&route.includes("code:'1200'")&&route.includes('blocked_missing_cost_evidence')],
 ['buyout is not falsely recorded as a physical return',route.includes("quantity_sold=COALESCE(quantity_sold,0)+1")&&route.includes("status='buyout_closed'")&&route.includes('sold_via_active_buyout')],
 ['asset and serial permanently become sold',route.includes("UPDATE rental_assets SET status='sold'")&&route.includes("UPDATE inventory_serials SET status='sold'")],
 ['fleet management UI exposes retirement reactivation sale and active buyout',ui.includes('Retire from rental')&&ui.includes('Return to rental')&&ui.includes('Sell fleet asset')&&ui.includes('Customer buyout')],
 ['fleet UI shows lifetime economic evidence',ui.includes('Lifetime contribution')&&ui.includes('Return on acquisition')&&ui.includes('Acquisition cost')],
 ['active buyout UI previews current combined settlement before posting',ui.includes('Calculate combined settlement')&&ui.includes('/active-buyout-quote')&&ui.includes('Deposit applied')&&ui.includes('Due now')],
 ['fleet UI is injected into native rental workspace',ui.includes('#tt-rentals-workspace .tt-rent__toolbar')&&ui.includes('Fleet management')],
 ['fleet UI is actually deferred-loaded by shell',deferred.includes('/rental-fleet-management.js')]
];
let failed=0;for(const [name,ok]of checks){console.log(`${ok?'PASS':'FAIL'} Active rental buyout/fleet UI: ${name}`);if(!ok)failed++;}if(failed){console.error(`Active rental buyout/fleet UI contract FAILED (${failed}/${checks.length} failed).`);process.exit(1)}console.log(`Active rental buyout/fleet UI contract OK (${checks.length} checks).`);
