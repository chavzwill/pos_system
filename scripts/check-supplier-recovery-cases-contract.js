'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const route=read('routes/supplier-recovery-cases.js');
const attention=read('routes/supplier-recovery-attention.js');
const server=read('server.js');
const ui=read('public/index.html');
new vm.Script(route,{filename:'supplier-recovery-cases.js'});
new vm.Script(attention,{filename:'supplier-recovery-attention.js'});
const checks=[
 ['recovery case route is mounted',server.includes("app.use('/api/supplier-recovery-cases'")],
 ['recovery cases require purchasing or finance authority',route.includes("requireAnyPermission('purchasing','reports_financial','accounts')")],
 ['recovery cases are durable one-per-claim coordination records',route.includes('CREATE TABLE IF NOT EXISTS supplier_recovery_cases')&&route.includes('claim_id INTEGER NOT NULL UNIQUE')],
 ['recovery case history is durable and append only in application code',route.includes('CREATE TABLE IF NOT EXISTS supplier_recovery_case_events')&&!route.includes('UPDATE supplier_recovery_case_events')&&!route.includes('DELETE FROM supplier_recovery_case_events')],
 ['case lifecycle supports open follow-up promised disputed escalated and closed',route.includes("['open','follow_up','promised','disputed','escalated','closed']")],
 ['case priority supports low medium high critical',route.includes("['low','medium','high','critical']")],
 ['resolved recoverables cannot create new recovery cases',route.includes('Resolved recoverable does not need a recovery case')],
 ['opening a case is idempotent per recoverable claim',route.includes('SELECT id FROM supplier_recovery_cases WHERE claim_id=?')&&route.includes('return res.json(await getCase(db,existing.id))')],
 ['case owner must be active employee',route.includes("SELECT id FROM employees WHERE id=? AND active=1")&&route.includes('Recovery case owner must be an active employee')],
 ['promised amount cannot exceed real recoverable outstanding',route.includes('Promised amount cannot exceed recoverable outstanding balance')],
 ['promised state requires amount and settlement date',route.includes('Promised status requires settlement date and promised amount')],
 ['dispute requires explicit reason',route.includes('Disputed status requires a reason')],
 ['escalation level is bounded',route.includes('Escalation level must be an integer from 0 to 5')],
 ['escalated state requires real escalation level',route.includes('Escalated case requires escalation level 1 or higher')],
 ['case cannot close before linked recoverable resolves',route.includes('Recovery case cannot close before the linked recoverable is resolved')],
 ['case updates record event evidence',route.includes('INSERT INTO supplier_recovery_case_events')&&route.includes('evidence_reference')],
 ['follow-up notes require meaningful text',route.includes('Follow-up note is required')],
 ['closed case cannot accept new follow-ups',route.includes('Closed recovery case cannot receive follow-up notes')],
 ['case detail derives outstanding from authoritative recoverable',route.includes('confirmed_amount')&&route.includes('recovered_amount')&&route.includes('outstanding_amount:money')],
 ['attention engine initializes recovery case schema',attention.includes('recoveryCases.ensureSchema')],
 ['missed follow-up becomes attention',attention.includes("type:'missed_follow_up'")&&attention.includes('Recovery case follow-up date has passed')],
 ['broken supplier promise becomes attention',attention.includes("type:'broken_supplier_promise'")&&attention.includes('Supplier-promised settlement date has passed')],
 ['supplier dispute becomes attention',attention.includes("type:'supplier_dispute'")&&attention.includes('Resolve the dispute using source documents')],
 ['case attention continues to deduplicate headline risk by claim',attention.includes("const riskKey='claim:'+x.claim_id")],
 ['recoverables UI loads recovery cases',ui.includes("this.api('GET','/supplier-recovery-cases')")&&ui.includes('recoveryCaseByClaim')],
 ['attention UI distinguishes open case from existing managed case',ui.includes('Open case')&&ui.includes('Manage case')],
 ['new case defaults ownership to current authenticated employee',ui.includes('owner_employee_id:this.currentUser?.id||null')],
 ['case UI supports follow-up recording',ui.includes("action==='follow_up'")&&ui.includes("'/follow-ups'")],
 ['case UI supports supplier promise capture',ui.includes("action==='promised'")&&ui.includes('promised_settlement_date')],
 ['case UI supports dispute and escalation',ui.includes("action==='disputed'")&&ui.includes("action==='escalated'")],
 ['case UI cannot directly alter supplier-recoverable money',!ui.includes("'/supplier-recovery-cases/'+id+'/settlements'")],
 ['case closure is routed through backend financial-resolution guard',ui.includes("action==='close'")&&ui.includes("{status:'closed',note}")]
];
let failed=0;
for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Supplier recovery cases: ${name}`);if(!ok)failed++;}
if(failed){console.error(`Supplier recovery case contract FAILED (${failed}/${checks.length} failed).`);process.exit(1);}
console.log(`Supplier recovery case contract OK (${checks.length} checks).`);
