'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const route=read('routes/spendos-management.js');
const ui=read('public/index.html');
const server=read('server.js');
new vm.Script(route,{filename:'spendos-management.js'});
const checks=[
 ['management proxy is mounted server-side',server.includes("app.use('/api/spendos-management'")],
 ['proxy requires finance or purchasing authority',route.includes("requireAnyPermission('reports_financial','purchasing')")],
 ['SpendOS API key stays server-side',route.includes('process.env.SPENDOS_API_KEY')&&!ui.includes('SPENDOS_API_KEY')],
 ['opportunity discovery runs through authenticated proxy',route.includes("/v1/savings/run?tenantId=")&&ui.includes("/spendos-management/opportunities")],
 ['recorded action actor comes from authenticated employee',route.includes("actorId:req.employee?.id")],
 ['verification is proxied without browser credentials',route.includes("/verify?tenantId=")&&ui.includes("_verifySavingsOpportunity")],
 ['UI distinguishes estimated from verified savings',ui.includes('Estimated opportunities')&&ui.includes('Verified savings')],
 ['UI explicitly says estimates are not booked savings',ui.includes('Potential only — not booked as savings')],
 ['verified savings require post-action received-cost evidence in staff copy',ui.includes('post-action received-cost evidence')],
 ['UI supports action then verification lifecycle',ui.includes('_recordSavingsAction')&&ui.includes("x.status==='actioned'")&&ui.includes('>Verify<')],
 ['offline SpendOS fails soft instead of blocking purchasing',ui.includes('Savings verification unavailable')&&route.includes("SpendOS is not configured")],
 ['verified and not-verified outcomes are different staff messages',ui.includes('Verified savings:')&&ui.includes('does not verify a saving yet')],
 ['verified rollup stays behind the authenticated server proxy',route.includes('/verified-rollup')&&route.includes('/v1/savings/verified-rollup?tenantId=')&&!ui.includes('/v1/savings/verified-rollup')],
 ['UI reconciles verified savings by supplier category department and period',ui.includes('Verified savings reconciliation')&&ui.includes('By supplier')&&ui.includes('By category')&&ui.includes('By department')&&ui.includes('By period')],
 ['UI identifies uniquely claimed receipt evidence',ui.includes('uniquely claimed receipt evidence item(s)')],
 ['savings targets stay behind authenticated SpendOS proxy',route.includes('/targets/performance')&&route.includes("router.post('/targets'")&&!ui.includes('/v1/savings/targets')],
 ['target owner defaults to authenticated employee when omitted',route.includes("ownerId:req.body?.ownerId|| (req.employee?.id?String(req.employee.id):null)")],
 ['UI separates management target from realized savings',ui.includes('This is a management goal, not realized savings')&&ui.includes('Only verified receipt-backed savings count toward attainment')],
 ['UI exposes savings accountability period target verified gap status and owner',ui.includes('Savings Accountability')&&ui.includes('<th>Target</th>')&&ui.includes('<th>Verified</th>')&&ui.includes('<th>Gap</th>')&&ui.includes('<th>Owner</th>')],
 ['UI supports company supplier category and department target scopes',ui.includes('<option value="company">Company</option>')&&ui.includes('<option value="supplier">Supplier</option>')&&ui.includes('<option value="category">Savings category</option>')&&ui.includes('<option value="department">Department</option>')],
 ['savings attention stays behind authenticated proxy',route.includes("router.get('/attention'")&&route.includes('/v1/savings/attention?tenantId=')&&!ui.includes('/v1/savings/attention')],
 ['UI labels pace as review signal not forecast',ui.includes('Review prompts only. Pace signals do not forecast future savings or guarantee target failure.')],
 ['UI surfaces savings attention reasons and priority',ui.includes('Savings Attention')&&ui.includes('<th>Priority</th>')&&ui.includes('<th>Reason</th>')],
 ['savings leakage stays behind authenticated proxy',route.includes("router.get('/leakage'")&&route.includes('/v1/savings/leakage?tenantId=')&&!ui.includes('/v1/savings/leakage')],
 ['UI limits leakage causes to direct evidence',ui.includes('Only causes directly proven by recorded actions and later actual receipt evidence are classified. Unexplained gaps remain unexplained.')],
 ['UI exposes leakage cause SKU evidence and reason',ui.includes('Savings Leakage & Root Cause')&&ui.includes('<th>Cause</th>')&&ui.includes('<th>SKU</th>')&&ui.includes('<th>Evidence</th>')]
];
let failed=0;
for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Savings realization: ${name}`);if(!ok)failed++;}
if(failed){console.error(`Savings realization contract FAILED (${failed}/${checks.length} failed).`);process.exit(1);}
console.log(`Savings realization contract OK (${checks.length} checks).`);
