'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const financial=read('routes/inventory-writeoff-financial-guard.js');
const trace=read('routes/inventory-writeoff-traceability-guard.js');
const core=read('routes/inventory-writeoffs.js');
const errors=read('lib/inventory-writeoff-errors.js');
for(const [name,src] of Object.entries({financial,trace,core,errors}))new vm.Script(src,{filename:name});
const checks=[
 ['financial guard prepares normalized request context',financial.includes('req.writeoffFinancialAuthorization=')],
 ['financial guard removes PIN before authoritative route',financial.includes('delete req.body.writeoff_financial_pin')],
 ['financial guard does not intercept approval response',!financial.includes('res.json=function')],
 ['financial evidence is committed by authoritative transaction',core.includes('INSERT INTO inventory_writeoff_financial_approvals')],
 ['identity guard prepares normalized request context',trace.includes('req.writeoffIdentityApproval=')],
 ['identity guard does not reserve approval identity',!trace.includes("SET status='writeoff_pending'")],
 ['identity guard does not finalize approval after response',!trace.includes('finalizeApproval(req.params.id)')],
 ['serial identity is finalized inside authoritative route',core.includes("UPDATE inventory_serials SET status='written_off'")],
 ['lot identity is finalized inside authoritative route',core.includes('UPDATE inventory_lots SET available_quantity=available_quantity-?')],
 ['identity allocations finalize inside authoritative route',core.includes("UPDATE inventory_writeoff_identity_allocations SET status='finalized'")],
 ['approval uses compare-and-swap',core.includes("WHERE id=? AND status='pending_approval' RETURNING *")],
 ['approval verifies compare-and-swap affected one row',core.includes("writeoffError('WRITEOFF_CONCURRENT_DECISION')")],
 ['valuation uses same transaction executor',core.includes('valueStockAdjustment(tx,')],
 ['accounting uses same transaction executor',core.includes('executor:tx')],
 ['central safe error helper is used by all approval layers',financial.includes('sendWriteoffError')&&trace.includes('sendWriteoffError')&&core.includes('sendWriteoffError')],
 ['stable internal error code exists',errors.includes('WRITEOFF_INTERNAL_ERROR')],
 ['rollback helper exists',errors.includes('rollbackWriteoffQuietly')],
 ['financial guard has no raw detail response',!financial.includes('detail:e.message')&&!financial.includes('detail:err.message')],
 ['traceability guard has no raw detail response',!trace.includes('detail:e.message')&&!trace.includes('detail:err.message')],
 ['core has no raw exception response',!core.includes('{error:e.message}')&&!core.includes('detail:e.message')&&!core.includes('{error:err.message}')&&!core.includes('detail:err.message')]
];
let failed=0;for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Atomic write-off: ${name}`);if(!ok)failed++;}
if(failed){console.error(`Atomic write-off contract FAILED (${failed}/${checks.length} failed).`);process.exit(1);}console.log(`Atomic write-off contract OK (${checks.length} checks).`);
