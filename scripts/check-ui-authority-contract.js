'use strict';
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const shell=fs.readFileSync(path.join(root,'public/app-shell.html'),'utf8');
const css=fs.readFileSync(path.join(root,'public/total-tools-ui-system.css'),'utf8');
const workspaceCss=fs.readFileSync(path.join(root,'public/total-tools-workspace-ui.css'),'utf8');
const refinementCss=fs.readFileSync(path.join(root,'public/total-tools-workspace-refinement.css'),'utf8');
const secondaryCss=fs.readFileSync(path.join(root,'public/total-tools-secondary-workspace-refinement.css'),'utf8');
const checks=[];const check=(name,pass)=>checks.push({name,pass:!!pass});
const banned=[
  'premium-shell-v2.css','premium-shell-v3.css','workspace-quality-pass.css',
  'late-2020s-workspaces.css','late-2020s-intelligence-finance.css','late-2020s-operations.css',
  'late-2020s-pos-commerce.css','late-2020s-admin-marketing.css','late-2020s-config-crm.css',
  'meeting-demo-shell.css','meeting-readiness.css','total-tools-premium-2026.css',
  'total-tools-premium-workspaces.css','total-tools-premium-details.css','total-tools-premium-runtime.css'
];
check('canonical shell UI system is loaded',shell.includes('/total-tools-ui-system.css'));
check('canonical workspace UI system is loaded',shell.includes('/total-tools-workspace-ui.css'));
check('targeted primary workspace refinement is loaded',shell.includes('/total-tools-workspace-refinement.css'));
check('secondary workspace refinement is loaded',shell.includes('/total-tools-secondary-workspace-refinement.css'));
check('secondary workspace refinement is the final stylesheet',shell.lastIndexOf('/total-tools-secondary-workspace-refinement.css')>shell.lastIndexOf('/total-tools-workspace-refinement.css')&&shell.indexOf('rel="stylesheet"',shell.lastIndexOf('/total-tools-secondary-workspace-refinement.css'))<0);
check('historical conflicting shell layers are removed',banned.every(x=>!shell.includes('/'+x)));
check('obsolete meeting demo DOM enhancer is not loaded',!shell.includes('/meeting-demo-shell.js'));
check('Total Tools shell brand colors are explicit',css.includes('--tt-green:#006b3f')&&css.includes('--tt-yellow:#ffd400'));
check('Total Tools workspace brand colors are explicit',workspaceCss.includes('--ttw-green:#006b3f')&&workspaceCss.includes('--ttw-yellow:#ffd400'));
check('desktop/tablet/mobile shell breakpoints exist',css.includes('@media(max-width:1220px)')&&css.includes('@media(max-width:900px)')&&css.includes('@media(max-width:560px)'));
check('workspace desktop/tablet/mobile breakpoints exist',workspaceCss.includes('@media(max-width:1200px)')&&workspaceCss.includes('@media(max-width:900px)')&&workspaceCss.includes('@media(max-width:560px)'));
check('primary refinement covers desktop/tablet/mobile breakpoints',refinementCss.includes('@media(max-width:1180px)')&&refinementCss.includes('@media(max-width:900px)')&&refinementCss.includes('@media(max-width:560px)'));
check('secondary refinement covers desktop/tablet/mobile breakpoints',secondaryCss.includes('@media(max-width:1000px)')&&secondaryCss.includes('@media(max-width:900px)')&&secondaryCss.includes('@media(max-width:560px)'));
check('mobile sidebar becomes off-canvas',css.includes('transform:translateX(-104%)')&&css.includes('.shell-app.menu-open .shell-sidebar'));
check('shell focus-visible treatment is defined',css.includes(':focus-visible')&&css.includes('--tt-focus'));
check('workspace focus-visible treatment is defined',workspaceCss.includes(':focus-visible')&&workspaceCss.includes('--ttw-yellow'));
check('login and shell share one visual system',css.includes('.shell-login')&&css.includes('.shell-app')&&css.includes('.shell-card'));
check('sales workspace receives explicit hierarchy',workspaceCss.includes('.tt-sales__body')&&workspaceCss.includes('.tt-sales__totals div.total'));
check('rentals and purchasing share split-view authority',workspaceCss.includes('.tt-rent__panel')&&workspaceCss.includes('.tt-purch__panel'));
check('role dashboards share canonical workspace geometry',workspaceCss.includes('.role-dash')&&workspaceCss.includes('.role-metric'));
check('repairs refinement is explicit',refinementCss.includes('.tt-wo__layout')&&refinementCss.includes('.tt-wo__quality-state'));
check('inventory refinement is explicit',refinementCss.includes('.tt-inv__body')&&refinementCss.includes('.tt-inv__adjust'));
check('dispatch refinement is explicit',refinementCss.includes('.tt-li-grid')&&refinementCss.includes('.tt-li-route'));
check('finance refinement is explicit',refinementCss.includes('.tt-aiacct-kpis')&&refinementCss.includes('.tt-aiacct-exception'));
check('CRM refinement is explicit',refinementCss.includes('.tt-crm__body')&&refinementCss.includes('.tt-crm__pipeline'));
check('administration refinement is explicit',refinementCss.includes('.tt-admin__grid')&&refinementCss.includes('.tt-admin__form-grid'));
check('quotation refinement is explicit',secondaryCss.includes('.tt-quotes__toolbar')&&secondaryCss.includes('.tt-quote-card'));
check('held sale refinement is explicit',secondaryCss.includes('.tt-held__body')&&secondaryCss.includes('.tt-held__payment'));
check('layaway refinement is explicit',secondaryCss.includes('.tt-lw__body')&&secondaryCss.includes('.tt-lw-detail'));
check('cashier controls refinement is explicit',secondaryCss.includes('.tt-cc__body')&&secondaryCss.includes('.tt-cc__action'));
check('settings refinement is explicit',secondaryCss.includes('.tt-settings__grid')&&secondaryCss.includes('.tt-settings__field'));
check('RBAC refinement is explicit',secondaryCss.includes('.tt-rbac__permission-grid')&&secondaryCss.includes('.tt-rbac__warning'));
check('system health refinement is explicit',secondaryCss.includes('.tt-mr__summary')&&secondaryCss.includes('.tt-mr__checks'));
for(const c of checks)console.log(`${c.pass?'PASS':'FAIL'} UI authority: ${c.name}`);
if(checks.some(c=>!c.pass))process.exit(1);
console.log(`Canonical UI authority contract OK (${checks.length} checks).`);
