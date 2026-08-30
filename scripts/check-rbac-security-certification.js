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
 ['settlement reconciliation still permits drawer managers',settlements.includes("'drawers_manage'")),
 ['technician compensation summary requires salary authority',compensation.includes("router.get('/summary', requirePermission('employees_salaries')")),
 ['technician pay rates require salary authority to read',compensation.includes("router.get('/rates', requirePermission('employees_salaries')")),
 ['technician pay snapshots require salary authority to read',compensation.includes("router.get('/snapshots', requirePermission('employees_salaries')")),
 ['technician pay changes require salary authority',compensation.includes("router.put('/rates/:employeeId', requirePermission('employees_salaries')")),
 ['technician adjustments require salary authority',compensation.includes("router.post('/adjustments', requirePermission('employees_salaries')")),
 ['technician finalization requires salary authority',compensation.includes("router.post('/finalize/:employeeId', requirePermission('employees_salaries')")),
 ['high-value writeoffs require financial/security authorizer authority',writeoffGuard.includes("can(p,'reports_financial')||can(p,'security_manage')")),
 ['writeoff creator cannot financially authorize own writeoff',writeoffGuard.includes('employee who created the write-off cannot provide its high-value financial authorization')),
 ['ordinary writeoff approval remains independently permissioned',writeoffs.includes("requirePermission('inventory_writeoff_approve')")),
 ['work-order completion remains separately signoff-permissioned',repairCompletion.includes("requirePermission('wo_signoff')")),
 ['logistics command center remains authenticated and permission-gated',logistics.includes("requirePermission('transfers')")),
 ['dispatch granularity is explicitly not inferred from generic report access',!logistics.includes("requirePermission('reports')")]
];
let failed=0;for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} RBAC/security certification: ${name}`);if(!ok)failed++;}
if(failed){console.error(`RBAC/security certification FAILED (${failed}/${checks.length} failed).`);process.exit(1);}
console.log(`RBAC/security certification OK (${checks.length} checks). Residual design item: dispatch still uses the transfers authority and should receive dedicated view/plan/execute permissions before final production RBAC sign-off.`);
