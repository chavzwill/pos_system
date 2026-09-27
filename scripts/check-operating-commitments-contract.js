'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const route=read('routes/operating-commitments.js');
const server=read('server.js');
const ui=read('public/supplier-ledger.js');
new vm.Script(route,{filename:'operating-commitments.js'});
new vm.Script(ui,{filename:'supplier-ledger-ui.js'});
const checks=[
 ['operating commitment route is mounted',server.includes("app.use('/api/operating-commitments'")],
 ['route requires finance or purchasing authority',route.includes("requireAnyPermission('reports_financial','purchasing')")],
 ['commitment header is durable',route.includes('CREATE TABLE IF NOT EXISTS operating_commitments')],
 ['commitment number is unique',route.includes('commitment_number TEXT NOT NULL UNIQUE')],
 ['commitment preserves category name supplier/provider branch department and currency',route.includes('category TEXT NOT NULL')&&route.includes('provider_name TEXT')&&route.includes('branch_id INTEGER REFERENCES branches(id)')&&route.includes('department TEXT')&&route.includes('currency TEXT')],
 ['commitment preserves expected amount and cadence',route.includes('expected_amount REAL NOT NULL')&&route.includes('cadence TEXT NOT NULL')],
 ['commitment preserves start end and next due dates',route.includes('start_date DATE NOT NULL')&&route.includes('end_date DATE')&&route.includes('next_due_date DATE')],
 ['commitment preserves renewal and cancellation notice evidence',route.includes('auto_renew INTEGER NOT NULL DEFAULT 0')&&route.includes('renewal_date DATE')&&route.includes('cancellation_notice_days INTEGER')],
 ['commitment preserves terms and contract references',route.includes('terms_reference TEXT')&&route.includes('contract_reference TEXT')],
 ['commitment source version is durable',route.includes('source_version INTEGER NOT NULL DEFAULT 1')],
 ['supported categories cover major operating spend classes',route.includes("'rent_lease'")&&route.includes("'utilities'")&&route.includes("'telecom'")&&route.includes("'software_subscription'")&&route.includes("'insurance'")&&route.includes("'maintenance_contract'")],
 ['supported cadences are explicitly bounded',route.includes("['weekly','monthly','quarterly','semiannual','annual','custom']")],
 ['expected amount must be positive',route.includes('Expected amount must be greater than zero')],
 ['custom cadence requires positive interval days',route.includes('Custom cadence requires custom_interval_days')],
 ['supplier or provider evidence is required',route.includes('Supplier or provider name is required')],
 ['end date cannot precede start date',route.includes('Commitment end date cannot be before start date')],
 ['next due date cannot precede start date',route.includes('Next due date cannot be before start date')],
 ['auto renew requires renewal date',route.includes('Auto-renewing commitment requires a renewal date')],
 ['cancellation notice days are non-negative whole number',route.includes('Cancellation notice days must be a non-negative whole number')],
 ['annualized value is derived from cadence not stored as invented actual',route.includes('function annualized(')&&route.includes('weekly:52')&&route.includes('monthly:12')&&route.includes('quarterly:4')],
 ['commitment uses shared cost-allocation schema',route.includes('ensureCostAllocationSchema')],
 ['commitment allocations use shared normalization',route.includes('normalizeAllocations(req.body?.allocations,b.expected_amount)')],
 ['commitment must have at least one cost target',route.includes('Operating commitment must be allocated to at least one cost target')],
 ['allocation total must equal full expected amount through shared normalizer',read('lib/cost-allocations.js').includes('Cost allocations must equal the full line amount')],
 ['branch target must exist and be active',route.includes('SELECT id FROM branches WHERE id=? AND active=1')],
 ['vehicle target must exist and be active',route.includes('SELECT id FROM dispatch_vehicles WHERE id=? AND active=1')],
 ['rental asset target must be live',route.includes("status NOT IN ('disposed','sold','lost')")],
 ['work order target must be open',route.includes("status NOT IN ('completed','cancelled')")],
 ['custom cost object target must match type and be active',route.includes('SELECT id FROM cost_objects WHERE id=? AND object_type=? AND active=1')],
 ['general overhead may intentionally have no target ID',route.includes("a.target_type==='general_overhead'&&!id")],
 ['creation writes commitment allocations in same transaction',route.includes("sourceType:'operating_commitment'")&&route.includes("const tx=await db.transaction('write');let committed=false")],
 ['creation emits SpendOS operating commitment event',route.includes("'operating.commitment.created'")&&route.includes('enqueueSpendEvent')],
 ['SpendOS event carries authenticated actor',route.includes("eventFor(row,allocations,'operating.commitment.created',actor(req))")],
 ['SpendOS event carries allocation targets',route.includes('allocations:(allocations||[]).map')],
 ['status changes increment source version',route.includes('const nextVersion=Number(current.source_version||1)+1')],
 ['status event reads allocations from same write transaction',route.includes("await tx.execute({sql:'SELECT * FROM cost_allocations WHERE source_type=? AND source_id=? ORDER BY id'")],
 ['status changes emit SpendOS event with authenticated actor',route.includes("'operating.commitment.status_changed',actor(req)")],
 ['economics are immutable in first slice outside controlled status change',!route.includes("router.put('/:id'")&&!route.includes("router.patch('/:id'")],
 ['attention can be branch scoped',route.includes("if(req.query.branch_id){where+=' AND oc.branch_id=?'")],
 ['past-due planned obligation becomes attention',route.includes("type:'past_due_plan'")],
 ['upcoming obligation within 14 days becomes attention',route.includes("type:'upcoming_due'")&&route.includes('due<=14')],
 ['cancellation notice window is derived before auto renewal',route.includes("type:'cancellation_window'")&&route.includes('cancellation_notice_days')],
 ['auto-renewal approaching becomes attention',route.includes("type:'renewal_approaching'")],
 ['auto-renewal without contract/terms evidence is flagged',route.includes("type:'renewal_evidence_gap'")],
 ['expired active commitment is flagged',route.includes("type:'expired_commitment'")],
 ['attention exposes annualized active commitment',route.includes('annualized_active_commitment')],
 ['attention explicitly states planning only',route.includes('Planning attention only.')&&route.includes('do not create supplier invoices, AP, payments, or accounting entries')],
 ['route contains no supplier invoice creation',!route.includes('INSERT INTO supplier_invoices')],
 ['route contains no supplier payment creation',!route.includes('INSERT INTO supplier_payments')],
 ['route contains no accounting journal creation',!route.includes('ledger_entries')&&!route.includes('journal_entries')],
 ['UI exposes Operating commitments action',ui.includes('tt-supplier-ledger-commitments')&&ui.includes('Operating commitments')],
 ['UI fetches branch-scoped commitments and attention',ui.includes("rootApi('/operating-commitments'+branch)")&&ui.includes("rootApi('/operating-commitments/attention'+branch)")],
 ['UI shows annualized active commitment and attention counts',ui.includes("kpi('Annualized active'")&&ui.includes("kpi('Attention'")&&ui.includes("kpi('Critical'")],
 ['UI states commitments are planning evidence only',ui.includes('Operating commitments are planning evidence only.')],
 ['UI captures supplier/provider expected amount cadence and renewal evidence',ui.includes('Provider name')&&ui.includes('Expected amount')&&ui.includes('Cadence')&&ui.includes('Renewal date')&&ui.includes('Cancellation notice days')],
 ['UI captures cost target and creates full 100 percent allocation',ui.includes('Cost target type')&&ui.includes('allocation_percent:100')],
 ['UI posts commitment only to operating-commitment endpoint',ui.includes("rootApi('/operating-commitments',{method:'POST'")],
 ['UI does not post AP/payment from commitment form',!ui.substring(ui.indexOf('function showOperatingCommitmentForm'),ui.indexOf('async function showPaymentPriorities')).includes("api('/payments'")&&!ui.substring(ui.indexOf('function showOperatingCommitmentForm'),ui.indexOf('async function showPaymentPriorities')).includes("api('/invoices'")]
];
let failed=0;
for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Operating commitments: ${name}`);if(!ok)failed++;}
if(failed){console.error(`Operating commitments contract FAILED (${failed}/${checks.length} failed).`);process.exit(1);}
console.log(`Operating commitments contract OK (${checks.length} checks).`);
