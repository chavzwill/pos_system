'use strict';
const fs=require('fs'),path=require('path');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
let failed=0;
const check=(name,pass)=>pass?console.log('PASS Authoritative UI:',name):(failed++,console.error('FAIL Authoritative UI:',name));

const authority=read('public/unified-ui-system.css');
const shellCss=read('public/app-shell.css');
const salesCss=read('public/sales-workspace.css');
const salesJs=read('public/sales-workspace.js');
const inventoryJs=read('public/inventory-workspace.js');
const purchasingJs=read('public/purchasing-workspace.js');
const workOrdersJs=read('public/work-orders-workspace.js');
const workOrdersCss=read('public/work-orders-workspace.css');
const shellHtml=read('public/app-shell.html');
const shellJs=read('public/app-shell.js');
const legacy=read('public/index.html');
const manual=read('public/manual.html');
const manualCss=read('public/manual-ui-v2.css');
const preview=read('public/preview.html');
const previewCss=read('public/preview-ui-v2.css');
const pkg=read('package.json');
const server=read('server.js');

check('authoritative palette is exact',
  authority.includes('--tt-green:#0B7A3E') &&
  authority.includes('--tt-green-deep:#075C31') &&
  authority.includes('--tt-yellow:#F2D11F') &&
  authority.includes('--tt-bg:#F6F7F4') &&
  authority.includes('--tt-text:#111714')
);

check('spacing radius and control tokens are coherent',
  authority.includes('--tt-radius-sm:12px') &&
  authority.includes('--tt-radius-md:18px') &&
  authority.includes('--tt-radius-lg:24px') &&
  authority.includes('--tt-radius-xl:28px') &&
  authority.includes('--tt-control-h:48px') &&
  authority.includes('--tt-control-h-sm:44px')
);

const tiny = [...authority.matchAll(/font-size\s*:\s*([0-9.]+)px/gi)].map(m=>Number(m[1])).filter(n=>n<=10);
check('authoritative layer contains no staff text at 10px or below', tiny.length===0);

check('keyboard focus is explicit and visible',
  authority.includes(':focus-visible') &&
  authority.includes('outline:3px solid rgba(11,122,62,.20)')
);

check('reduced motion is respected globally',
  authority.includes('@media(prefers-reduced-motion:reduce)') &&
  authority.includes('animation:none!important') &&
  authority.includes('transition:none!important')
);

check('responsive laws cover desktop tablet and mobile',
  authority.includes('@media(max-width:1280px)') &&
  authority.includes('@media(max-width:1024px)') &&
  authority.includes('@media(max-width:768px)') &&
  authority.includes('@media(max-width:480px)')
);

check('tables stay scannable instead of becoming card grids',
  authority.includes('table{border-collapse:separate') &&
  authority.includes('th{font-size:12px!important') &&
  authority.includes('td{font-size:13px!important')
);

check('legacy literal palette remnants are neutralized by exact v2 selectors',
  authority.includes('.tt-op-reports-launcher{') &&
  authority.includes('.tt-settlement__panel{') &&
  authority.includes('.tt-purch__spinner{border-top-color:var(--tt-green)!important}') &&
  authority.includes('.tt-tech-score__coverage-bar span{background:var(--tt-green)!important}') &&
  authority.includes('.tt-purch__head:before{background:var(--tt-green)!important}')
);

check('status language has semantic success warning danger treatment',
  authority.includes('--tt-success:#11864A') &&
  authority.includes('--tt-warning:#C98B16') &&
  authority.includes('--tt-danger:#C44238') &&
  authority.includes('[class*="overdue"]')
);

check('controls meet the staff interaction size law',
  authority.includes('min-height:var(--tt-control-h-sm)!important') &&
  authority.includes('min-height:var(--tt-control-h)!important') &&
  authority.includes('border-radius:var(--tt-radius-sm)!important')
);

const sectors=[
  '.tt-sales','.tt-held','.tt-cc','cdw-panel','.tt-quotes','.tt-lw','.tt-promo',
  '.tt-rent','.tt-inv','.tt-tr','.tt-purch','suppliers-shell','.tt-supplier-ledger','wow-shell',
  '.tt-wo','.tt-repair-auth__panel','.tt-repair-comms__panel','.tt-rn__panel','.tt-repair-ops__panel','.tt-rpi-panel',
  '.tt-logistics','.tt-li-panel','.tt-si-panel','.tt-rebalance','.tt-settlement',
  '.tt-crm','.tt-cp','.tt-aiacct','.tt-ledger','.arw','.tt-finctl','.tt-op-reports',
  '.tt-admin','.tt-settings','.tt-rbac','.iaw','catalog-admin-panel',
  'ecom-shell','cm-shell','denom-shell','.tt-tmi','.tt-tech-pay','.tt-coach',
  '.tt-ea-modal','.tt-learn','.tt-employee-workspace-home','.tt-guide',
  '.tt-po-document-context','.tt-po-dialog','.tt-qi__panel','.rc-wizard-review','.tt-cat__panel',
  '.tt-predictive-list'
];
check('all major frontend sectors are governed by the authoritative layer',
  sectors.every(token=>authority.includes(token))
);

