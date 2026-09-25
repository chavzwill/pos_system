'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const route=read('routes/rental-asset-lifetime-economics.js');
const ui=read('public/rental-fleet-management.js');
new vm.Script(route,{filename:'rental-asset-lifetime-economics.js'});
new vm.Script(ui,{filename:'rental-fleet-management.js'});
const checks=[
 ['portfolio endpoint exists',route.includes("router.get('/portfolio'" )],
 ['portfolio excludes terminal ownership states',route.includes("a.status NOT IN ('sold','disposed','lost')")],
 ['attention bands are deterministic',route.includes("band='urgent_review'")&&route.includes("band='review'")&&route.includes("band='optimize'")&&route.includes("band='routine'")],
 ['negative contribution escalates attention',route.includes("evidenced_contribution||0)<0")],
 ['replacement signal participates in review band',route.includes("replacement_case_stronger")&&route.includes("latest_replacement_assessment")],
 ['portfolio exposes aggregate contribution revenue and operating cost',route.includes('total_lifetime_contribution')&&route.includes('total_rental_revenue')&&route.includes('total_operating_cost')],
 ['portfolio methodology forbids automatic actions',route.includes("automatic_actions:false")],
 ['fleet UI loads portfolio endpoint',ui.includes('/rental-economics/portfolio?')],
 ['fleet UI shows attention band per asset',ui.includes("a.attention?.band")],
 ['fleet UI exposes attention filter',ui.includes('tt-fleet-attention')&&ui.includes('urgent_review')&&ui.includes('optimize')],
 ['fleet UI shows management attention reasons',ui.includes('Management attention')&&ui.includes('a.attention?.reasons')],
 ['fleet UI preserves replacement evidence context',ui.includes('latest_replacement_assessment')&&ui.includes('contribution difference')]
];
let failed=0;for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Rental portfolio: ${name}`);if(!ok)failed++;}
if(failed){console.error(`Rental portfolio contract FAILED (${failed}/${checks.length} failed).`);process.exit(1);}console.log(`Rental portfolio contract OK (${checks.length} checks).`);
