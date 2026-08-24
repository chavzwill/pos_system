(() => {
'use strict';

const ITEM_CLASS='tt-upgrade-nav-item';
const GROUP_ID='tt-upgrade-center';

function getApp(){
  try {
    if(typeof App!=='undefined' && App) return App;
  } catch (_) {}
  return window.App || null;
}

function loggedIn(){ return !!getApp()?.currentUser; }
function norm(value){ return String(value||'').toLowerCase().replace(/\s+/g,' ').trim(); }

function sidebarNav(){ return document.querySelector('#sidebar .sidebar-nav') || document.querySelector('.sidebar-nav'); }

function findNativeNav(terms){
  const nav=sidebarNav();
  if(!nav) return null;
  const items=[...nav.querySelectorAll('.nav-item')].filter(el=>!el.classList.contains(ITEM_CLASS));
  for(const term of terms){
    const n=norm(term);
    const exact=items.find(el=>norm(el.textContent)===n);
    if(exact) return exact;
    const starts=items.find(el=>norm(el.textContent).startsWith(n));
    if(starts) return starts;
    const contains=items.find(el=>norm(el.textContent).includes(n));
    if(contains) return contains;
  }
  return null;
}

function makeAction(id,label,description,onClick){
  const el=document.createElement('div');
  el.className=`nav-item ${ITEM_CLASS}`;
  el.setAttribute('role','button');
  el.setAttribute('tabindex','0');
  el.dataset.upgradeId=id;
  el.dataset.guideId=id;
  el.innerHTML=`<span class="tt-upgrade-nav-icon" aria-hidden="true">↳</span><span class="tt-upgrade-nav-copy"><strong>${label}</strong><small>${description}</small></span>`;
  const activate=()=>{ if(loggedIn()) onClick(); };
  el.addEventListener('click',activate);
  el.addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); activate(); } });
  return el;
}

function remove(){ document.getElementById(GROUP_ID)?.remove(); }

function openNative(terms){
  const target=findNativeNav(terms);
  if(target) target.click();
}

function install(){
  if(!loggedIn()){ remove(); return; }
  const nav=sidebarNav();
  if(!nav || document.getElementById(GROUP_ID)) return;

  const group=document.createElement('section');
  group.id=GROUP_ID;
  group.className='tt-upgrade-center';
  group.setAttribute('aria-label','POS upgrades');

  const heading=document.createElement('div');
  heading.className='tt-upgrade-center__heading';
  heading.innerHTML='<span>UPGRADES</span><small>New operational tools</small>';
  group.appendChild(heading);

  const actions=[
    ['nav-technician-compensation','Technician Compensation','Verified time, rates & pay periods',()=>window.TotalToolsTechnicianCompensation?.open()],
    ['nav-smart-transfers','Smart Transfer Recommendations','Evidence-backed branch rebalancing',()=>window.TotalToolsSmartTransfers?.open()],
    ['nav-operational-reports','Operational Reports','Management and operating insight',()=>window.TotalToolsOperationalReports?.open()],
    ['nav-erp-upgrade','ERP Intelligence','Inventory and business intelligence',()=>openNative(['erp intelligence','erp','intelligence'])],
    ['nav-commerce-sync','Commerce Sync','Open connected commerce operations',()=>openNative(['inventory','products'])],
    ['nav-po-controls','Purchase Order Controls','Open hardened purchasing workflow',()=>openNative(['purchase orders','purchasing'])]
  ];
  actions.forEach(args=>group.appendChild(makeAction(...args)));

  // Put the upgrade center directly inside the real sidebar rather than
  // depending on Guided Mode's visibility-based mapping. That mapper cannot
  // see an off-canvas sidebar on mobile, which is why the upgrades previously
  // existed in code but disappeared from phone navigation.
  const footer=nav.querySelector('.sidebar-footer');
  if(footer) nav.insertBefore(group,footer); else nav.appendChild(group);
}

let queued=false;
function sync(){
  if(queued) return;
  queued=true;
  requestAnimationFrame(()=>{
    queued=false;
    if(loggedIn()) install(); else remove();
  });
}

if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',()=>setTimeout(sync,100));
else setTimeout(sync,100);

new MutationObserver(sync).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['style','class']});
setInterval(sync,750);
})();
