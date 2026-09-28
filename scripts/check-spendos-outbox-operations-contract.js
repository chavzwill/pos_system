'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const deliver=read('scripts/deliver-spendos-outbox.js');
const route=read('routes/spendos-management.js');
const ui=read('public/index.html');
new vm.Script(deliver,{filename:'deliver-spendos-outbox.js'});
new vm.Script(route,{filename:'spendos-management.js'});
const checks=[
 ['delivery has bounded configurable max attempts',deliver.includes('SPENDOS_OUTBOX_MAX_ATTEMPTS')&&deliver.includes('Math.max(1, Math.min(50')],
 ['default delivery max attempts is finite',deliver.includes('SPENDOS_OUTBOX_MAX_ATTEMPTS || 8')],
 ['delivery marks terminal failure as dead letter',deliver.includes("terminal ? 'dead_letter' : 'failed'")],
 ['terminal threshold uses incremented attempt count',deliver.includes('const attempts = Number(row.attempts || 0) + 1')&&deliver.includes('attempts >= maxAttempts')],
 ['dead-letter event preserves last error',deliver.includes('last_error=?')],
 ['dead-letter event increments attempts',deliver.includes('attempts=attempts+1')],
 ['dead-letter event stops using backoff timestamp',deliver.includes("CASE WHEN ?='dead_letter' THEN CURRENT_TIMESTAMP")],
 ['claim query excludes dead-letter events',deliver.includes("status IN ('pending','failed','sending')")&&!deliver.substring(deliver.indexOf('async function claimRows'),deliver.indexOf('async function deliver')).includes('dead_letter')],
 ['worker returns dead-letter result explicitly',deliver.includes("status: terminal ? 'dead_letter' : 'failed'")],
 ['worker exits nonzero on failed or dead-letter result',deliver.includes("result.status === 'failed' || result.status === 'dead_letter'")],
 ['management route imports authoritative POS database',route.includes("const {db}=require('../database')")],
 ['outbox health route is protected by SpendOS management authority',route.includes("router.use(requireAnyPermission('reports_financial','purchasing'))")&&route.includes("router.get('/outbox/health'")],
 ['health counts all outbox statuses',route.includes('GROUP BY status ORDER BY status')],
 ['health detects stale pending rows',route.includes("status='pending'")&&route.includes("-15 minutes")],
 ['health detects expired sending leases',route.includes("status='sending'")&&route.includes('datetime(available_at)<=CURRENT_TIMESTAMP')],
 ['health detects failed rows',route.includes("status='failed'")],
 ['health detects dead-letter rows',route.includes("status='dead_letter'")],
 ['health lists recent dead-letter event identity and error',route.includes('event_id,event_type,aggregate_type,aggregate_id,source_version,attempts,last_error')],
 ['dead letters make health critical',route.includes("deadLetter>0?'critical'")],
 ['other stuck delivery states make health degraded',route.includes("'degraded':'healthy'")],
 ['health basis states operational evidence only',route.includes('Outbox health is operational delivery evidence only.')],
 ['manual requeue requires finance permission',route.includes("router.post('/outbox/:id/requeue',requirePermission('reports_financial')")],
 ['requeue requires event to exist',route.includes('SpendOS outbox event not found')],
 ['requeue accepts only terminal dead-letter events',route.includes("row.status!=='dead_letter'")&&route.includes('Only dead-letter SpendOS events can be manually requeued')],
 ['requeue resets delivery state without changing source event identity',route.includes("SET status='pending',attempts=0,last_error=NULL,available_at=CURRENT_TIMESTAMP,sent_at=NULL")],
 ['requeue returns same existing event id',route.includes('event_id:row.event_id')],
 ['UI loads outbox health with SpendOS savings workspace',ui.includes("this.api('GET','/spendos-management/outbox/health')")],
 ['UI exposes delivery health status',ui.includes('SpendOS Delivery Health')&&ui.includes('outboxStatus')],
 ['UI exposes failed dead-letter stale and expired lease metrics',ui.includes('Dead letter')&&ui.includes('Stale pending')&&ui.includes('Expired sending lease')],
 ['UI lists dead-letter error and attempts',ui.includes('dead_letters')&&ui.includes('last_error')&&ui.includes('attempts')],
 ['UI exposes explicit requeue action for dead letters',ui.includes('_requeueSpendOSOutbox')&&ui.includes('Requeue')],
 ['requeue UI calls only management requeue route',ui.includes("'/spendos-management/outbox/'+id+'/requeue'")],
 ['requeue UI reloads health after action',ui.includes("this.alert('SpendOS event requeued for delivery')")&&ui.includes('this._loadSavingsRealization()')]
];
let failed=0;
for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} SpendOS outbox operations: ${name}`);if(!ok)failed++;}
if(failed){console.error(`SpendOS outbox operations contract FAILED (${failed}/${checks.length} failed).`);process.exit(1);}
console.log(`SpendOS outbox operations contract OK (${checks.length} checks).`);
