'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const server=read('server.js');
const guard=read('routes/work-order-financial-runtime-guard.js');
const completion=read('routes/work-order-completion-hardening.js');
const quality=read('routes/repair-quality.js');
const workorders=read('routes/work-orders.js');
const accounting=read('routes/accounting-source-sync.js');
const helper=read('tests/repair-financial-runtime-helper.js');
const business=read('tests/business-integrity.spec.js');
for(const [name,src] of Object.entries({server,guard,completion,quality,workorders,accounting,helper,business})){
  const cleaned=src.replace(/^import .*$/mg,'').replace(/^export /mg,'');
  try{new vm.Script(cleaned,{filename:name});}catch(e){console.error(`FAIL Repair runtime prerequisite: syntax ${name}`);throw e;}
}
const checks=[
 ['repair financial guard mounted before completion and legacy work-order routes',server.indexOf("require('./routes/work-order-financial-runtime-guard')")<server.indexOf("require('./routes/work-order-completion-hardening')")&&server.indexOf("require('./routes/work-order-completion-hardening')")<server.indexOf("require('./routes/work-orders')")],
 ['cash guard covers assessment deposit and final payment',guard.includes('assessment-paid|deposit-paid|final-payment')&&guard.includes("control:'work_order_cash_drawer'")],
 ['cash guard requires same employee drawer',guard.includes('drawer.employee_id')&&guard.includes('employeeId')],
 ['cash guard requires same work-order branch',guard.includes('drawer.branch_id')&&guard.includes('wo.branch_id')],
 ['zero-value repair payment can proceed without drawer',guard.includes('if(amount<=0)return next()')],
 ['service evidence endpoint requires technician authority',guard.includes("router.patch('/:id/service-evidence',requirePermission('wo_technician')")],
 ['service evidence persists diagnosis and repair notes',guard.includes('UPDATE work_orders SET diagnosis=?,repair_notes=?')],
 ['completion requires diagnosis and repair notes',completion.includes("blockers.push('diagnosis_documented')")&&completion.includes("blockers.push('repair_notes_documented')")],
 ['completion requires tasks complete and attributed',completion.includes("blockers.push('all_tasks_complete')")&&completion.includes("blockers.push('all_tasks_attributed')")],
 ['completion requires latest QC pass',completion.includes("latestQc.result !== 'pass'")],
 ['database QC trigger independently blocks completion without pass',quality.includes('trg_work_order_completion_requires_quality')&&quality.includes("<> 'pass'")],
 ['QC pass requires readiness evidence',quality.includes("result==='pass'&&!readiness.readyForQc")],
 ['final release only occurs through final-payment path',workorders.includes("status = 'picked_up'")&&workorders.includes("router.patch('/:id/final-payment'")],
 ['accounting keeps assessment as service revenue',accounting.includes("sourceType:'repair_assessment'")&&accounting.includes("description:'Assessment service revenue'")],
 ['accounting keeps deposit as customer liability',accounting.includes("sourceType:'repair_deposit'")&&accounting.includes("code:'2200',debit:0,credit:depositPaid")],
 ['completed repair recognizes service revenue and remaining receivable',accounting.includes("sourceType:'repair_service'")&&accounting.includes("code:'1100',debit:expectedFinal")&&accounting.includes("code:'4100',debit:0,credit:serviceValue")],
 ['final payment clears repair receivable',accounting.includes("sourceType:'repair_final_payment'")&&accounting.includes("code:'1100',debit:0,credit:finalPaid")],
 ['runtime fixture rejects deposit cash without drawer',helper.includes("deposit-paid")&&helper.includes("work_order_cash_drawer")],
 ['runtime fixture records diagnosis task and QC',helper.includes('/service-evidence')&&helper.includes('/tasks')&&helper.includes('/repair-quality/work-orders/')],
 ['runtime fixture proves deposit liability service revenue AR and final clearing',helper.includes("source_type==='repair_deposit'")&&helper.includes("source_type==='repair_service'")&&helper.includes("source_type==='repair_final_payment'")],
 ['runtime fixture proves customer equipment repair history reaches picked_up',helper.includes('/history')&&helper.includes("r.status==='picked_up'")],
 ['business integrity release suite registers repair runtime certification',business.includes('registerRepairFinancialRuntimeCertification')]
];
let failed=0;for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Repair runtime prerequisite: ${name}`);if(!ok)failed++;}
if(failed){console.error(`Repair runtime prerequisite FAILED (${failed}/${checks.length} failed).`);process.exit(1);}
console.log(`Repair runtime prerequisite OK (${checks.length} checks). Repair end-to-end runtime proof is release-gated pending execution.`);
