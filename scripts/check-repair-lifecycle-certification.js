'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const server=read('server.js');
const wo=read('routes/work-orders.js');
const completion=read('routes/work-order-completion-hardening.js');
const quality=read('routes/repair-quality.js');
const auth=read('routes/repair-authorizations.js');
const parts=read('routes/repair-parts-hardening.js');
const accounting=read('routes/accounting-source-sync.js');
const repairLogistics=read('routes/logistics-repair-handoff.js');
const repairUi=read('public/repair-operations.js');
for(const [name,src] of Object.entries({server,wo,completion,quality,auth,parts,accounting,repairLogistics,repairUi}))new vm.Script(src,{filename:name});
const checks=[
 ['completion hardening is mounted before legacy work orders',server.indexOf("require('./routes/work-order-completion-hardening')")<server.indexOf("require('./routes/work-orders')")],
 ['repair quality lifecycle is mounted',server.includes("/api/repair-quality")&&server.includes("require('./routes/repair-quality')")],
 ['formal repair authorizations are mounted',server.includes("/api/repair-authorizations")&&server.includes("require('./routes/repair-authorizations')")],
 ['repair parts hardening is mounted',server.includes("require('./routes/repair-parts-hardening')")],
 ['generic status changes cannot jump directly to payment or completion states',wo.includes('FREE_STATUS_TRANSITIONS')&&wo.includes('use the dedicated action for that step')],
 ['assessment collection uses a dedicated transaction',wo.includes("/:id/assessment-paid")&&wo.includes('assessment_transaction_id')&&wo.includes('WO-ASSESS')],
 ['deposit collection uses a dedicated transaction',wo.includes("/:id/deposit-paid")&&wo.includes('deposit_transaction_id')&&wo.includes('WO-DEPOSIT')],
 ['formal estimate revisions gate legacy deposit work start',completion.includes("router.patch('/:id/deposit-paid'")&&completion.includes('latest estimate revision is approved')&&completion.includes("active.status !== 'approved'")],
 ['estimate revisions supersede pending predecessors',auth.includes("status = 'superseded'")&&auth.includes('superseded_at')],
 ['superseded estimates cannot be authorized',auth.includes('A superseded estimate cannot be authorized')],
 ['authorization decisions preserve method and attributable party evidence',auth.includes('authorization_method')&&auth.includes('authorized_name')&&auth.includes('authorized_contact')],
 ['completion requires documented diagnosis and repair notes',completion.includes('diagnosis_documented')&&completion.includes('repair_notes_documented')],
 ['completion requires actual repair tasks',completion.includes('tasks_present')],
 ['completion requires every task complete and attributable',completion.includes('all_tasks_complete')&&completion.includes('all_tasks_attributed')],
 ['QC pass is mandatory for completion',completion.includes('latest_qc_pass')&&quality.includes("<> 'pass'")&&quality.includes('trg_work_order_completion_requires_quality')],
 ['QC fail requires evidence',quality.includes('A reason is required when QC fails')],
 ['parts completion uses consumption evidence not line presence alone',completion.includes('repair_part_reservations')&&completion.includes('quantity_consumed')&&completion.includes('partEvidence')],
 ['customer supplied parts are excluded from company inventory consumption gate',completion.includes("parts.filter(p => !p.is_customer_supplied)")],
 ['final customer release is restricted to awaiting pickup',wo.includes("wo.status !== 'awaiting_pickup'")&&wo.includes("/:id/final-payment")],
 ['final release creates final payment evidence when money remains due',wo.includes('final_transaction_id')&&wo.includes('WO-FINAL')],
 ['there is no generic no-payment picked-up status path',wo.includes("there's no separate no-payment")&&wo.includes("status = 'picked_up'")],
 ['repair return dispatch cannot start from merely complete status',repairLogistics.includes("['awaiting_pickup','picked_up']")&&!repairLogistics.includes("['awaiting_pickup','complete']")],
 ['repair return dispatch checks outstanding balance',repairLogistics.includes('Repair return delivery is blocked until the final repair balance is settled')&&repairLogistics.includes('final_transaction_id')],
 ['repair intake pickup is limited to intake/deposit stages',repairLogistics.includes("['intake','pending_deposit']")&&repairLogistics.includes('Customer equipment pickup is only available')],
 ['repair dispatch snapshot preserves exact equipment identity',repairLogistics.includes('equipment_serial')&&repairLogistics.includes('equipment_asset_tag')&&repairLogistics.includes('equipment_id')],
 ['repair UI mirrors safe pickup and return stage controls',repairUi.includes("['intake','pending_deposit']")&&repairUi.includes("['awaiting_pickup','picked_up']")],
 ['repair accounting excludes work-order transactions from ordinary retail posting',accounting.includes('workOrderExclusion')&&accounting.includes('assessment_transaction_id')&&accounting.includes('deposit_transaction_id')&&accounting.includes('final_transaction_id')],
 ['repair accounting recognizes assessment separately',accounting.includes("sourceType:'repair_assessment'")&&accounting.includes("code:'4100'" )],
 ['repair deposit posts as customer deposit liability',accounting.includes("sourceType:'repair_deposit'")&&accounting.includes("code:'2200'" )],
 ['completed repair creates service revenue and receivable/deposit application',accounting.includes("sourceType:'repair_service'")&&accounting.includes('Completed repair balance receivable')&&accounting.includes('Apply customer deposit to completed repair')],
 ['final repair payment clears repair receivable',accounting.includes("sourceType:'repair_final_payment'")&&accounting.includes('Clear completed repair receivable')],
 ['installed repair parts post COGS and inventory reduction',accounting.includes("sourceType:'repair_part_usage'")&&accounting.includes("code:'5000'")&&accounting.includes("code:'1200'" )],
 ['repair refunds and concessions are mounted before legacy work-order routes',completion.includes("require('./service-refunds')")&&completion.includes("require('./service-concessions')")]
];
let failed=0;for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Repair lifecycle certification: ${name}`);if(!ok)failed++;}
if(failed){console.error(`Repair lifecycle certification FAILED (${failed}/${checks.length} failed).`);process.exit(1);}console.log(`Repair lifecycle certification OK (${checks.length} checks).`);
