'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const route=read('routes/rental-asset-lifetime-economics.js');
const ui=read('public/rental-fleet-management.js');
new vm.Script(route,{filename:'rental-asset-lifetime-economics.js'});
new vm.Script(ui,{filename:'rental-fleet-management.js'});
const checks=[
  ['direct-use receipts and issued stock both affect asset operating cost',route.includes("source_type IN ('internal_consumption','purchase_receipt')")&&route.includes('direct_received_cost')&&route.includes('internal_consumed_cost')],
  ['asset contribution subtracts complete allocated operating cost',route.includes('actual_operating_cost')&&route.includes('revenue+recoveries+disposal-acq-maintenance-allocatedConsumption-otherCosts')],
  ['observed utilization is derived from allocation time',route.includes('rented_hours')&&route.includes('observed_utilization_pct')&&route.includes('aa.released_at')],
  ['economic health exposes deterministic thresholds and reasons',route.includes('economicHealth')&&route.includes('watch_cost_to_revenue_pct')&&route.includes('stressed_cost_to_revenue_pct')&&route.includes('reasons')],
  ['underutilization requires minimum service age',route.includes('underutilized_min_age_days:180')&&route.includes('ageDays>=180')],
  ['replacement assessment persists explicit evidence',route.includes('rental_asset_replacement_assessments')&&route.includes('evidence_ref TEXT NOT NULL')],
  ['comparison uses trailing 365-day current evidence',route.includes("datetime('now','-365 days')")&&route.includes('current_trailing_evidence')],
  ['replacement economics use entered estimates instead of catalog price',route.includes('replacement_expected_annual_revenue')&&route.includes('replacement_expected_annual_maintenance')&&!route.includes('p.cost')],
  ['comparison remains advisory and creates no purchase order',route.includes('advisory:true')&&route.includes('No repair, sale, disposal or purchase action is automatic')&&!route.includes('INSERT INTO purchase_orders')],
  ['fleet UI shows utilization and operating cost ratio',ui.includes('Observed utilization')&&ui.includes('Operating cost / revenue')],
  ['fleet UI explains economic health reasons',ui.includes('Economic health')&&ui.includes('economic_health?.reasons')],
  ['fleet UI exposes repair vs replace workflow',ui.includes('data-replace')&&ui.includes('Repair vs replace')&&ui.includes('/replacement-assessments')],
  ['repair replace form requires quote evidence',ui.includes('Evidence reference')&&ui.includes('repair_estimate')&&ui.includes('replacement_cost')],
  ['repair replace result labels the signal advisory context',ui.includes('This signal compares documented trailing evidence')&&ui.includes('Contribution difference')]
];
let failed=0;
for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Rental profitability: ${name}`);if(!ok)failed++;}
if(failed){console.error(`Rental profitability contract FAILED (${failed}/${checks.length} failed).`);process.exit(1);}
console.log(`Rental profitability contract OK (${checks.length} checks).`);
