'use strict';
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const adapter=read('lib/customer-credit-approval-adapter.js');
const guard=read('routes/customer-credit-governance.js');
const approvals=read('routes/approval-routing.js');
const globalGuard=read('routes/multi-branch-integrity-guard.js');
const errors=read('lib/approval-routing-errors.js');
const permissions=read('lib/permissions.js');
const guide=read('public/department-approvals-guide-me.js');
const checks=[
 ['credit authority is explicit-only',permissions.includes("{ key: 'accounts_credit_approve' }")&&permissions.includes("'accounts_credit_approve'" )&&permissions.includes('EXPLICIT_ONLY_PERMISSIONS')],
 ['proposal and decision share one Accounts authority adapter',adapter.includes('submitCustomerCreditChange')&&adapter.includes('decideCustomerCreditChange')],
 ['credit approval envelope uses dedicated module type and permission',adapter.includes("MODULE='customer_credit'")&&adapter.includes("REQUEST_TYPE='customer_credit_change'")&&adapter.includes("REQUIRED_PERMISSION='accounts_credit_approve'")],
 ['proposal does not mutate customer credit state',adapter.indexOf('submitCustomerCreditChange')<adapter.indexOf('decideCustomerCreditChange')&&adapter.slice(adapter.indexOf('submitCustomerCreditChange'),adapter.indexOf('decideCustomerCreditChange')).indexOf('UPDATE customers SET credit_enabled')===-1],
 ['approved decision changes customer and approval evidence in one transaction',adapter.includes("db.transaction('write')")&&adapter.includes('UPDATE customers SET credit_enabled=')&&adapter.includes('UPDATE approval_requests SET status=')&&adapter.includes("type:'customer_credit'")],
 ['direct Accounts and Customers credit mutations are intercepted',guard.includes('block_direct_account_credit_change')&&guard.includes('block_direct_customer_credit_change')&&guard.includes('block_direct_credit_customer_create')],
 ['governance guard runs before legacy business routers',globalGuard.includes("router.use('/',require('./customer-credit-governance'))")],
 ['internal credit workflow rejects API keys',guard.includes('customer_credit_api_key_boundary')&&guard.includes('APPROVAL_API_KEY_FORBIDDEN')],
 ['shared approval router registers Accounts adapter and fails closed otherwise',approvals.includes('customerCredit')&&approvals.includes('adapterFor(row)')&&approvals.includes('APPROVAL_HANDLER_UNAVAILABLE')],
 ['safe credit errors never require raw exception text',errors.includes('CREDIT_CHANGE_APPROVAL_REQUIRED')&&errors.includes('CREDIT_CHANGE_ALREADY_PENDING')&&guard.includes('sendApprovalError')&&!guard.includes('json({error:error.message')],
 ['Guide Me teaches Accounts credit review in human language',guide.includes('For Accounts')&&guide.includes('requested credit limit')&&guide.includes('payment terms')&&!guide.toLowerCase().includes('owning module')]
];
let failed=0;
for(const [label,ok] of checks){if(ok)console.log('PASS Customer credit governance:',label);else{console.error('FAIL Customer credit governance:',label);failed++;}}
if(failed){console.error(`Customer credit governance contract failed: ${failed} invariant(s).`);process.exit(1);}
console.log(`Customer credit governance contract OK (${checks.length} checks).`);
