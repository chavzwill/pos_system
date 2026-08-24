(() => {
'use strict';

const ITEM_CLASS='tt-integrated-nav-item';
const ASSET_VERSION='20260824-0738';
const workspaces={
  repairEquipment:{css:'repair-operations.css',js:'repair-operations.js',global:'TotalToolsRepairOperations'},
  repairCommunications:{css:'repair-communications.css',js:'repair-communications.js',global:'TotalToolsRepairCommunications'},
  repairNotifications:{css:'repair-notifications.css',js:'repair-notifications.js',global:'TotalToolsRepairNotifications'},
  repairAuthorizations:{css:'repair-authorizations.css',js:'repair-authorizations.js',global:'TotalToolsRepairAuthorizations'},
  repairParts:{css:'repair-parts-integrity.css',js:'repair-parts-integrity.js',global:'TotalToolsRepairPartsIntegrity'},
  scheduling:{css:'scheduling-intelligence.css',js:'scheduling-intelligence.js',global:'TotalToolsSchedulingIntelligence'},
  technicianCompensation:{css:'technician-compensation.css',js:'technician-compensation.js',global:'TotalToolsTechnicianCompensation'},
  inventoryIntelligence:{css:'inventory-intelligence.css',js:'inventory-intelligence.js',global:'TotalToolsInventoryIntelligence'},
  logistics:{css:'logistics-intelligence.css',js:'logistics-intelligence.js',global:'TotalToolsLogisticsIntelligence'},
  smartTransfers:{css:'stock-rebalancing.css',js:'stock-rebalancing.js',global:'TotalToolsSmartTransfers'},
  accountingLedger:{css:'accounting-ledger.css',js:'accounting-ledger.js',global:'TotalToolsAccountingLedger',before:()=>fetch('/api/accounting-source-sync/sync',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'}}).catch(()=>null)},
  settlement:{css:'settlement-reconciliation.css',js:'settlement-reconciliation.js',global:'TotalToolsSettlementReconciliation'},
  supplierLedger:{css:'supplier-ledger.css',js:'supplier-ledger.js',global:'TotalToolsSupplierLedger'},
  financialControls:{css:'financial-controls-intelligence.css',js:'financial-controls-intelligence.js',global:'TotalToolsFinancialControlsIntelligence'},
  accountingIntelligence:{css:'accounting-intelligence.css',js:'accounting-intelligence.js',global:'TotalToolsAccountingIntelligence'},
  operationalReports:{css:'operational-reports.css',js:'operational-reports.js',global:'TotalToolsOperationalReports'}
};

function getApp(){try{if(typeof App!=='undefined'&&App)return App;}catch(_){}return window.App||null;}
function loggedIn(){return !!getApp()?.currentUser;}
function norm(value){return String(value||'').toLowerCase().replace(/\s+/g,' ').trim();}
function nav(){return document.querySelector('#sidebar .sidebar-nav')||document.querySelector('.sidebar-nav');}
function nativeItems(){const root=nav();return root?[...root.querySelectorAll('.nav-item')].filter(el=>!el.classList.contains(ITEM_CLASS)):[];}
function findNative(terms){const items=nativeItems();for(const term of terms){const n=norm(term);const exact=items.find(el=>norm(el.textContent)===n);if(exact)return exact;const starts=items.find(el=>norm(el.textContent).startsWith(n));if(starts)return starts;const contains=items.find(el=>norm(el.textContent).includes(n));if(contains)return contains;}return null;}
function removeIntegrated(){document.querySelectorAll('.'+ITEM_CLASS).forEach(el=>el.remove());}
function makeItem(id,label,onClick){const el=document.createElement('div');el.className=`nav-item ${ITEM_CLASS}`;el.setAttribute('role','button');el.setAttribute('tabindex','0');el.dataset.guideId=id;el.innerHTML=`<span class="tt-integrated-nav-icon" aria-hidden="true">↳</span><span>${label}</span>`;const activate=()=>{if(loggedIn())onClick();};el.addEventListener('click',activate);el.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();activate();}});return el;}
function addAfter(parentTerms,id,label,onClick){if(document.querySelector(`[data-guide-id="${id}"]`))return;const parent=findNative(parentTerms);if(parent)parent.insertAdjacentElement('afterend',makeItem(id,label,onClick));}
function openGuided(){document.getElementById('tt-guide-launcher')?.click();}
function loadCss(file){const id='tt-lazy-css-'+file.replace(/[^a-z0-9]/gi,'-');if(document.getElementById(id))return;const l=document.createElement('link');l.id=id;l.rel='stylesheet';l.href=`/${file}?v=${ASSET_VERSION}`;document.head.appendChild(l);}
function loadScript(file){const id='tt-lazy-js-'+file.replace(/[^a-z0-9]/gi,'-');return new Promise((resolve,reject)=>{const existing=document.getElementById(id);if(existing){if(existing.dataset.loaded==='1')resolve();else{existing.addEventListener('load',resolve,{once:true});existing.addEventListener('error',reject,{once:true});}return;}const s=document.createElement('script');s.id=id;s.src=`/${file}?v=${ASSET_VERSION}`;s.async=true;s.addEventListener('load',()=>{s.dataset.loaded='1';resolve();},{once:true});s.addEventListener('error',()=>reject(new Error(`Unable to load ${file}`)),{once:true});document.body.appendChild(s);});}
async function openWorkspace(key){const w=workspaces[key];if(!w)return;try{if(w.before)await w.before();loadCss(w.css);if(!window[w.global])await loadScript(w.js);window[w.global]?.open?.();}catch(e){console.error(`${key} workspace failed to load`,e);alert('This workspace could not be loaded. Please try again.');}}

function sync(){
  if(!loggedIn()){removeIntegrated();return;}
  if(!nav())return;
  addAfter(['work orders','repairs','service'],'nav-repair-equipment','Equipment & Repair History',()=>openWorkspace('repairEquipment'));
  addAfter(['work orders','repairs','service'],'nav-repair-communications','Customer Communication Timeline',()=>openWorkspace('repairCommunications'));
  addAfter(['work orders','repairs','service'],'nav-repair-notifications','Customer Notification Orchestration',()=>openWorkspace('repairNotifications'));
  addAfter(['work orders','repairs','service'],'nav-repair-authorizations','Diagnostics & Authorizations',()=>openWorkspace('repairAuthorizations'));
  addAfter(['work orders','repairs','service'],'nav-repair-parts-integrity','Parts Control & Availability',()=>openWorkspace('repairParts'));
  addAfter(['work orders','repairs','service'],'nav-scheduling-intelligence','Scheduling & Capacity Intelligence',()=>openWorkspace('scheduling'));
  addAfter(['work orders','repairs','service'],'nav-technician-compensation','Technician Compensation',()=>openWorkspace('technicianCompensation'));
  addAfter(['inventory','stock'],'nav-inventory-intelligence','Inventory Intelligence',()=>openWorkspace('inventoryIntelligence'));
  addAfter(['transfers','branch transfers'],'nav-logistics-intelligence','Dispatch & Logistics Intelligence',()=>openWorkspace('logistics'));
  addAfter(['transfers','branch transfers'],'nav-smart-transfers','Smart Transfer Recommendations',()=>openWorkspace('smartTransfers'));
  addAfter(['reports','reporting'],'nav-accounting-ledger','Accounting Ledger',()=>openWorkspace('accountingLedger'));
  addAfter(['reports','reporting'],'nav-settlement-reconciliation','Settlement Reconciliation',()=>openWorkspace('settlement'));
  addAfter(['reports','reporting'],'nav-supplier-ledger','Supplier Ledger & Payables',()=>openWorkspace('supplierLedger'));
  addAfter(['reports','reporting'],'nav-financial-controls-intelligence','Cash & Commitments',()=>openWorkspace('financialControls'));
  addAfter(['reports','reporting'],'nav-accounting-intelligence','Accounting Intelligence',()=>openWorkspace('accountingIntelligence'));
  addAfter(['reports','reporting'],'nav-operational-reports','Operational Reports',()=>openWorkspace('operationalReports'));
  addAfter(['dashboard'],'nav-guided-mode','Guided Mode',openGuided);
}
let queued=false;function queue(){if(queued)return;queued=true;requestAnimationFrame(()=>{queued=false;sync();});}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>setTimeout(sync,60));else setTimeout(sync,60);
new MutationObserver(queue).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['style','class']});
setInterval(sync,1500);
window.TotalToolsLazyWorkspace={open:openWorkspace};
})();
