(()=>{'use strict';
const state={profile:null,dispatch:null,busy:false};
const norm=s=>String(s||'').toLowerCase().replace(/\s+/g,' ').trim();
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function main(){return document.querySelector('#main-content,.main-content,main,.content');}
function dashboardVisible(){const items=[...document.querySelectorAll('#sidebar .nav-item,.sidebar-nav .nav-item')];const active=items.find(x=>x.classList.contains('active')||x.getAttribute('aria-current')==='page');return !active||norm(active.textContent).includes('dashboard');}
function root(){return document.getElementById('tt-employee-workspace-home');}
function remove(){root()?.remove();}
function visibleNav(){return [...document.querySelectorAll('#sidebar .nav-item,.sidebar-nav .nav-item')].filter(el=>!el.hidden&&getComputedStyle(el).display!=='none'&&!norm(el.textContent).includes('guided mode'));}
function clickNav(label){const n=norm(label);const el=visibleNav().find(x=>norm(x.textContent).includes(n));el?.click();}
function dispatchOpen(){const nav=visibleNav().find(x=>norm(x.textContent).includes('dispatch & logistics'));if(nav)nav.click();else window.TotalToolsLogisticsIntelligence?.open();}
async function loadDispatch(){if(state.busy||state.profile?.primary_workspace!=='dispatch')return;state.busy=true;try{const q=state.profile.employee?.default_branch_id?`?branch_id=${encodeURIComponent(state.profile.employee.default_branch_id)}`:'';const r=await fetch('/api/logistics-intelligence/command-center'+q,{credentials:'same-origin'});if(r.ok)state.dispatch=await r.json();}catch(e){}finally{state.busy=false;render();}}
function quickActions(){const p=state.profile?.primary_workspace;const map={
  sales:['Point of Sale','Transactions','Cash Drawer','Customers'],
  service:['Work Orders','Equipment & Repair History','Diagnostics & Authorizations','Scheduling & Capacity Intelligence'],
  rentals:['Rentals','Customers','Inventory'],
  inventory:['Inventory','Warehouse','Transfers','Inventory Intelligence'],
  purchasing:['Purchase Requests','Purchase Orders','Suppliers','Inventory Intelligence'],
  finance:['Accounting Intelligence','Accounting Ledger','Settlement Reconciliation','Supplier Ledger & Payables'],
  dispatch:['Dispatch & Logistics Intelligence','Transfers','Inventory','Guided Mode'],
  administration:['Employees','Branches','Security','Settings']
};
  return (map[p]||visibleNav().slice(0,4).map(x=>x.textContent.trim())).filter(Boolean);
}
function metric(label,value,detail){return `<article class="tt-workspace-metric"><small>${esc(label)}</small><strong>${esc(value)}</strong>${detail?`<span>${esc(detail)}</span>`:''}</article>`;}
function dispatchPanel(){const d=state.dispatch?.summary;if(!d)return `<div class="tt-workspace-loading">Loading dispatch workload…</div>`;return `<div class="tt-workspace-metrics">${metric('Open jobs',d.open_jobs||0,'Current dispatch queue')}${metric('At risk',d.at_risk||0,'Requires attention')}${metric('Unassigned',d.unassigned||0,'Needs dispatcher action')}${metric('In transit',d.in_transit||0,'Currently moving')}</div><div class="tt-workspace-callout"><div><strong>Dispatch command center</strong><span>Prioritize movements by promised time, assignment, status and verified operational risk.</span></div><button data-dispatch-open>Open dispatch</button></div>`;}
function render(){remove();if(!state.profile||!dashboardVisible())return;const m=main();if(!m)return;const p=state.profile.primary_workspace||'dashboard';const el=document.createElement('section');el.id='tt-employee-workspace-home';el.className='tt-employee-workspace-home';const actions=quickActions();el.innerHTML=`<header><div><span class="tt-workspace-eyebrow">${esc(state.profile.employee?.security_group_name||'Employee')}</span><h1>${esc(p==='dispatch'?'Dispatch Workspace':p.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase())+' Workspace')}</h1><p>${esc(state.profile.employee?.default_branch_name?state.profile.employee.default_branch_name+' · ': '')}Only tools permitted for this signed-in employee are shown.</p></div><span class="tt-workspace-role">${esc(state.profile.employee?.name||'')}</span></header>${p==='dispatch'?dispatchPanel():''}<div class="tt-workspace-actions">${actions.map(a=>`<button data-workspace-action="${esc(a)}">${esc(a)}</button>`).join('')}</div>`;m.prepend(el);el.querySelectorAll('[data-workspace-action]').forEach(b=>b.addEventListener('click',()=>{const label=b.dataset.workspaceAction;if(norm(label).includes('guided mode'))document.getElementById('tt-guide-launcher')?.click();else clickNav(label);}));el.querySelector('[data-dispatch-open]')?.addEventListener('click',dispatchOpen);}
function acceptProfile(p){state.profile=p;state.dispatch=null;render();if(p?.primary_workspace==='dispatch')loadDispatch();}
window.addEventListener('tt:workspace-profile',e=>acceptProfile(e.detail));
new MutationObserver(()=>{if(state.profile)render();}).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['class','hidden','aria-current']});
setInterval(()=>{const p=window.TotalToolsRoleWorkspace?.getProfile?.();if(p&&p!==state.profile)acceptProfile(p);},1200);
})();