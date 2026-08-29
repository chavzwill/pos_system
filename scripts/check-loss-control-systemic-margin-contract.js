'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const systemic=read('routes/loss-control-systemic-margin-intelligence.js'),trace=read('routes/inventory-traceability.js');
new vm.Script(systemic,{filename:'systemic margin intelligence'});
const checks=[
 ['systemic intelligence is mounted under loss control',trace.includes("router.use('/loss-control',require('./loss-control-systemic-margin-intelligence'))")],
 ['systemic intelligence requires reports permission',systemic.includes("router.use(requirePermission('reports'))")],
 ['margin overrides are sourced from authoritative override evidence',systemic.includes('retail_margin_override_events')&&systemic.includes('projected_gross_margin')],
 ['service concessions are included',systemic.includes("'service_concession'")&&systemic.includes('service_concessions')],
 ['post-payment service refunds are included',systemic.includes("'service_refund'")&&systemic.includes('service_refunds')],
 ['promotion exposure is included without automatically calling it realized loss',systemic.includes("'promotion_discount'")&&systemic.includes('authoritative_discount')&&systemic.includes('0 realized_loss')],
 ['inventory writeoffs use tracked valuation only',systemic.includes('COALESCE(w.tracked_value,0) realized_loss')&&!systemic.includes('w.total_value')],
 ['product erosion uses preserved margin line evidence',systemic.includes('evidence.lines')&&systemic.includes('line.line_cost')&&systemic.includes('line.line_gross')],
 ['product erosion includes direct writeoff product identity',systemic.includes('w.product_id')&&systemic.includes('productErosion')],
 ['supplier erosion uses procurement outcome snapshots',systemic.includes('procurement_outcome_snapshots')&&systemic.includes('cost_variance')],
 ['supplier attribution refuses arbitrary allocation across mixed suppliers',systemic.includes('supplier_count=1')&&systemic.includes("supplier_name:x.supplier_count===1?x.supplier_names:'Mixed sourcing'")],
 ['procurement savings remain separate from cost overruns',systemic.includes('realized_cost_overrun')&&systemic.includes('realized_savings')],
 ['current period is compared with the preceding equal window',systemic.includes('collect(days,days)')&&systemic.includes('comparison_window_days:days')],
 ['branch ratios use posted positive completed transaction value',systemic.includes('posted_positive_transaction_value')&&systemic.includes("status='completed'")],
 ['branch ratio is not represented as audited profit',systemic.includes('not audited accounting revenue or net profit')],
 ['employee cross-control breadth is exposed',systemic.includes('cross_control_employee_patterns')&&systemic.includes('control_types>=2')],
 ['employee patterns remain non-accusatory',systemic.includes('not a misconduct finding')],
 ['repeat customer concession/refund patterns are exposed',systemic.includes('repeat_customer_patterns')&&systemic.includes('Repeated customer')],
 ['realized loss and at-risk value stay separate',systemic.includes('evidence_backed_realized_loss')&&systemic.includes('at_risk_value')],
 ['systemic intelligence explicitly refuses unsupported full net contribution claims',systemic.includes('does not claim full accounting net contribution')],
 ['systemic intelligence performs no autonomous mutation',systemic.includes('automatic_actions:false')&&!systemic.includes('UPDATE products SET')&&!systemic.includes('UPDATE customers SET')&&!systemic.includes('INSERT INTO purchase_orders')]
];
let failed=0;for(const [name,ok]of checks){console.log(`${ok?'PASS':'FAIL'} Systemic margin intelligence: ${name}`);if(!ok)failed++;}if(failed){console.error(`Systemic margin intelligence contract FAILED (${failed}/${checks.length} failed).`);process.exit(1)}console.log(`Systemic margin intelligence contract OK (${checks.length} checks).`);
