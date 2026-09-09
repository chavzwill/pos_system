'use strict';
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const shell=fs.readFileSync(path.join(root,'public/app-shell.html'),'utf8');
const css=fs.readFileSync(path.join(root,'public/total-tools-ui-system.css'),'utf8');
const checks=[];const check=(name,pass)=>checks.push({name,pass:!!pass});
const banned=[
  'premium-shell-v2.css','premium-shell-v3.css','workspace-quality-pass.css',
  'late-2020s-workspaces.css','late-2020s-intelligence-finance.css','late-2020s-operations.css',
  'late-2020s-pos-commerce.css','late-2020s-admin-marketing.css','late-2020s-config-crm.css',
  'meeting-demo-shell.css','meeting-readiness.css','total-tools-premium-2026.css',
  'total-tools-premium-workspaces.css','total-tools-premium-details.css','total-tools-premium-runtime.css'
];
check('canonical UI system is loaded',shell.includes('/total-tools-ui-system.css'));
check('canonical UI system is loaded last among styles',shell.lastIndexOf('/total-tools-ui-system.css')>shell.lastIndexOf('rel="stylesheet"'));
check('historical conflicting shell layers are removed',banned.every(x=>!shell.includes('/'+x)));
check('Total Tools brand colors are explicit',css.includes('--tt-green:#006b3f')&&css.includes('--tt-yellow:#ffd400'));
check('desktop/tablet/mobile breakpoints exist',css.includes('@media(max-width:1220px)')&&css.includes('@media(max-width:900px)')&&css.includes('@media(max-width:560px)'));
check('mobile sidebar becomes off-canvas',css.includes('transform:translateX(-104%)')&&css.includes('.shell-app.menu-open .shell-sidebar'));
check('focus-visible treatment is defined',css.includes(':focus-visible')&&css.includes('--tt-focus'));
check('login and shell share one visual system',css.includes('.shell-login')&&css.includes('.shell-app')&&css.includes('.shell-card'));
for(const c of checks)console.log(`${c.pass?'PASS':'FAIL'} UI authority: ${c.name}`);
if(checks.some(c=>!c.pass))process.exit(1);
console.log(`Canonical UI authority contract OK (${checks.length} checks).`);
