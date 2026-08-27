'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..');const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const loss=read('routes/loss-control-intelligence.js'),trace=read('routes/inventory-traceability.js'),cycle=read('routes/cycle-count-hardening.js'),writeoffs=read('routes/inventory-writeoffs.js'),returns=read('routes/retail-return-hardening.js'),refunds=read('routes/retail-refund-settlement.js'),drawers=read('routes/drawers.js'),procurement=read('routes/procurement-outcome-intelligence.js'),costs=read('routes/retail-cost-integrity.js');
for(const [name,src] of [['loss control',loss],['refund settlement',refunds]])new vm.Script(src,{filename:name});
const checks=[
 ['loss control is reports-permission gated',loss.includes("router.use(requirePermission('reports'))")],
 ['loss cases are durable and uniquely keyed',loss.includes('CREATE TABLE IF NOT EXISTS loss_control_cases')&&loss.includes('signal_key TEXT NOT NULL UNIQUE')],
 ['loss case lifecycle has append-only events',loss.includes('loss_control_case_events')&&(loss.includes("'detected',actor")||loss.includes("'detected',actor||null"))],
 ['cycle-count shortages are evidence source',loss.includes("signal_type:'cycle_count_shortage'")&&loss.includes("cc.status='committed'")&&cycle.includes('cycle_count_items')],
 ['cycle-count shortage cost basis is disclosed',loss.includes("cost_basis:'Current catalog cost")],
 ['inventory write-offs are included as realized loss',loss.includes("signal_type:'approved_writeoff'")&&loss.includes("w.status='approved'")&&writeoffs.includes('tracked_value')],
 ['write-offs prefer tracked valuation evidence before catalog fallback',loss.includes("tracked?'Tracked write-off valuation evidence':'Current catalog cost fallback'")],
 ['retail cost integrity provides historical sale-cost snapshots',costs.includes('unit_cost_at_sale')],
 ['below-cost sales prefer historical cost snapshot over mutable catalog cost',loss.includes("COALESCE(ti.unit_cost_at_sale,p.cost,0)")&&loss.includes("'sale_cost_snapshot'")],
 ['below-cost sales allocate only posted transaction-level discount',loss.includes('allocated_order_discount')&&loss.includes('effective_revenue')&&loss.includes('does not currently subtract it from posted sale totals')],
 ['voided and held transactions are excluded from pricing leakage',loss.includes("t.status='completed'")],
 ['procurement leakage uses actual-vs-approved outcome variance',loss.includes("signal_type:'adverse_procurement_variance'")&&loss.includes('cost_variance')&&procurement.includes('expected_landed_cost')&&procurement.includes('actual_landed_cost')],
 ['procurement signal key is stable per sourcing review',loss.includes("signalKey(['procurement_variance',o.review_id])")],
 ['cash shortage reconciles opening float and cash sales',loss.includes('opening_float')&&loss.includes('cash_sales')&&loss.includes('cash_counted')],
 ['cash refunds reduce expected drawer cash where evidence exists',loss.includes('retail_refund_settlement_legs')&&loss.includes('cash_refunds')],
 ['cash refunds now persist explicit drawer-session evidence',refunds.includes('drawer_session_id INTEGER REFERENCES drawer_sessions(id)')&&refunds.includes('resolveRefundDrawer')],
 ['cash refund payout requires an open employee drawer',refunds.includes('Open the correct cash drawer before settling a cash refund')&&refunds.includes("status='open'"))],
 ['loss control prefers explicit refund drawer linkage and preserves legacy fallback',loss.includes('rs.drawer_session_id=ds.id')&&loss.includes('legacy unlinked refunds fall back')],
 ['cash shortage language explicitly avoids theft conclusion',loss.includes('does not by itself establish theft')],
 ['return concentration is treated as risk not detected loss',loss.includes("signal_type:'return_value_concentration'")&&loss.includes('estimated_loss:0')&&loss.includes('at_risk_value')],
 ['return concentration compares returns against same employee and branch sales',loss.includes('(r.branch_id IS NULL OR t.branch_id=r.branch_id)')],
 ['return concentration signal is stable per employee and branch',loss.includes("signalKey(['return_concentration',x.employee_id,x.branch_id])")],
 ['return risk language rejects misconduct inference',loss.includes('not proof of improper behavior')],
 ['dead stock quantifies working-capital exposure',loss.includes("signal_type:'dead_stock_capital'")&&loss.includes("category:'working_capital'")&&loss.includes('stale_days_threshold')],
 ['dead stock recommends transfer/bundle/reorder suppression before write-off',loss.includes('transfer, bundle, markdown, supplier return or reorder suppression')],
 ['scanner only records human-review cases',loss.includes("router.post('/scan'")&&loss.includes('no disciplinary, purchasing, inventory, refund, or accounting action was performed automatically')],
 ['loss module contains no autonomous purchase order creation',!loss.includes('INSERT INTO purchase_orders')],
 ['loss module contains no stock mutation',!loss.includes('UPDATE products SET stock_qty')&&!loss.includes('UPDATE branch_inventory SET stock_qty')],
 ['loss module contains no employee discipline mutation',!loss.includes('UPDATE employees SET active')&&!loss.includes('DELETE FROM employees')],
 ['summary separates detected loss from at-risk value',loss.includes('detected_loss')&&loss.includes('at_risk_value')&&loss.includes('it is not assumed to be lost')],
 ['summary tracks recovered value and unresolved cases',loss.includes('recovered_value')&&loss.includes("status NOT IN ('resolved','dismissed')")],
 ['resolution requires a documented note',loss.includes("nextStatus==='resolved'&&!note")&&loss.includes('requires a resolution_note')],
 ['case evidence is persisted as JSON',loss.includes('evidence_json')&&loss.includes('JSON.stringify(s.evidence||{})')],
 ['loss control is mounted in inventory traceability',trace.includes("router.use('/loss-control',require('./loss-control-intelligence'))")],
 ['cash evidence source supports split tenders',drawers.includes('transaction_payments')&&drawers.includes('split-tender')],
 ['return evidence source preserves original transaction link',returns.includes('original_transaction_id')&&returns.includes('retail_return_allocations')]
];
let failed=0;for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Loss control: ${name}`);if(!ok)failed++;}
if(failed){console.error(`Loss control contract FAILED (${failed}/${checks.length} failed).`);process.exit(1);}console.log(`Loss control contract OK (${checks.length} checks).`);
