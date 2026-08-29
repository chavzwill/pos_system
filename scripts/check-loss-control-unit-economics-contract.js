'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const unit=read('routes/loss-control-unit-economics.js'),trace=read('routes/inventory-traceability.js');
new vm.Script(unit,{filename:'unit economics intelligence'});
const checks=[
 ['unit economics is mounted under loss control',trace.includes("router.use('/loss-control',require('./loss-control-unit-economics'))")],
 ['reports permission protects unit economics',unit.includes("router.use(requirePermission('reports'))")],
 ['service jobs include parts revenue and cost evidence',unit.includes('work_order_items')&&unit.includes('parts_cost')&&unit.includes('parts_revenue')],
 ['technician direct labor uses time entries and effective pay rates',unit.includes('work_order_task_time_entries')&&unit.includes('technician_pay_rates')&&unit.includes('effective_from<=date(te.started_at)')],
 ['service concessions reduce value only after application',unit.includes("status='approved' AND applied_transaction_id IS NOT NULL")],
 ['service refunds reduce value only after settlement',unit.includes("status='settled'")&&unit.includes('service_refunds')],
 ['service contribution requires both parts and labor cost evidence',unit.includes('partsCostComplete&&laborCostComplete')&&unit.includes('evidenced_contribution')],
 ['missing service cost evidence is surfaced rather than guessed',unit.includes('missing_evidence')&&unit.includes('part_cost_evidence')&&unit.includes('technician_pay_rate_evidence')],
 ['rental product economics uses agreement item rental-fee evidence',unit.includes('rental_agreement_items')&&unit.includes('core_rental_revenue')],
 ['rental ROI is explicitly withheld without acquisition and maintenance evidence',unit.includes('asset_acquisition_cost_snapshot')&&unit.includes('asset_specific_maintenance_cost')&&unit.includes('lifetime ROI is intentionally not claimed')],
 ['catalog cost is not mislabeled as rental acquisition cost',unit.includes('does not call current catalog cost an acquisition-cost snapshot')],
 ['unit economics is direct economics not audited net profit',unit.includes('not audited net profit')],
 ['unit economics performs no autonomous mutation',unit.includes('automatic_actions:false')&&!unit.includes('UPDATE products SET')&&!unit.includes('INSERT INTO purchase_orders')&&!unit.includes('INSERT INTO journal_entries')]
];
let failed=0;for(const [name,ok]of checks){console.log(`${ok?'PASS':'FAIL'} Unit economics: ${name}`);if(!ok)failed++;}if(failed){console.error(`Unit economics contract FAILED (${failed}/${checks.length} failed).`);process.exit(1)}console.log(`Unit economics contract OK (${checks.length} checks).`);
