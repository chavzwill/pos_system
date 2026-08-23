(() => {
'use strict';

const SUBNAV_CLASS='tt-upgrade-subnav';

function loggedIn(){
  try { return !!window.App?.currentUser; } catch { return false; }
}

function makeItem({id,label,parentGuideId,onClick}){
  const parent=document.querySelector(`[data-guide-id="${parentGuideId}"]`);
  if(!parent || document.querySelector(`[data-guide-id="${id}"]`)) return;

  const el=document.createElement('div');
  el.className=`nav-item ${SUBNAV_CLASS}`;
  el.setAttribute('role','button');
  el.setAttribute('tabindex','0');
  el.dataset.guideId=id;
  el.innerHTML=`<span style="width:20px;display:inline-flex;justify-content:center;opacity:.75">↳</span><span>${label}</span>`;
  const activate=()=>{ if(loggedIn()) onClick(); };
  el.addEventListener('click',activate);
  el.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();activate();}});

  parent.insertAdjacentElement('afterend',el);
}

function removeItems(){
  document.querySelectorAll(`.${SUBNAV_CLASS}`).forEach(el=>el.remove());
}

function sync(){
  if(!loggedIn()) { removeItems(); return; }

  makeItem({
    id:'nav-operational-reports',
    label:'Operational Reports',
    parentGuideId:'nav-reports',
    onClick:()=>window.TotalToolsOperationalReports?.open()
  });

  makeItem({
    id:'nav-smart-transfers',
    label:'Smart Transfer Recommendations',
    parentGuideId:'nav-transfers',
    onClick:()=>window.TotalToolsSmartTransfers?.open()
  });
}

let queued=false;
function queue(){
  if(queued)return;
  queued=true;
  requestAnimationFrame(()=>{queued=false;sync();});
}

if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>setTimeout(sync,100));
else setTimeout(sync,100);

new MutationObserver(queue).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['style','class']});
setInterval(sync,1000);
})();
