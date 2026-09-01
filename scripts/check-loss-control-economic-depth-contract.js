'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const snapshot=read('routes/retail-cost-snapshot.js'),uom=read('routes/retail-uom-guard.js'),cogs=read('routes/accounting-retail-cogs-sync.js'),depth=read('routes/loss-control-economic-depth.js'),unit=read('routes/loss-control-unit-economics.js'),trace=read('routes/inventory-traceability.js');
for(const [name,src] of [['retail cost snapshot',snapshot],['accounting retail cogs',cogs],['economic depth',depth],['unit economics',unit]])new vm.Script(src,{filename:name});
const checks=[
 ['sale-time cost snapshot table is durable',snapshot.includes('retail_transaction_cost_snapshots')&&snapshot.includes('UNIQUE(transaction_id,line_index)')],
 ['tracked branch cost pool is preferred',snapshot.includes('inventory_cost_pools')&&snapshot.includes('current_tracked_inventory_pool_at_sale')],
 ['catalog cost fallback is preserved only as partial evidence',snapshot.includes("basis:'catalog_cost_snapshot_at_sale'")&&snapshot.includes("grade:'partial'")&&snapshot.includes('auto_post_eligible:0')],
 ['missing cost fails evidence closed',snapshot.includes("basis:'cost_evidence_missing'")&&snapshot.includes("grade:'blocked'")],
 ['cost snapshot is mounted after normalized pricing controls',uom.includes("router.use(require('./retail-cost-snapshot'))")&&uom.indexOf('retail-cost-snapshot')>uom.indexOf('retail-margin-protection')],
 ['sale-time cost evidence finalizes only after successful transaction',snapshot.includes('res.statusCode>=200&&res.statusCode<300&&payload?.id')],
 ['COGS sync is mounted and reachable',trace.includes("router.use('/accounting-retail-cogs',require('./accounting-retail-cogs-sync'))")],
 ['COGS auto-post requires every line to be complete',cogs.includes('eligible!==lineCount')&&cogs.includes('complete tracked inventory cost evidence for every sold line')],
 ['COGS uses separate idempotent source type',cogs.includes("sourceType:'retail_cogs'")&&cogs.includes("code:'5000'")&&cogs.includes("code:'1200'")],
 ['partial catalog snapshots are never auto-posted as authoritative COGS',cogs.includes('Partial catalog snapshots remain historical evidence but are not auto-posted as authoritative COGS')],
 ['economic depth is mounted under loss control',trace.includes("router.use('/loss-control',require('./loss-control-economic-depth'))")],
 ['economic depth requires reports permission',depth.includes("router.use(requirePermission('reports'))")],
 ['profitability is calculated only for fully complete cost transactions',depth.includes('fully_complete_cost')&&depth.includes('complete===lines')],
 ['economic depth exposes evidence grading',depth.includes('evidence_grade')&&depth.includes("coverage>=95?'complete'")&&depth.includes("coverage>=50?'partial':'limited'")],
 ['equal-window trend comparison exists',depth.includes('retailEvidence(windowDays,windowDays)')&&depth.includes('gross_profit_change')],
 ['branch profitability exposes cost evidence coverage',depth.includes('cost_evidence_coverage_pct')&&depth.includes('by_branch')],
 ['customer contribution uses only evidenced retail gross profit',depth.includes('by_customer_evidenced_retail')&&depth.includes('x.fully_complete_cost')],
 ['historical boundary forbids retroactive mutable cost guessing',depth.includes('Older transactions are not retroactively assigned today')],
 ['economic depth does not claim net profit',depth.includes('It is not net profit')],
 ['unit economics is mounted under loss control',trace.includes("router.use('/loss-control',require('./loss-control-unit-economics'))")],
 ['service jobs combine parts and technician direct-cost evidence',unit.includes('work_order_items')&&unit.includes('work_order_task_time_entries')&&unit.includes('technician_pay_rates')],
 ['technician cost uses rate effective at the time entry',unit.includes('effective_from<=date(te.started_at)')&&unit.includes('effective_to>=date(te.started_at)')],
 ['service concessions count only when applied',unit.includes("status='approved' AND applied_transaction_id IS NOT NULL")],
 ['service refunds count only when settled',unit.includes("status='settled'")&&unit.includes('service_refunds')],
 ['service contribution requires complete parts and labor evidence',unit.includes('partsCostComplete&&laborCostComplete')&&unit.includes('evidenced_contribution')],
 ['missing service evidence is surfaced instead of invented',unit.includes('missing_evidence')&&unit.includes('part_cost_evidence')&&unit.includes('technician_pay_rate_evidence')],
 ['rental economics uses real rental fee evidence',unit.includes('rental_agreement_items')&&unit.includes('core_rental_revenue')],
 ['rental lifetime ROI remains blocked without acquisition and maintenance evidence',unit.includes('asset_acquisition_cost_snapshot')&&unit.includes('asset_specific_maintenance_cost')&&unit.includes('lifetime ROI is intentionally not claimed')],
 ['current catalog cost is not mislabeled as rental acquisition cost',unit.includes('does not call current catalog cost an acquisition-cost snapshot')],
 ['unit economics does not claim audited net profit',unit.includes('not audited net profit')],
 ['economic intelligence performs no automatic mutation',depth.includes('automatic_actions:false')&&unit.includes('automatic_actions:false')&&!depth.includes('UPDATE customers SET')&&!unit.includes('UPDATE products SET')&&!unit.includes('INSERT INTO purchase_orders')&&!unit.includes('INSERT INTO journal_entries')]
];
let failed=0;for(const [name,ok]of checks){console.log(`${ok?'PASS':'FAIL'} Economic depth: ${name}`);if(!ok)failed++;}if(failed){console.error(`Economic depth contract FAILED (${failed}/${checks.length} failed).`);process.exit(1)}console.log(`Economic depth contract OK (${checks.length} checks).`);
