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

function nativeItems(){
  const root=nav();
  return root ? [...root.querySelectorAll('.nav-item')].filter(el=>!el.classList.contains(ITEM_CLASS)) : [];
}
function findNative(terms){
  const items=nativeItems();
  for(const term of terms){
    const n=norm(term);
    const exact=items.find(el=>norm(el.textContent)===n); if(exact) return exact;
    const starts=items.find(el=>norm(el.textContent).startsWith(n)); if(starts) return starts;
    const contains=items.find(el=>norm(el.textContent).includes(n)); if(contains) return contains;
  }
  return null;
}
function removeIntegrated(){ document.querySelectorAll('.'+ITEM_CLASS).forEach(el=>el.remove()); }

function makeItem(id,label,onClick){
  const el=document.createElement('div');
  el.className=`nav-item ${ITEM_CLASS}`;
  el.setAttribute('role','button');
  el.setAttribute('tabindex','0');
  el.dataset.guideId=id;
  el.innerHTML=`<span class="tt-integrated-nav-icon" aria-hidden="true">↳</span><span>${label}</span>`;
  const activate=()=>{ if(loggedIn()) onClick(); };
  el.addEventListener('click',activate);
  el.addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); activate(); } });
  return el;
}
function insertAfter(parent,item){ parent.insertAdjacentElement('afterend',item); }
function addAfter(parentTerms,id,label,onClick){
  if(document.querySelector(`[data-guide-id="${id}"]`)) return;
  const parent=findNative(parentTerms);
  if(parent) insertAfter(parent,makeItem(id,label,onClick));
}
function openGuided(){
  const launcher=document.getElementById('tt-guide-launcher');
  if(launcher) launcher.click();
}

function sync(){
  if(!loggedIn()){ removeIntegrated(); return; }
  const root=nav(); if(!root) return;

  // New capabilities are incorporated into the business area they improve.
  addAfter(['work orders','repairs','service'],'nav-repair-equipment','Equipment & Repair History',()=>window.TotalToolsRepairOperations?.open());
  addAfter(['work orders','repairs','service'],'nav-repair-authorizations','Diagnostics & Authorizations',()=>window.TotalToolsRepairAuthorizations?.open());
  addAfter(['work orders','repairs','service'],'nav-technician-compensation','Technician Compensation',()=>window.TotalToolsTechnicianCompensation?.open());
  addAfter(['transfers','branch transfers'],'nav-smart-transfers','Smart Transfer Recommendations',()=>window.TotalToolsSmartTransfers?.open());
  addAfter(['reports','reporting'],'nav-operational-reports','Operational Reports',()=>window.TotalToolsOperationalReports?.open());

  // Guided Mode is a normal navigation destination and never floats over content.
  addAfter(['dashboard'],'nav-guided-mode','Guided Mode',openGuided);
}

let queued=false;
function queue(){
  if(queued)return; queued=true;
  requestAnimationFrame(()=>{ queued=false; sync(); });
}
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',()=>setTimeout(sync,100));
else setTimeout(sync,100);
new MutationObserver(queue).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['style','class']});
setInterval(sync,750);
})();
