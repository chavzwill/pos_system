'use strict';
const fs=require('fs'),path=require('path');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
let failed=0;
const check=(name,pass)=>pass?console.log('PASS Authoritative UI:',name):(failed++,console.error('FAIL Authoritative UI:',name));

const authority=read('public/unified-ui-system.css');
const shellCss=read('public/app-shell.css');
const salesCss=read('public/sales-workspace.css');
const shellHtml=read('public/app-shell.html');
const shellJs=read('public/app-shell.js');
const legacy=read('public/index.html');
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
  '.tt-logistics','.tt-li-panel','.tt-si-panel','.tt-rebalance',
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

check('home is task-led and written for staff',
  shellJs.includes('What do you want to do?') &&
  shellJs.includes('Live snapshot') &&
  shellJs.includes('Needs attention') &&
  shellJs.includes('More tools') &&
  shellJs.includes("service:'Repairs'") &&
  shellJs.includes("crm:'Customers'") &&
  shellJs.includes("administration:'Admin'")
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

check('full syntax wall includes authoritative ui contract',pkg.includes('check:unified-ui'));

if(failed){console.error('Authoritative UI contract failed: '+failed);process.exit(1)}
console.log('Authoritative UI contract passed.');
