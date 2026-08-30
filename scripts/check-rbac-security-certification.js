'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const permissions=read('lib/permissions.js');
const apiAuth=read('lib/apiKeyAuth.js');
const apiKeys=read('routes/api-keys.js');
const sessionAuth=read('lib/sessionAuth.js');
const ledger=read('routes/accounting-ledger.js');
const settlements=read('routes/settlement-reconciliation-financial-guard.js');
const compensation=read('routes/technician-compensation.js');
const writeoffGuard=read('routes/inventory-writeoff-financial-guard.js');
const writeoffs=read('routes/inventory-writeoffs.js');
const repairCompletion=read('routes/work-order-completion-hardening.js');
const logistics=read('routes/logistics-intelligence.js');
for(const [name,src] of Object.entries({permissions,apiAuth,apiKeys,sessionAuth,ledger,settlements,compensation,writeoffGuard,writeoffs,repairCompletion,logistics}))new vm.Script(src,{filename:name});
const checks=[
 ['server RBAC tree defines granular financial and destructive permissions',permissions.includes('reports_financial')&&permissions.includes('inventory_writeoff_create')&&permissions.includes('inventory_writeoff_approve')&&permissions.includes('employees_salaries')],
 ['rental management compatibility alias does not create a new authority',permissions.includes("rentals_manage: 'rentals_manage_items'")],
 ['Dispatch is a first-class permission module',permissions.includes("{ key: 'dispatch', subs:")),
 ['Dispatch board visibility has dedicated authority',permissions.includes("{ key: 'dispatch_view' }")),
 ['Dispatch planning has dedicated authority',permissions.includes("{ key: 'dispatch_plan' }")),
 ['Dispatch field execution has dedicated authority',permissions.includes("{ key: 'dispatch_execute' }")),
 ['Dispatch administration has dedicated authority',permissions.includes("{ key: 'dispatch_admin' }")),
 ['legacy transfer roles are compatibility-mapped only when no explicit Dispatch authority exists',permissions.includes('hasExplicitDispatch')&&permissions.includes('legacyDispatch')],
 ['Dispatch endpoint classifier uses the logistics API boundary',permissions.includes("startsWith('/api/logistics-intelligence')")],
 ['commercial department handoffs remain source-authority workflows',permissions.includes("return 'source_handoff'")&&permissions.includes("return 'continue'")),
 ['source document viewing remains available to Dispatch or owning business department',permissions.includes("'source_document'")&&permissions.includes("'purchasing','transactions','rentals','work_orders'")),
 ['vehicle/service-zone/location administration requires Dispatch Admin',permissions.includes("return 'dispatch_admin'")),
 ['field stages/proof/route-stop execution require Dispatch Execute',permissions.includes("return 'dispatch_execute'")),
 ['route/job planning and assignment require Dispatch Plan',permissions.includes("return 'dispatch_plan'")),
 ['unknown Dispatch mutations fail closed',permissions.includes('dispatch_rbac_unclassified')],
 ['API keys cannot operate internal Dispatch workflows',permissions.includes('API keys cannot operate internal Dispatch workflows')],
 ['authorized Dispatch requests short-circuit legacy transfer permission checks',permissions.includes("if(dispatch==='allow')return next()")],
 ['department handoffs still continue into their original business permission checks',permissions.includes("if(required==='source_handoff')return 'continue'")),
 ['API keys fail closed outside explicit integration endpoints',apiAuth.includes("if (!needed) return res.status(403)")&&apiAuth.includes('API keys are not permitted on this employee endpoint')],
 ['legacy API wildcard cannot unlock unmapped employee APIs',apiAuth.includes("scopes.includes('*')")&&apiAuth.indexOf('if (!needed) return res.status(403)')<apiAuth.indexOf("scopes.includes('*')")],
 ['API key scopes include repair portal scopes explicitly',apiKeys.includes("'repairs:read'")&&apiKeys.includes("'repairs:write'")),
 ['new API keys do not default to wildcard',apiKeys.includes("scopes = ['products:read']")&&!apiKeys.includes("scopes = ['*']")),
 ['API key administration requires integration-settings authority',apiKeys.includes("requirePermission('settings_integrations')")),
 ['API key creation requires at least one explicit valid scope',apiKeys.includes('At least one valid explicit API scope is required')],
 ['automatic accounting sync mutations are centrally restricted to financial authority',sessionAuth.includes("path.startsWith('/api/accounting-source-sync/')")&&sessionAuth.includes("reports_financial")),
 ['ledger GETs preserve reporting access',ledger.includes("if(req.method==='GET') return requireAnyPermission('reports_financial','reports')")),
 ['ledger mutations require financial authority',ledger.includes("return requirePermission('reports_financial')")),
 ['manual account creation cannot be performed by general report access alone',ledger.includes("router.post('/accounts'")&&ledger.includes("requirePermission('reports_financial')")),
 ['journal creation is behind the financial mutation gate',ledger.includes("router.post('/journals'")&&ledger.includes("requirePermission('reports_financial')")),
 ['journal posting is behind the financial mutation gate',ledger.includes("router.post('/journals/:id/post'")),
 ['journal reversal is behind the financial mutation gate',ledger.includes("router.post('/journals/:id/reverse'")),
 ['settlement mutation excludes ordinary report-reader authority',settlements.includes("requireAnyPermission('reports_financial','drawers_manage')")&&!settlements.includes("'drawers_manage','reports'")),
 ['technician compensation summary requires salary authority',compensation.includes("router.get('/summary', requirePermission('employees_salaries')")),
 ['technician pay rates require salary authority to read',compensation.includes("router.get('/rates', requirePermission('employees_salaries')")),
 ['technician pay snapshots require salary authority to read',compensation.includes("router.get('/snapshots', requirePermission('employees_salaries')")),
 ['high-value writeoffs require financial/security authorizer authority',writeoffGuard.includes("can(p,'reports_financial')||can(p,'security_manage')")),
 ['ordinary writeoff approval remains independently permissioned',writeoffs.includes("requirePermission('inventory_writeoff_approve')")),
 ['work-order completion remains separately signoff-permissioned',repairCompletion.includes("requirePermission('wo_signoff')"))
];
let failed=0;for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} RBAC/security certification: ${name}`);if(!ok)failed++;}
if(failed){console.error(`RBAC/security certification FAILED (${failed}/${checks.length} failed).`);process.exit(1);}
console.log(`RBAC/security certification OK (${checks.length} checks). Dispatch view/plan/execute/admin authority is explicit, supersedes legacy transfer gates, and unknown logistics mutations fail closed.`);
