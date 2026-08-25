(()=>{'use strict';
const VERSION='20260825-0502';
let profile=null,profilePromise=null;
const techPerformance={key:'technician-performance',title:'Technician Performance Intelligence',desc:'Evidence-backed quality, efficiency, timeliness, rework, documentation and incentive-review intelligence.',anyPermission:['work_orders','reports','employees_salaries'],css:'/technician-compensation.css',js:'/technician-compensation.js',global:'TotalToolsTechnicianCompensation'};
const techCoaching={key:'technician-coaching',title:'Technician Coaching & Follow-up',desc:'Turn performance evidence into accountable coaching, recognition, improvement plans and dated follow-up actions.',permission:'work_orders',css:'/technician-coaching.css',js:'/technician-coaching.js',global:'TotalToolsTechnicianCoaching'};
const registry={
 sales:[
  {key:'drawer',title:'Cash Drawer & Reconciliation',desc:'Open drawer sessions, tender evidence, closures and reconciliation status.',permission:'drawers',css:'/cash-drawer-workspace.css',js:'/cash-drawer-workspace.js',global:'TotalToolsCashDrawerWorkspace'},
  {key:'commerce',title:'Online Orders & Commerce Sync',desc:'SmartCommerce and WooCommerce orders, fulfilment evidence and online catalog readiness.',permission:'transactions',css:'/ecommerce-operations-workspace.css',js:'/ecommerce-operations-workspace.js',global:'TotalToolsEcommerceOperations'}
 ],
 service:[techPerformance,techCoaching],
 inventory:[
  {key:'warehouse',title:'Warehouse Operations',desc:'Zones, bins, product locations and outbound shipment fulfilment.',permission:'warehouse',css:'/warehouse-operations-workspace.css',js:'/warehouse-operations-workspace.js',global:'TotalToolsWarehouseOperations'},
  {key:'suppliers',title:'Supplier Management',desc:'Supplier records, payment terms and recent purchasing context.',permission:'suppliers',css:'/suppliers-workspace.css',js:'/suppliers-workspace.js',global:'TotalToolsSuppliersWorkspace'},
  {key:'catalog',title:'Products & Categories',desc:'Inventory master data, pricing, categories and online availability.',permission:'inventory',css:'/catalog-admin-workspace.css',js:'/catalog-admin-workspace.js',global:'TotalToolsCatalogAdmin'},
  {key:'commerce',title:'Online Orders & Commerce Sync',desc:'SmartCommerce and WooCommerce orders, fulfilment evidence and online catalog readiness.',permission:'inventory',css:'/ecommerce-operations-workspace.css',js:'/ecommerce-operations-workspace.js',global:'TotalToolsEcommerceOperations'}
 ],
 purchasing:[
  {key:'suppliers',title:'Supplier Management',desc:'Supplier records, payment terms and recent purchasing context.',permission:'suppliers',css:'/suppliers-workspace.css',js:'/suppliers-workspace.js',global:'TotalToolsSuppliersWorkspace'}
 ],
 finance:[
  {key:'ar',title:'Accounts Receivable',desc:'Customer credit exposure, aging, invoice balances and controlled collections.',permission:'accounts',css:'/accounts-receivable-workspace.css',js:'/accounts-receivable-workspace.js',global:'TotalToolsAccountsReceivableWorkspace'},
  {key:'commissions',title:'Commissions & Incentives',desc:'Commission plans, assignments, earnings, approvals and payment status.',permission:'commissions',css:'/commissions-workspace.css',js:'/commissions-workspace.js',global:'TotalToolsCommissionsWorkspace'},
  {key:'drawer',title:'Cash Drawer & Reconciliation',desc:'Open drawer sessions, tender evidence, closures and reconciliation status.',permission:'drawers',css:'/cash-drawer-workspace.css',js:'/cash-drawer-workspace.js',global:'TotalToolsCashDrawerWorkspace'}
 ],
 people:[
  techPerformance,
  techCoaching,
  {key:'commissions',title:'Commissions & Incentives',desc:'Commission plans, assignments, earnings, approvals and payment status.',permission:'commissions',css:'/commissions-workspace.css',js:'/commissions-workspace.js',global:'TotalToolsCommissionsWorkspace'}
 ],
 administration:[
  {key:'integrations',title:'Integrations & API Access',desc:'Scoped API credentials and commerce integration readiness without exposing stored secrets.',permission:'settings',css:'/integration-admin-workspace.css',js:'/integration-admin-workspace.js',global:'TotalToolsIntegrationAdmin'},
  {key:'denominations',title:'Cash Denominations',desc:'Configure notes and coins used during drawer counting and reconciliation.',permission:'settings',css:'/denominations-workspace.css',js:'/denominations-workspace.js',global:'TotalToolsDenominationsWorkspace'},
  {key:'commerce',title:'E-commerce Operations',desc:'Operational oversight for connected commerce channels and fulfilment readiness.',permission:'settings',css:'/ecommerce-operations-workspace.css',js:'/ecommerce-operations-workspace.js',global:'TotalToolsEcommerceOperations'}
 ],
 marketing:[
  {key:'programs',title:'Customer Benefit Programs',desc:'Discount-card and cash-back rules, enrollment exposure and redemption thresholds.',anyPermission:['discount-cards','cash-back-cards'],css:'/customer-programs-workspace.css',js:'/customer-programs-workspace.js',global:'TotalToolsCustomerProgramsWorkspace'}
 ]
};
function can(key){const p=profile?.permissions||{};if(p[key])return true;const prefix=key.replace(/-/g,'_')+'_';return Object.entries(p).some(([k,v])=>v&&(k===key||k.startsWith(prefix)));}
function allowed(item){return item.anyPermission?item.anyPermission.some(can):can(item.permission);}
function getProfile(){if(profile)return Promise.resolve(profile);if(profilePromise)return profilePromise;profilePromise=fetch('/api/workspace-profile/me',{credentials:'same-origin'}).then(r=>{if(!r.ok)throw new Error('profile');return r.json();}).then(p=>profile=p).catch(()=>null);return profilePromise;}
function currentDomain(){const active=document.querySelector('.shell-nav [data-domain].is-active');return active?.dataset.domain||'';}
function loadCss(href){return new Promise(resolve=>{if([...document.styleSheets].some(x=>x.href?.includes(href)))return resolve();const l=document.createElement('link');l.rel='stylesheet';l.href=`${href}?v=${VERSION}`;l.onload=resolve;l.onerror=resolve;document.head.appendChild(l);});}
function loadJs(src,global){return new Promise((resolve,reject)=>{if(window[global])return resolve();const id='tt-native-'+src.replace(/\W/g,'-');const old=document.getElementById(id);if(old){old.addEventListener('load',resolve,{once:true});return;}const s=document.createElement('script');s.id=id;s.src=`${src}?v=${VERSION}`;s.onload=resolve;s.onerror=()=>reject(new Error('Unable to load workspace'));document.body.appendChild(s);});}
async function open(item){try{await Promise.all([loadCss(item.css),loadJs(item.js,item.global)]);const api=window[item.global];if(!api?.open)throw new Error('Workspace did not initialize');if(item.key==='programs')api.open({tab:can('discount-cards')?'discount':'cashback'});else if(item.key==='technician-performance')api.open({tab:'performance'});else api.open();}catch(e){alert(`${item.title} could not open: ${e.message}`);}}
function append(domain){const grid=document.getElementById('shell-grid');if(!grid)return;const items=(registry[domain]||[]).filter(allowed);for(const item of items){if(grid.querySelector(`[data-native-support="${item.key}"]`))continue;const card=document.createElement('article');card.className='shell-card shell-card--support';card.dataset.nativeSupport=item.key;card.innerHTML=`<div><strong>${item.title}</strong><p>${item.desc}</p></div><button type="button">Open</button>`;card.querySelector('button').addEventListener('click',()=>open(item));grid.appendChild(card);}}
async function apply(){await getProfile();if(!profile)return;append(currentDomain());}
document.addEventListener('click',e=>{if(e.target.closest?.('.shell-nav [data-domain]'))setTimeout(apply,0);},true);
function start(){let tries=0;const tick=()=>{tries++;if(document.getElementById('shell-grid')){apply();return;}if(tries<30)setTimeout(tick,80);};tick();}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();