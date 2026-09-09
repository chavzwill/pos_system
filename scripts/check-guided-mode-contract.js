'use strict';
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');
const shell=read('public/app-shell.html');
const deferred=read('public/shell-deferred.js');
const loader=read('public/workspace-loader-hardening.js');
const guide=read('public/guided-mode.js');
const stability=read('public/native-pos-stability.css');
const roleUi=read('public/role-operations-dashboard.js');
const checks=[];
function check(name,pass){checks.push({name,pass:!!pass});}
check('workspace loader precedes deferred guide',shell.indexOf('/workspace-loader-hardening.js')>=0&&shell.indexOf('/workspace-loader-hardening.js')<shell.indexOf('/shell-deferred.js'));
check('authoritative guide is the only deferred Guided Mode runtime',deferred.includes("'/guided-mode.js'")&&!deferred.includes("'/guided-mode-orchestrator.js'")&&!deferred.includes("'/guided-mode-exact-action.js'")&&!deferred.includes("'/guided-mode-exact-fallback.js'"));
check('single shell loader API',loader.includes('window.TotalToolsShellOpen=openFeature')&&loader.includes('window.TotalToolsWorkspaceLoader'));
check('Guided Mode exposes stable public API',guide.includes('window.TotalToolsGuidedMode={open,close,chooseTask')&&guide.includes('tasks:TASKS'));
check('Guided Mode routes normal workspaces through hardened loader',guide.includes('window.TotalToolsShellOpen')&&guide.includes('await window.TotalToolsShellOpen(task.feature'));
check('Guided Mode routes role dashboards directly',guide.includes('window.TotalToolsRoleDashboards')&&guide.includes("dispatch:'openDispatch'")&&guide.includes("security:'openSecurity'")&&guide.includes("accounts:'openAccounts'"));
check('Guided Mode only advances chosen tasks after routing attempt',guide.includes('const routed=await routeTask(task);if(routed)setTimeout'));
check('Guided Mode never invents inaccessible controls',guide.includes('It will not invent controls')||guide.includes('safest next control available to your permissions'));
check('role dashboards expose Guided Mode targets',roleUi.includes('data-guide-id="dispatch-control"')&&roleUi.includes('data-guide-id="security-dashboard"')&&roleUi.includes('data-guide-id="accounts-dashboard"'));
check('guide stays above role dashboards',stability.includes('#tt-guided-mode{position:fixed;inset:0;z-index:7000')&&stability.includes('body:has(#role-ops-dashboard) .tt-guide'));
check('guide does not block role dashboard while coaching',stability.includes('body:has(#role-ops-dashboard) .tt-guide-backdrop')&&stability.includes('pointer-events:none'));
check('guide has mobile treatment',stability.includes('@media(max-width:860px)')&&stability.includes('.tt-guide__suggestions{grid-template-columns:1fr}'));
const taskIds=['sale','hold','return','repair','rental','dispatch','dispatch-control','driver-dashboard','security-dashboard','accounts-dashboard','inventory-adjust','count','pr','po','transfer','reports','compensation'];
for(const id of taskIds)check(`task registered: ${id}`,guide.includes(`id:'${id}'`));
const routeExpectations=[
 ['sale','sales-workspace'],['hold','held-sales-workspace'],['return','cashier-controls-workspace'],['repair','work-orders-workspace'],['rental','rentals-workspace'],['dispatch','logistics-intelligence'],['inventory-adjust','inventory-workspace'],['count','inventory-workspace'],['pr','purchasing-workspace'],['po','purchasing-workspace'],['transfer','transfers-workspace'],['reports','operational-reports']
];
for(const [id,key] of routeExpectations){const re=new RegExp(`id:'${id}'[^\\n]*feature:'${key}'`);check(`task ${id} routes to ${key}`,re.test(guide));}
for(const c of checks)console.log(`${c.pass?'PASS':'FAIL'} Guided Mode: ${c.name}`);
if(checks.some(c=>!c.pass))process.exit(1);
console.log(`Guided Mode contract OK (${checks.length} checks against the authoritative runtime).`);
