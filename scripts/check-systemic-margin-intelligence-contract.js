'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const src=read('routes/loss-control-systemic-margin-intelligence.js'),trace=read('routes/inventory-traceability.js');
new vm.Script(src,{filename:'systemic margin intelligence'});
const checks=[
 ['mounted under Loss Control',trace.includes("router.use('/loss-control',require('./loss-control-systemic-margin-intelligence'))")],
 ['reports permission protects intelligence',src.includes("router.use(requirePermission('reports'))")],
 ['below-margin evidence uses authoritative margin override events',src.includes('retail_margin_override_events')&&src.includes('projected_gross_margin')],
 ['service concessions are included',src.includes('service_concessions')&&src.includes("'service_concession' event_type")],
 ['post-payment service refunds are included',src.includes('service_refunds')&&src.includes("'service_refund' event_type")],
 ['promotion exposure is included separately',src.includes('retail_promotion_control_events')&&src.includes("'promotion_discount' event_type")],
 ['writeoffs use tracked inventory valuation',src.includes('COALESCE(w.tracked_value,0) realized_loss')],
 ['realized loss and at-risk value remain distinct',src.includes('evidence_backed_realized_loss')&&src.includes('at_risk_value')],
 ['branch concentration is surfaced',src.includes('by_branch')&&src.includes("aggregate(events,'branch_id'")],
 ['employee workflow concentration is surfaced non-accusatorily',src.includes('by_employee_workflow')&&src.includes('not a misconduct finding')],
 ['customer concentration is surfaced',src.includes('by_customer')&&src.includes("aggregate(events,'customer_id'")],
 ['full accounting contribution is not falsely claimed',src.includes('does not yet claim full accounting net contribution')],
 ['no autonomous actions are exposed',src.includes('automatic_actions:false')],
 ['intelligence performs no stock/payment/account mutations',!src.includes('UPDATE products')&&!src.includes('UPDATE branch_inventory')&&!src.includes('INSERT INTO transactions')&&!src.includes('UPDATE customers SET account_balance')]
];
let failed=0;for(const [name,ok]of checks){console.log(`${ok?'PASS':'FAIL'} Systemic margin intelligence: ${name}`);if(!ok)failed++;}if(failed){console.error(`Systemic margin intelligence contract FAILED (${failed}/${checks.length} failed).`);process.exit(1);}console.log(`Systemic margin intelligence contract OK (${checks.length} checks).`);
