'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const ui=read('public/rentals-workspace.js'),css=read('public/rentals-workspace.css'),route=read('routes/rental-missing-asset-disposition.js'),guard=read('routes/rental-loss-prevention.js'),shell=read('public/app-shell.js'),server=read('server.js');
new vm.Script(ui,{filename:'rentals-workspace.js'});new vm.Script(route,{filename:'rental-missing-asset-disposition.js'});
const checks=[
 ['native shell loads rental workspace',shell.includes("'rentals-workspace':['/rentals-workspace.css','/rentals-workspace.js','TotalToolsRentalsWorkspace']")],
 ['rental detail loads missing-asset cases',ui.includes('/api/rentals/missing-assets?agreement_id=')],
 ['item lifecycle visibly separates physical returns from missing units',ui.includes('physically returned')&&ui.includes('quantity_missing')&&ui.includes('unresolved')],
 ['mandatory accessories remain visible in the same accountability workflow',ui.includes('Required accessory')&&!ui.includes("filter(i=>i.parent_item_id==null)")],
 ['active issued inventory exposes Declare missing action',ui.includes('data-declare-missing')&&ui.includes("['active','awaiting_issue']")],
 ['declaration captures quantity reason evidence and proposed recovery',ui.includes('evidence_reference')&&ui.includes('proposed_customer_charge')&&ui.includes('Submit for review')],
 ['UI explicitly states missing disposition is not an ordinary return',ui.includes('This is not a return.')&&ui.includes('Missing items are never processed as normal returns.')],
 ['ordinary return backend also fails closed for missing/lost assets',guard.includes('rental_missing_asset_disposition_required')&&guard.includes('missingLike(incomingCondition)')],
 ['pending disposition exposes management review and rejection',ui.includes('data-approve-missing')&&ui.includes('data-reject-missing')&&ui.includes('/approve')&&ui.includes('/reject')],
 ['approval captures independent financial PIN and recovery decision',ui.includes('financial_authorizer_pin')&&ui.includes('approved_customer_charge')&&ui.includes('customer_charge_reason')],
 ['recovery status and inventory loss remain visible',ui.includes('charge_status')&&ui.includes('inventory_loss_value')&&ui.includes('waived_amount')],
 ['pending recovery uses dedicated collect-charge path',ui.includes("/collect-charge")&&ui.includes('data-collect-missing')],
 ['cash recovery resolves employee open drawer evidence',ui.includes('/api/drawers/sessions?status=open')&&ui.includes('drawer_session_id')&&ui.includes('employee_id')],
 ['backend collection enforces cashier drawer and branch ownership',route.includes('Cash collection requires the cashier and an open drawer session.')&&route.includes('The selected drawer is not an open drawer for this cashier and rental branch.')],
 ['backend posts a dedicated missing-asset recovery transaction',route.includes("'rental_missing_asset'")&&route.includes('Missing Rental Asset —')&&route.includes("charge_status='collected'")],
 ['credit recovery is posted to customer account rather than cash drawer',route.includes("if(method==='credit')")&&route.includes('account_balance=account_balance+?')],
 ['missing asset route is mounted before ordinary rentals',server.indexOf("require('./routes/rental-missing-asset-disposition')")>=0&&server.indexOf("require('./routes/rental-missing-asset-disposition')")<server.indexOf("require('./routes/rentals')")],
 ['modal UX is bounded and mobile responsive rather than obscuring the workspace',css.includes('.tt-rent__modal')&&css.includes('max-height:calc(100dvh - 32px)')&&css.includes('@media(max-width:900px)')],
 ['missing asset cases have distinct visual treatment',css.includes('.tt-rent__missing-card')&&css.includes('.tt-rent__item.has-missing')],
 ['UI never calls ordinary rental return endpoint to declare a missing asset',!ui.includes("/return`,{method:'PATCH'")&&!ui.includes('/return",{method:"PATCH"')]
];
let failed=0;for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Rental missing-asset UI: ${name}`);if(!ok)failed++;}
if(failed){console.error(`Rental missing-asset UI contract FAILED (${failed}/${checks.length} failed).`);process.exit(1);}console.log(`Rental missing-asset UI contract OK (${checks.length} checks).`);
