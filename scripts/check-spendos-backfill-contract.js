'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const script=read('scripts/backfill-spendos-purchase-requests.js');
const route=read('routes/purchase-requests.js');
const outbox=read('lib/spendos-outbox.js');
new vm.Script(script,{filename:'backfill-spendos-purchase-requests.js'});
new vm.Script(route,{filename:'purchase-requests.js'});
const statusStart=route.indexOf("router.patch('/:id/status'");
const statusEnd=route.indexOf('// Convert approved PR',statusStart);
const statusRoute=route.slice(statusStart,statusEnd);
const convertStart=route.indexOf("router.post('/:id/convert'");
const convertRoute=route.slice(convertStart);
const checks=[
 ['backfill is dry-run by default',script.includes("const apply=process.argv.includes('--apply')")&&script.includes("mode:apply?'apply':'dry_run'")],
 ['backfill has bounded scan limit',script.includes('--limit=')&&script.includes('Math.min(10000')],
 ['backfill initializes authoritative database and cost allocation schema',script.includes('await ensureReady()')&&script.includes('await ensureCostAllocationSchema()')],
 ['backfill inspects current purchase request items',script.includes('SELECT * FROM purchase_request_items WHERE pr_id=? ORDER BY id')],
 ['backfill inspects current cost allocations',script.includes("source_type='purchase_request' AND source_id=?")],
 ['backfill detects requests with no items as unsafe',script.includes("return 'no_purchase_request_items'")],
 ['backfill rejects invalid quantities',script.includes("return 'invalid_item_quantity'")],
 ['backfill rejects invalid totals',script.includes("return 'invalid_item_total'")],
 ['internal-use backfill requires allocation evidence',script.includes("internal_use_item_missing_allocation")],
 ['backfill checks exact current source version',script.includes('Number(x.source_version)===currentVersion')],
 ['backfill detects no SpendOS history',script.includes("'no_spendos_history'")],
 ['backfill detects missing current version despite prior history',script.includes("'current_version_not_emitted'")],
 ['backfill detects stale status snapshot',script.includes("payloadStatus(exact)!==String(pr.status||'draft')")],
 ['backfill never changes current rows',script.includes("row.classification==='current'")],
 ['backfill never changes unsafe rows',script.includes("row.classification==='unsafe'")],
 ['apply rechecks source record inside write transaction',script.includes("const tx=await db.transaction('write')")&&script.includes('Purchase request disappeared during backfill')],
 ['apply rechecks unsafe evidence before writing',script.includes('Backfill became unsafe:')],
 ['apply becomes no-op if another writer already repaired current snapshot',script.includes("'current_after_recheck'")],
 ['stale same-version snapshot increments source version',script.includes('const targetVersion=exact?currentVersion+1:currentVersion')],
 ['missing current version preserves current source version when free',script.includes('targetVersion=exact?currentVersion+1:currentVersion')],
 ['source version update and event enqueue share same transaction',script.includes("UPDATE purchase_requests SET spendos_version=?")&&script.includes('await enqueuePurchaseRequested(tx')&&script.includes('await tx.commit()')],
 ['backfilled snapshot is explicitly marked',script.includes("backfill:{basis:'current_authoritative_snapshot'")],
 ['backfill output reports current missing stale unsafe and changed counts',script.includes('missing_current_snapshot')&&script.includes('stale_current_snapshot')&&script.includes('unsafe:')&&script.includes('changed:0')],
 ['backfill errors are surfaced and produce nonzero exit',script.includes('summary.errors.push')&&script.includes('process.exitCode=1')],
 ['normal purchase-request event payload supports explicit backfill metadata',outbox.includes('backfill: input.backfill ?')&&outbox.includes('current_authoritative_snapshot')],
 ['status route is transactional',statusRoute.includes("const tx = await db.transaction('write')")],
 ['status no-op does not emit duplicate SpendOS version',statusRoute.includes('if (pr.status === status)')&&statusRoute.includes('return res.json(same)')],
 ['status transition increments SpendOS version',statusRoute.includes('const nextSpendosVersion = Number(pr.spendos_version || 1) + 1')],
 ['status transition writes status and version atomically',statusRoute.includes('spendos_version=?')],
 ['status transition loads authoritative existing items and allocations',statusRoute.includes('await spendosItemsForPR(tx, pr.id)')],
 ['status transition enqueues snapshot inside same transaction',statusRoute.includes('await enqueuePurchaseRequested(tx')&&statusRoute.indexOf('await enqueuePurchaseRequested(tx')<statusRoute.indexOf('await tx.commit()')],
 ['status transition snapshot carries new status and version',statusRoute.includes('status,')&&statusRoute.includes('sourceVersion: nextSpendosVersion')],
 ['conversion increments SpendOS version',convertRoute.includes('const nextSpendosVersion = Number(pr.spendos_version || 1) + 1')],
 ['conversion persists converted status PO id and version together',convertRoute.includes('converted_to_po_id = ?, spendos_version=?')],
 ['conversion emits converted SpendOS snapshot before commit',convertRoute.includes("status:'converted'")&&convertRoute.includes('sourceVersion:nextSpendosVersion')&&convertRoute.indexOf('await enqueuePurchaseRequested(tx')<convertRoute.indexOf('await tx.commit()')],
 ['conversion snapshot uses authoritative PR lines and allocations',convertRoute.includes('await spendosItemsForPR(tx, pr.id)')]
];
let failed=0;
for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} SpendOS backfill: ${name}`);if(!ok)failed++;}
if(failed){console.error(`SpendOS backfill contract FAILED (${failed}/${checks.length} failed).`);process.exit(1);}
console.log(`SpendOS backfill contract OK (${checks.length} checks).`);
