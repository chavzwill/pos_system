'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const route=read('routes/supplier-statement-exceptions.js');
const statements=read('routes/supplier-statements.js');
const server=read('server.js');
const ui=read('public/index.html');
new vm.Script(route,{filename:'supplier-statement-exceptions.js'});
new vm.Script(statements,{filename:'supplier-statements.js'});
const checks=[
 ['statement exception route is mounted',server.includes("app.use('/api/supplier-statement-exceptions'")],
 ['exceptions require purchasing or finance authority',route.includes("requireAnyPermission('purchasing','reports_financial','accounts')")],
 ['exception cases and append-only events are durable',route.includes('CREATE TABLE IF NOT EXISTS supplier_statement_exceptions')&&route.includes('CREATE TABLE IF NOT EXISTS supplier_statement_exception_events')],
 ['exception identity is unique per statement type and source',route.includes('UNIQUE(statement_id,exception_type,source_key)')],
 ['event history is append only in application code',!route.includes('UPDATE supplier_statement_exception_events')&&!route.includes('DELETE FROM supplier_statement_exception_events')],
 ['shared statement reconciliation is exported as authority',statements.includes('module.exports.reconcileStatement=reconcileStatement')],
 ['refresh uses authoritative reconciliation not copied balance math',route.includes('statements.reconcileStatement(req.params.statementId)')],
 ['balance variance becomes explicit exception',route.includes("exception_type:'balance_variance'")],
 ['supplier statement credit missing internally becomes explicit exception',route.includes("exception_type:'statement_credit_missing_internally'")],
 ['internal credit missing on supplier statement becomes explicit exception',route.includes("exception_type:'internal_credit_missing_on_statement'")],
 ['refresh is idempotent per exception identity',route.includes('ON CONFLICT(statement_id,exception_type,source_key) DO UPDATE')],
 ['reappearing resolved mismatch reopens',route.includes("status=CASE WHEN supplier_statement_exceptions.status='resolved' THEN 'open'")],
 ['clean reconciliation auto-resolves previously open exception',route.includes("resolution_type='underlying_reconciled'")&&route.includes('authoritative reconciliation no longer reports this exception')],
 ['exception priorities derive from amount bands',route.includes("x.amount>=100000?'critical':x.amount>=25000?'high':x.amount>=5000?'medium':'low'")],
 ['new exception defaults owner to authenticated actor',route.includes("rec.statement_id,x.exception_type,x.source_key,'open',actor(req)")],
 ['exception edit owner must be active employee',route.includes('Exception owner must be an active employee')],
 ['normal edits cannot directly close case',route.includes('Use the controlled resolution endpoints to close a statement exception')],
 ['resolve re-runs authoritative reconciliation',route.includes('statements.reconcileStatement(current.statement_id)')],
 ['resolve refuses while mismatch still exists',route.includes('cannot be resolved while the authoritative reconciliation still reports the mismatch')],
 ['accepted difference requires financial permission',route.includes("router.post('/:id/accept-difference',requirePermission('reports_financial')")],
 ['accepted difference requires meaningful finance reason',route.includes('Accepted difference requires a meaningful finance reason')],
 ['accepted difference requires evidence reference',route.includes('Accepted difference requires an evidence reference')],
 ['closed exceptions reject further investigation notes',route.includes('Closed statement exception cannot receive investigation notes')],
 ['exception route cannot mutate AP or source accounting records',!route.includes('UPDATE supplier_invoices')&&!route.includes('INSERT INTO supplier_payments')&&!route.includes('supplier_recoverable_ap_allocations')&&!route.includes('ledger_entries')],
 ['UI loads statement exceptions',ui.includes("this.api('GET','/supplier-statement-exceptions')")],
 ['statement reconciliation refreshes exception cases',ui.includes("'/supplier-statement-exceptions/refresh/'")],
 ['UI explains exception cases do not change AP',ui.includes('Resolving a case never changes AP')],
 ['UI exposes investigate and resolve controls',ui.includes('_investigateStatementException')&&ui.includes('_resolveStatementException')],
 ['accepted difference UI is finance permission gated',ui.includes("if(this.can('reports_financial'))actions+=")&&ui.includes('_acceptStatementDifference')],
 ['accepted difference UI requires reason and evidence reference',ui.includes('A meaningful finance reason is required')&&ui.includes('An evidence reference is required')],
 ['UI states refresh changes coordination cases only',ui.includes('Reconciliation refreshes coordination cases only. It does not change AP.')]
];
let failed=0;
for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Supplier statement exceptions: ${name}`);if(!ok)failed++;}
if(failed){console.error(`Supplier statement exception contract FAILED (${failed}/${checks.length} failed).`);process.exit(1);}
console.log(`Supplier statement exception contract OK (${checks.length} checks).`);
