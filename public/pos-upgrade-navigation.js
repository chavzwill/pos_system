(() => {
'use strict';

const ITEM_CLASS='tt-integrated-nav-item';

function getApp(){
  try { if(typeof App!=='undefined' && App) return App; } catch (_) {}
  return window.App || null;
}
function loggedIn(){ return !!getApp()?.currentUser; }
function norm(value){ return String(value||'').toLowerCase().replace(/\s+/g,' ').trim(); }
function nav(){ return document.querySelector('#sidebar .sidebar-nav') || document.querySelector('.sidebar-nav'); }
function nativeItems(){ const root=nav(); return root ? [...root.querySelectorAll('.nav-item')].filter(el=>!el.classList.contains(ITEM_CLASS)) : []; }
function findNative(terms){ const items=nativeItems(); for(const term of terms){ const n=norm(term); const exact=items.find(el=>norm(el.textContent)===n); if(exact)return exact; const starts=items.find(el=>norm(el.textContent).startsWith(n)); if(starts)return starts; const contains=items.find(el=>norm(el.textContent).includes(n)); if(contains)return contains; } return null; }
function removeIntegrated(){ document.querySelectorAll('.'+ITEM_CLASS).forEach(el=>el.remove()); }
function makeItem(id,label,onClick){ const el=document.createElement('div'); el.className=`nav-item ${ITEM_CLASS}`; el.setAttribute('role','button'); el.setAttribute('tabindex','0'); el.dataset.guideId=id; el.innerHTML=`<span class="tt-integrated-nav-icon" aria-hidden="true">↳</span><span>${label}</span>`; const activate=()=>{if(loggedIn())onClick();}; el.addEventListener('click',activate); el.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();activate();}}); return el; }
function addAfter(parentTerms,id,label,onClick){ if(document.querySelector(`[data-guide-id="${id}"]`))return; const parent=findNative(parentTerms); if(parent)parent.insertAdjacentElement('afterend',makeItem(id,label,onClick)); }
function openGuided(){ document.getElementById('tt-guide-launcher')?.click(); }
function loadCss(href,id){ if(document.getElementById(id)) return; const l=document.createElement('link'); l.id=id; l.rel='stylesheet'; l.href=href; document.head.appendChild(l); }
function loadScript(src,id){ return new Promise((resolve,reject)=>{ const existing=document.getElementById(id); if(existing){ if(existing.dataset.loaded==='1')resolve(); else existing.addEventListener('load',resolve,{once:true}); return; } const s=document.createElement('script'); s.id=id; s.src=src; s.defer=true; s.addEventListener('load',()=>{s.dataset.loaded='1';resolve();},{once:true}); s.addEventListener('error',()=>reject(new Error('Unable to load workspace')),{once:true}); document.body.appendChild(s); }); }
async function openFinancialControls(){
  try{
    loadCss('/financial-controls-intelligence.css?v=20260824-0310','tt-fin-controls-css');
    if(!window.TotalToolsFinancialControlsIntelligence) await loadScript('/financial-controls-intelligence.js?v=20260824-0310','tt-fin-controls-js');
    window.TotalToolsFinancialControlsIntelligence?.open();
  }catch(e){ console.error('Financial controls workspace failed to load',e); }
}
async function openSupplierLedger(){
  try{
    loadCss('/supplier-ledger.css?v=20260824-0316','tt-supplier-ledger-css');
    if(!window.TotalToolsSupplierLedger) await loadScript('/supplier-ledger.js?v=20260824-0316','tt-supplier-ledger-js');
    window.TotalToolsSupplierLedger?.open();
  }catch(e){ console.error('Supplier ledger workspace failed to load',e); }
}
async function openSettlementReconciliation(){
  try{
    loadCss('/settlement-reconciliation.css?v=20260824-0317','tt-settlement-css');
    if(!window.TotalToolsSettlementReconciliation) await loadScript('/settlement-reconciliation.js?v=20260824-0317','tt-settlement-js');
    window.TotalToolsSettlementReconciliation?.open();
  }catch(e){ console.error('Settlement reconciliation workspace failed to load',e); }
}

function sync(){
  if(!loggedIn()){ removeIntegrated(); return; }
  if(!nav()) return;
  addAfter(['work orders','repairs','service'],'nav-repair-equipment','Equipment & Repair History',()=>window.TotalToolsRepairOperations?.open());
  addAfter(['work orders','repairs','service'],'nav-repair-authorizations','Diagnostics & Authorizations',()=>window.TotalToolsRepairAuthorizations?.open());
  addAfter(['work orders','repairs','service'],'nav-repair-parts-integrity','Parts Control & Availability',()=>window.TotalToolsRepairPartsIntegrity?.open());
  addAfter(['work orders','repairs','service'],'nav-scheduling-intelligence','Scheduling & Capacity Intelligence',()=>window.TotalToolsSchedulingIntelligence?.open());
  addAfter(['work orders','repairs','service'],'nav-technician-compensation','Technician Compensation',()=>window.TotalToolsTechnicianCompensation?.open());
  addAfter(['inventory','stock'],'nav-inventory-intelligence','Inventory Intelligence',()=>window.TotalToolsInventoryIntelligence?.open());
  addAfter(['transfers','branch transfers'],'nav-logistics-intelligence','Dispatch & Logistics Intelligence',()=>window.TotalToolsLogisticsIntelligence?.open());
  addAfter(['transfers','branch transfers'],'nav-smart-transfers','Smart Transfer Recommendations',()=>window.TotalToolsSmartTransfers?.open());
  addAfter(['reports','reporting'],'nav-settlement-reconciliation','Settlement Reconciliation',openSettlementReconciliation);
  addAfter(['reports','reporting'],'nav-supplier-ledger','Supplier Ledger & Payables',openSupplierLedger);
  addAfter(['reports','reporting'],'nav-financial-controls-intelligence','Cash & Commitments',openFinancialControls);
  addAfter(['reports','reporting'],'nav-accounting-intelligence','Accounting Intelligence',()=>window.TotalToolsAccountingIntelligence?.open());
  addAfter(['reports','reporting'],'nav-operational-reports','Operational Reports',()=>window.TotalToolsOperationalReports?.open());
  addAfter(['dashboard'],'nav-guided-mode','Guided Mode',openGuided);
}
let queued=false; function queue(){if(queued)return;queued=true;requestAnimationFrame(()=>{queued=false;sync();});}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>setTimeout(sync,100));else setTimeout(sync,100);
new MutationObserver(queue).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['style','class']});
setInterval(sync,750);
})();
