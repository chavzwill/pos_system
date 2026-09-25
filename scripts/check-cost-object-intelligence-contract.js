'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const route=read('routes/cost-allocations.js');
const ui=read('public/index.html');
new vm.Script(route,{filename:'cost-allocations.js'});
const checks=[
 ['cost economics endpoint exists',route.includes("router.get('/economics'" )],
 ['cost trend separates 30-day and prior-30-day windows',route.includes("datetime('now','-30 days')")&&route.includes("datetime('now','-60 days')")],
 ['actual cost includes receipts and internal consumption only',route.includes("source_type IN ('purchase_receipt','internal_consumption')")],
 ['cost trend flags rising improving stable and evidence gaps',route.includes("'cost_rising'")&&route.includes("'cost_improving'")&&route.includes("'stable'")&&route.includes("'evidence_gap'")],
 ['vehicle economics include dispatch context',route.includes('dispatch_vehicles')&&route.includes('completed_jobs')&&route.includes('exception_jobs')],
 ['vehicle efficiency normalizes cost by completed dispatch output',route.includes('allocated_cost_per_completed_dispatch')&&route.includes('recent_cost_per_output')&&route.includes('prior_cost_per_output')&&route.includes('efficiency_worsening')&&route.includes('efficiency_improving')],
 ['branch efficiency normalizes cost by completed transactions and recorded sales',route.includes('recent_cost_per_transaction')&&route.includes('recent_cost_to_recorded_sales_pct')&&route.includes("FROM transactions WHERE branch_id=?")],
 ['raw spend trend remains separate from efficiency trend',route.includes('cost_state:state')&&route.includes('context')&&ui.includes('Spend Trend')&&ui.includes('Efficiency')],
 ['branch and custom objects resolve native identities',route.includes("type==='branch'")&&route.includes("cost_objects WHERE id=? AND object_type=?")],
 ['methodology forbids invented profitability for non-rental targets',route.includes("no revenue or profit is invented")],
 ['UI exposes cost intelligence section',ui.includes('Cost intelligence')&&ui.includes('cost-econ-type')],
 ['UI exposes vehicle building department equipment branch project and overhead filters',ui.includes('Vehicles')&&ui.includes('Buildings')&&ui.includes('Departments')&&ui.includes('Equipment')&&ui.includes('Branches')&&ui.includes('Projects')&&ui.includes('General overhead')],
 ['UI loads cost economics endpoint',ui.includes('/cost-allocations/economics?target_type=')],
 ['UI surfaces 30-day prior-period trend and evidence',ui.includes('30d Cost')&&ui.includes('Prior 30d')&&ui.includes('Evidence')],
 ['UI does not claim profitability in generalized cost view',ui.includes('Profit is only shown where real revenue attribution exists.')]
];
let failed=0;for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Cost object intelligence: ${name}`);if(!ok)failed++;}
if(failed){console.error(`Cost object intelligence contract FAILED (${failed}/${checks.length} failed).`);process.exit(1);}console.log(`Cost object intelligence contract OK (${checks.length} checks).`);
