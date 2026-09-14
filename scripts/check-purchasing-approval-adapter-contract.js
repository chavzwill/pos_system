'use strict';
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const adapter=read('lib/purchasing-approval-adapter.js');
const guard=read('routes/purchase-request-approval-guard.js');
const approvalRoute=read('routes/approval-routing.js');
const globalGuard=read('routes/multi-branch-integrity-guard.js');
const ui=read('public/purchasing-approval-ui-guard.js');
const guide=read('public/department-approvals-guide-me.js');
const deferred=read('public/shell-deferred.js');
const checks=[
 ['submission and approval share a purchasing authority adapter',adapter.includes('submitPurchaseRequestForApproval')&&adapter.includes('decidePurchaseRequest')],
 ['purchase request submission creates normalized approval evidence',adapter.includes("REQUEST_TYPE='purchase_request'")&&adapter.includes("REQUIRED_PERMISSION='purchasing_approve'")&&adapter.includes('approval_events')],
 ['terminal purchase decisions use authenticated employee identity',adapter.includes("approved_by=?")&&adapter.includes('args:[employeeId,pr.id]')&&!adapter.includes('req.body?.approved_by')],
 ['purchase and approval terminal state commit in one transaction',adapter.includes("db.transaction('write')")&&adapter.includes('approval_requests SET status=')&&adapter.includes('purchase_requests SET status=')],
 ['legacy terminal status mutation is intercepted',guard.includes("['approved','rejected'].includes(status)")&&guard.includes("PURCHASE_REQUEST_APPROVAL_REQUIRED")],
 ['purchase request approval guard runs before legacy routes',globalGuard.includes("router.use('/purchase-requests',require('./purchase-request-approval-guard'))")],
 ['shared manager route keeps purchasing in fail-closed adapter registry',approvalRoute.includes('const adapters=[purchasing')&&approvalRoute.includes('adapterFor(row)')&&approvalRoute.includes('decidePurchaseRequest')&&approvalRoute.includes("APPROVAL_HANDLER_UNAVAILABLE")],
 ['submitted purchasing UI routes managers to Department Approvals',ui.includes('Review in Department Approvals')&&ui.includes('[data-action="approve"],[data-action="reject"]')],
 ['purchasing approval UI guard is deferred-loaded',deferred.includes("'/purchasing-approval-ui-guard.js'")],
 ['Guide Me uses staff language rather than architecture jargon',guide.includes('original business record')&&!guide.toLowerCase().includes('owning module')]
];
let failed=0;
for(const [label,ok] of checks){if(ok)console.log('OK:',label);else{console.error('FAIL:',label);failed++;}}
if(failed){console.error(`Purchasing approval adapter contract failed: ${failed} invariant(s).`);process.exit(1);}
console.log('Purchasing approval adapter contract OK.');
