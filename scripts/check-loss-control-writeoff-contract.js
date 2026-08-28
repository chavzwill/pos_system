'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const guard=read('routes/inventory-writeoff-financial-guard.js'),leaks=read('routes/loss-control-writeoff-leaks.js'),server=read('server.js'),trace=read('routes/inventory-traceability.js'),writeoffs=read('routes/inventory-writeoffs.js');
for(const [name,src] of [['write-off financial guard',guard],['write-off loss intelligence',leaks]])new vm.Script(src,{filename:name});
const checks=[
 ['high-value guard is mounted before traceability and authoritative write-off routes',server.indexOf("require('./routes/inventory-writeoff-financial-guard')")>=0&&server.indexOf("require('./routes/inventory-writeoff-financial-guard')")<server.indexOf("require('./routes/inventory-writeoff-traceability-guard')")&&server.indexOf("require('./routes/inventory-writeoff-financial-guard')")<server.indexOf("require('./routes/inventory-writeoffs')")],
 ['high-value threshold is configurable',guard.includes('loss_control_high_value_writeoff_threshold')],
 ['material evidence threshold is independently configurable',guard.includes('loss_control_writeoff_evidence_threshold')],
 ['write-off value prefers tracked inventory pool evidence',guard.includes('inventory_cost_pools')&&guard.includes('current_tracked_inventory_pool')],
 ['catalog cost is only a fallback valuation basis',guard.includes('catalog_cost_fallback')],
 ['high-value approval requires an independent second financial authorizer',guard.includes('second, independent financial authorizer')&&guard.includes('reports_financial')],
 ['write-off creator cannot provide high-value financial authorization',guard.includes('created_by_employee_id')&&guard.includes('cannot provide its high-value financial authorization')],
 ['theft destruction and shrinkage require evidence',guard.includes("['theft','destruction','shrinkage']")&&guard.includes('incident, disposal, count, photo, document or investigation evidence reference')],
 ['generic placeholder evidence is rejected',guard.includes("'N/A'")&&guard.includes("'UNKNOWN'")&&guard.includes('meaningfulEvidence')],
 ['material high-value writeoffs require evidence even outside theft/destruction reasons',guard.includes('valuation.estimated_value+0.009>=evidenceThreshold')],
 ['financial authorization evidence is durable',guard.includes('inventory_writeoff_financial_approvals')&&guard.includes('financial_authorizer_employee_id')&&guard.includes('evidence_reference')],
 ['sensitive authorization fields are removed before authoritative approval',guard.includes('delete req.body.writeoff_financial_pin')&&guard.includes('delete req.body.writeoff_financial_reason')&&guard.includes('delete req.body.writeoff_evidence_reference')],
 ['existing write-off approval still requires independent operational approval',writeoffs.includes('Independent approval is required for inventory write-offs')],
 ['write-off loss intelligence is mounted under loss control',trace.includes("router.use('/loss-control',require('./loss-control-writeoff-leaks'))")],
 ['approved high-risk writeoffs are reviewed from posted evidence',leaks.includes("w.status='approved'")&&leaks.includes("high_risk_inventory_writeoff")],
 ['financial approval gaps are escalated',leaks.includes("writeoff_financial_approval_gap")&&leaks.includes("severity:missingFinancial?'critical'")],
 ['creator/approver concentration is detected',leaks.includes('inventory_writeoff_approval_pair_concentration')&&leaks.includes('approval_count')],
 ['pair concentration remains non-accusatory',leaks.includes('not a misconduct finding')],
 ['write-off scan does not autonomously mutate inventory or accounting',leaks.includes('No inventory, accounting, employee or approval record was changed automatically')],
 ['write-off intelligence requires reports permission',leaks.includes("router.use(requirePermission('reports'))")]
];
let failed=0;for(const [name,ok]of checks){console.log(`${ok?'PASS':'FAIL'} Write-off loss control: ${name}`);if(!ok)failed++;}if(failed){console.error(`Write-off loss-control contract FAILED (${failed}/${checks.length} failed).`);process.exit(1)}console.log(`Write-off loss-control contract OK (${checks.length} checks).`);