check('global authority preserves the sales reference hierarchy',
  authority.includes('.tt-sales__head h2{font-size:30px!important') &&
  authority.includes('.tt-sales__product strong{font-size:15px!important') &&
  authority.includes('.tt-sales__totals div.total{font-size:22px!important')
);

check('frontline reference surfaces keep their dedicated v2 implementations',
  shellCss.includes('--tt-green:#0B7A3E') &&
  !/(?:font-size:)\s*(?:[1-9]|10)(?:px)/.test(shellCss) &&
  salesCss.includes('--sales-green:#0B7A3E') &&
  !/(?:font-size:)\s*(?:[1-9]|10)(?:px)/.test(salesCss)
);

check('shell removes retired competing theme layers',
  !shellHtml.includes('/premium-shell-v2.css') &&
  !shellHtml.includes('/premium-shell-v3.css') &&
  !shellHtml.includes('/late-2020s-') &&
  !shellHtml.includes('/workspace-quality-pass.css')
);

check('shell loads authoritative system last among static styles',
  shellHtml.includes('id="tt-authoritative-ui"') &&
  shellHtml.indexOf('/unified-ui-system.css') > shellHtml.indexOf('/employee-learning-center.css')
);

check('dynamic workspace css is inserted before authoritative system',
  shellJs.includes("document.getElementById('tt-authoritative-ui')") &&
  shellJs.includes('document.head.insertBefore(l,authority)')
);

