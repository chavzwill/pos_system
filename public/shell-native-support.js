(()=>{'use strict';
const errorNotice=message=>window.TotalToolsShellUI?.toast?window.TotalToolsShellUI.toast(String(message||''),'error'):console.error(String(message||''));
const VERSION='20260825-0542';
let profile=null,profilePromise=null;
const opsAttention={key:'operations-attention',title:'Operational Attention Center',desc:'One evidence-backed management queue across inventory, purchasing, rentals, repairs, finance, cash controls and people risk.',anyPermission:['dashboard','reports','inventory','purchasing','work_orders','transactions','accounts'],css:'/ui-workspaces.css?v=20261017-design',js:'/operations-attention-center.js',global:'TotalToolsOperationsAttentionCenter'};
const techPerformance={key:'technician-performance',title:'Technician Performance Intelligence',desc:'Evidence-backed quality, efficiency, timeliness, rework, documentation and incentive-review intelligence.',anyPermission:['work_orders','reports','employees_salaries'],css:'/ui-workspaces.css?v=20261017-design',js:'/technician-compensation.js',global:'TotalToolsTechnicianCompensation'};
const techCoaching={key:'technician-coaching',title:'Technician Coaching & Follow-up',desc:'Turn performance evidence into accountable coaching, recognition, improvement plans and dated follow-up actions.',permission:'work_orders',css:'/ui-workspaces.css?v=20261017-design',js:'/technician-coaching.js',global:'TotalToolsTechnicianCoaching'};
const techManagement={key:'technician-management',title:'Technician Management Attention',desc:'Proactively surface overdue follow-ups, comeback risk, QC failures, safety events, timer anomalies and deteriorating timeliness.',anyPermission:['work_orders','reports','employees_salaries'],css:'/ui-workspaces.css?v=20261017-design',js:'/technician-management-intelligence.js',global:'TotalToolsTechnicianManagementIntelligence'};
const registry={
 sales:[opsAttention,
  {key:'drawer',title:'Cash Drawer & Reconciliation',desc:'Open drawer sessions, tender evidence, closures and reconciliation status.',permission:'drawers',css:'/ui-workspaces.css?v=20261017-design',js:'/cash-drawer-workspace.js',global:'TotalToolsCashDrawerWorkspace'},
  {key:'commerce',title:'Online Orders & Commerce Sync',desc:'SmartCommerce and WooCommerce orders, fulfilment evidence and online catalog readiness.',permission:'transactions',css:'/ui-workspaces.css?v=20261017-design',js:'/ecommerce-operations-workspace.js',global:'TotalToolsEcommerceOperations'}
 ],
 service:[opsAttention,techManagement,techPerformance,techCoaching],
 rentals:[opsAttention],
 dispatch:[opsAttention],
 inventory:[opsAttention,
  {key:'warehouse',title:'Warehouse Operations',desc:'Zones, bins, product locations and outbound shipment fulfilment.',permission:'warehouse',css:'/ui-workspaces.css?v=20261017-design',js:'/warehouse-operations-workspace.js',global:'TotalToolsWarehouseOperations'},
  {key:'suppliers',title:'Supplier Management',desc:'Supplier records, payment terms and recent purchasing context.',permission:'suppliers',css:'/ui-workspaces.css?v=20261017-design',js:'/suppliers-workspace.js',global:'TotalToolsSuppliersWorkspace'},
  {key:'catalog',title:'Products & Categories',desc:'Inventory master data, pricing, categories and online availability.',permission:'inventory',css:'/ui-workspaces.css?v=20261017-design',js:'/catalog-admin-workspace.js',global:'TotalToolsCatalogAdmin'},
  {key:'commerce',title:'Online Orders & Commerce Sync',desc:'SmartCommerce and WooCommerce orders, fulfilment evidence and online catalog readiness.',permission:'inventory',css:'/ui-workspaces.css?v=20261017-design',js:'/ecommerce-operations-workspace.js',global:'TotalToolsEcommerceOperations'}
 ],
 purchasing:[opsAttention,
  {key:'suppliers',title:'Supplier Management',desc:'Supplier records, payment terms and recent purchasing context.',permission:'suppliers',css:'/ui-workspaces.css?v=20261017-design',js:'/suppliers-workspace.js',global:'TotalToolsSuppliersWorkspace'}
 ],
 finance:[opsAttention,
  {key:'ar',title:'Accounts Receivable',desc:'Customer credit exposure, aging, invoice balances and controlled collections.',permission:'accounts',css:'/ui-workspaces.css?v=20261017-design',js:'/accounts-receivable-workspace.js',global:'TotalToolsAccountsReceivableWorkspace'},
  {key:'commissions',title:'Commissions & Incentives',desc:'Commission plans, assignments, earnings, approvals and payment status.',permission:'commissions',css:'/ui-workspaces.css?v=20261017-design',js:'/commissions-workspace.js',global:'TotalToolsCommissionsWorkspace'},
  {key:'drawer',title:'Cash Drawer & Reconciliation',desc:'Open drawer sessions, tender evidence, closures and reconciliation status.',permission:'drawers',css:'/ui-workspaces.css?v=20261017-design',js:'/cash-drawer-workspace.js',global:'TotalToolsCashDrawerWorkspace'}
 ],
 people:[opsAttention,techManagement,techPerformance,techCoaching,
  {key:'commissions',title:'Commissions & Incentives',desc:'Commission plans, assignments, earnings, approvals and payment status.',permission:'commissions',css:'/ui-workspaces.css?v=20261017-design',js:'/commissions-workspace.js',global:'TotalToolsCommissionsWorkspace'}
 ],
 administration:[opsAttention,
  {key:'integrations',title:'Integrations & API Access',desc:'Scoped API credentials and commerce integration readiness without exposing stored secrets.',permission:'settings',css:'/ui-workspaces.css?v=20261017-design',js:'/integration-admin-workspace.js',global:'TotalToolsIntegrationAdmin'},
  {key:'denominations',title:'Cash Denominations',desc:'Configure notes and coins used during drawer counting and reconciliation.',permission:'settings',css:'/ui-workspaces.css?v=20261017-design',js:'/denominations-workspace.js',global:'TotalToolsDenominationsWorkspace'},
  {key:'commerce',title:'E-commerce Operations',desc:'Operational oversight for connected commerce channels and fulfilment readiness.',permission:'settings',css:'/ui-workspaces.css?v=20261017-design',js:'/ecommerce-operations-workspace.js',global:'TotalToolsEcommerceOperations'}
 ],
 marketing:[
  {key:'programs',title:'Customer Benefit Programs',desc:'Discount-card and cash-back rules, enrollment exposure and redemption thresholds.',anyPermission:['discount-cards','cash-back-cards'],css:'/ui-workspaces.css?v=20261017-design',js:'/customer-programs-workspace.js',global:'TotalToolsCustomerProgramsWorkspace'}
 ]
};
function can(key){const p=profile?.permissions||{};if(p[key])return true;const prefix=key.replace(/-/g,'_')+'_';return Object.entries(p).some(([k,v])=>v&&(k===key||k.startsWith(prefix)));}
function allowed(item){return item.anyPermission?item.anyPermission.some(can):can(item.permission);}
function getProfile(){if(profile)return Promise.resolve(profile);if(profilePromise)return profilePromise;profilePromise=fetch('/api/workspace-profile/me',{credentials:'same-origin'}).then(r=>{if(!r.ok)throw new Error('profile');return r.json();}).then(p=>profile=p).catch(()=>null);return profilePromise;}
function currentDomain(){const active=document.querySelector('.shell-nav [data-domain].is-active');return active?.dataset.domain||'';}
function loadCss(href){return new Promise(resolve=>{if([...document.styleSheets].some(x=>x.href?.includes(href)))return resolve();const l=document.createElement('link');l.rel='stylesheet';l.href=`${href}?v=${VERSION}`;l.onload=resolve;l.onerror=resolve;document.head.appendChild(l);});}
function loadJs(src,global){return new Promise((resolve,reject)=>{if(window[global])return resolve();const id='tt-native-'+src.replace(/\W/g,'-');const old=document.getElementById(id);if(old){old.addEventListener('load',resolve,{once:true});return;}const s=document.createElement('script');s.id=id;s.src=`${src}?v=${VERSION}`;s.onload=resolve;s.onerror=()=>reject(new Error('Unable to load workspace'));document.body.appendChild(s);});}
async function open(item){try{await Promise.all([loadCss(item.css),loadJs(item.js,item.global)]);const api=window[item.global];if(!api?.open)throw new Error('Workspace did not initialize');const options=item.key==='programs'?{tab:can('discount-cards')?'discount':'cashback'}:item.key==='technician-performance'?{tab:'performance'}:{};await window.TotalToolsPresentation.mount(item.key,item.title,api,options);window.TotalToolsShellUI?.toast?.(`${item.title} opened.`,'success');}catch(e){if(window.TotalToolsShellUI?.toast)window.TotalToolsShellUI.toast(`${item.title} could not open: ${e.message}`,'error');else errorNotice(`${item.title} could not open: ${e.message}`);}}
function append(domain){const content=document.getElementById('shell-content');if(!content)return;const items=(registry[domain]||[]).filter(allowed);if(!items.length)return;let details=content.querySelector('.shell-more');if(!details){details=document.createElement('details');details.className='shell-more';details.innerHTML=`<summary>More ${(domain||'workspace').toLowerCase()} tools <span>0</span></summary><div class="shell-more__grid"></div>`;content.appendChild(details);}const grid=details.querySelector('.shell-more__grid');for(const item of items){if(grid.querySelector(`[data-native-support="${item.key}"]`))continue;const button=document.createElement('button');button.type='button';button.dataset.nativeSupport=item.key;button.innerHTML=`<span><strong>${item.title}</strong><small>${item.desc}</small></span><em>Open</em>`;button.addEventListener('click',()=>open(item));grid.appendChild(button);}const count=details.querySelector('summary span');if(count)count.textContent=grid.children.length;}
async function apply(){await getProfile();if(!profile)return;append(currentDomain());}
document.addEventListener('click',e=>{if(e.target.closest?.('.shell-nav [data-domain]'))setTimeout(apply,0);},true);
document.addEventListener('tt:shell-home',()=>void apply());
function start(){let tries=0;const tick=()=>{tries++;if(document.getElementById('shell-content')){apply();return;}if(tries<30)setTimeout(tick,80);};tick();}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();