const moduleCss=[...shellJs.matchAll(/['"]([^'"]+\.css)['"]/g)].map(m=>m[1].replace(/^\//,''));
check('every dynamically declared workspace stylesheet exists',
  moduleCss.length>=20 && moduleCss.every(file=>fs.existsSync(path.join(root,'public',path.basename(file))))
);

check('home is task-led, quiet and written for staff',
  shellJs.includes('What do you need?') &&
  shellJs.includes('Today at a glance') &&
  shellJs.includes('Needs attention') &&
  shellJs.includes('function domainIntro(') &&
  shellJs.includes('function moreCards(') &&
  shellJs.includes("service:'Repairs'") &&
  shellJs.includes("crm:'Customers'") &&
  shellJs.includes("administration:'Admin'")
);

check('purchasing landing keeps four clear first-level destinations',
  shellJs.includes("purchasing:[['Suppliers'") &&
  shellJs.includes("['Purchase Orders'") &&
  shellJs.includes("['Purchase Requests'") &&
  shellJs.includes("['Receiving'") &&
  shellJs.includes("'suppliers-workspace':['/suppliers-workspace.css'") &&
  purchasingJs.includes('async function open(opts={})')
);

check('advanced tools are progressively disclosed instead of always visible',
  shellJs.includes('<details class="shell-more">') &&
  shellCss.includes('.shell-more summary') &&
  shellCss.includes('.shell-choice-grid') &&
  shellCss.includes('.shell-quiet-section--snapshot')
);

check('quick command removes navigation hunting for permitted tasks',
  shellJs.includes("RECENT_TASKS_KEY='tt:shell:recent-tasks'") &&
  shellJs.includes('function commandCatalog()') &&
  shellJs.includes('function openCommand(') &&
  shellJs.includes("String(e.key).toLowerCase()==='k'") &&
  shellJs.includes('allowedFeature(key)') &&
  shellJs.includes('rememberTask(key,title)')
);

check('shell feedback avoids blocking alerts for shell-level support and module failures',
  shellJs.includes('function showToast(') &&
  shellJs.includes("window.TotalToolsShellUI={command:openCommand,toast:showToast}") &&
  shellJs.includes("showToast(`${title||'Workspace'} could not open") &&
  !shellJs.includes("else alert('Guide Me is available inside supported tasks.')") &&
  !shellJs.includes("else alert('Help & Learning is still loading. Please try again.')")
);

check('quick command is responsive and keyboard accessible',
  shellCss.includes('.shell-command__panel') &&
  shellCss.includes('.shell-command-result') &&
  shellCss.includes('.shell-command-button') &&
  shellCss.includes('.shell-toast-host') &&
  shellCss.includes('max-height:calc(100dvh - 16px)')
);

check('recent task recovery is one tap from home',
  shellJs.includes('function continueWorking()') &&
  shellJs.includes('Pick up where you left off') &&
  shellJs.includes("document.getElementById('shell-resume-all')") &&
  shellJs.includes('rememberTask(key,title);renderWorkspace(currentDomain)') &&
  shellCss.includes('.shell-resume__list') &&
  shellCss.includes('.shell-resume__item')
);

check('sales is scanner and keyboard first without weakening checkout confirmation',
  salesJs.includes('function focusProductSearch(') &&
  salesJs.includes('function bindSalesShortcuts()') &&
  salesJs.includes("e.key==='F2'") &&
  salesJs.includes("e.key==='F3'") &&
  salesJs.includes('aria-keyshortcuts="/"') &&
  salesJs.includes("if(!confirm(`Complete this sale") &&
  salesJs.includes("notice('Cash tendered cannot be less than the sale total.','error')") &&
  salesCss.includes('.tt-sales__shortcuts')
);

check('inventory is search-first without weakening adjustment control',
  inventoryJs.includes('function focusSearch(') &&
  inventoryJs.includes('function bindShortcuts()') &&
  inventoryJs.includes("e.key==='F2'") &&
  inventoryJs.includes("e.key==='F3'") &&
  inventoryJs.includes('aria-keyshortcuts="/"') &&
  inventoryJs.includes("if(!confirm(`Adjust ${state.selected.name}") &&
  inventoryJs.includes("notice('A reason is required for every stock adjustment.','error')")
);

check('purchasing accelerates document entry while preserving authority boundaries',
  purchasingJs.includes('function focusComposer(') &&
  purchasingJs.includes('function focusLine(index)') &&
  purchasingJs.includes("e.key==='F2'") &&
  purchasingJs.includes("e.key==='F3'") &&
  purchasingJs.includes('aria-keyshortcuts="F2"') &&
  purchasingJs.includes('aria-keyshortcuts="F3"') &&
  purchasingJs.includes("confirm('Cancel this purchase order?')") &&
  purchasingJs.includes("confirm('Post these received quantities into inventory?')") &&
  purchasingJs.includes("notice('Enter at least one quantity received.','error')")
);

check('repairs uses a calm search-first queue with progressive detail',
  workOrdersJs.includes('function focusSearch(') &&
  workOrdersJs.includes('function bindShortcuts()') &&
  workOrdersJs.includes("e.key==='F2'") &&
  workOrdersJs.includes("e.key==='F3'") &&
  workOrdersJs.includes('aria-keyshortcuts="/"') &&
  workOrdersJs.includes('tt-wo__disclosure') &&
  workOrdersJs.includes('<h3>Quality check</h3>') &&
  workOrdersCss.includes('.tt-wo__disclosure summary') &&
  workOrdersCss.includes('.tt-wo__shortcuts') &&
  workOrdersCss.includes('font-size:16px!important') &&
  !/(?:font-size:)\s*(?:[1-9]|10)(?:px)/.test(workOrdersCss)
);

check('legacy source still declares authoritative ui after feature styles',
  legacy.indexOf('/unified-ui-system.css') > legacy.indexOf('/rental-create-wizard.css')
);

check('legacy runtime strips retired competing themes before rendering',
  server.includes('retiredThemePattern') &&
  server.includes('premium-shell-v2|premium-shell-v3') &&
  server.includes('late-2020s-workspaces') &&
  server.includes('workspace-quality-pass') &&
  server.includes('unified-ui-system)')
);

check('legacy runtime injects a single authoritative stylesheet last',
  server.includes('id="tt-authoritative-ui"') &&
  server.includes("versioned('/unified-ui-system.css')") &&
  server.indexOf("versioned('/unified-ui-system.css')") > server.indexOf("versioned('/employee-assist-ui.css')")
);

check('legacy runtime cache version is advanced for ui v2',
  server.includes("CLIENT_ASSET_VERSION = '20260922-ui-v2-all'")
);

check('staff manual does not publish retired credential guidance',
  !manual.includes('123456') &&
  !manual.includes('stored and checked in plain text') &&
  manual.includes('fresh production installation does not create a usable default administrator password') &&
  manual.includes('Passwords and staff PINs are protected using secure password hashing')
);

check('staff manual describes the simple task-led home',
  manual.includes('<h2 class="module">Home</h2>') &&
  manual.includes('What do you need?') &&
  manual.includes('Today at a glance') &&
  manual.includes('Needs attention') &&
  manual.includes('More tools') &&
  manual.includes('Suppliers, Purchase Orders, Purchase Requests, and Receiving')
);

check('staff manual is governed by ui v2',
  manual.includes('/manual-ui-v2.css?v=20260922-ui-v2-all') &&
  manual.includes('<title>Total Tools — Staff Manual</title>') &&
  manualCss.includes('--manual-green:#0B7A3E') &&
  !/(?:font-size:)\s*(?:[1-9]|10)(?:px)/.test(manualCss) &&
  manualCss.includes('@media(prefers-reduced-motion:reduce)')
);

check('standalone preview is governed by ui v2',
  preview.includes('/preview-ui-v2.css?v=20260922-ui-v2-all') &&
  preview.includes('Total Tools — UI V2 Preview') &&
  previewCss.includes('--g:#0B7A3E!important') &&
  !/(?:font-size:)\s*(?:[1-9]|10)(?:px)/.test(previewCss) &&
  previewCss.includes('@media(prefers-reduced-motion:reduce)')
);

check('all four html surfaces have an authoritative v2 path',
  shellHtml.includes('/unified-ui-system.css') &&
  server.includes("versioned('/unified-ui-system.css')") &&
  manual.includes('/manual-ui-v2.css') &&
  preview.includes('/preview-ui-v2.css')
);

check('full syntax wall includes authoritative ui contract',pkg.includes('check:unified-ui'));

if(failed){console.error('Authoritative UI contract failed: '+failed);process.exit(1)}
console.log('Authoritative UI contract passed.');
