(() => {
'use strict';
let state={data:null,open:false,permissions:{},query:'',shortcutHandler:null};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const notice=(message,tone='info')=>{const ui=window.TotalToolsShellUI;if(ui?.toast)ui.toast(String(message||''),tone);};
function focusSearch(select=false){setTimeout(()=>{const el=document.getElementById('tt-li-search');if(el){el.focus({preventScroll:true});if(select)el.select()}},0)}
function bindShortcuts(){if(state.shortcutHandler)return;state.shortcutHandler=e=>{if(!state.open)return;const tag=String(e.target?.tagName||'').toLowerCase(),typing=['input','textarea','select'].includes(tag)||e.target?.isContentEditable;if(e.key==='/'&&!typing){e.preventDefault();focusSearch(true)}if(e.key==='F2'){e.preventDefault();document.getElementById('tt-li-refresh')?.click()}if(e.key==='F3'){e.preventDefault();const d=document.querySelector('.tt-li-coverage');if(d){d.open=true;d.scrollIntoView({behavior:'smooth',block:'start'})}}};document.addEventListener('keydown',state.shortcutHandler)}
async function api(path,opts={}){const r=await fetch('/api/logistics-intelligence'+path,{credentials:'same-origin',headers:{'Content-Type':'application/json',...(opts.headers||{})},...opts});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||'Request failed');return d;}
async function profile(){const r=await fetch('/api/workspace-profile/me',{credentials:'same-origin'});return r.ok?r.json():{permissions:{}};}
function can(key){const p=state.permissions||{};if(p.dispatch)return true;if(Object.prototype.hasOwnProperty.call(p,key))return !!p[key];if(['dispatch_view','dispatch_plan','dispatch_execute','dispatch_admin'].includes(key)){const explicit=['dispatch','dispatch_view','dispatch_plan','dispatch_execute','dispatch_admin'].some(k=>Object.prototype.hasOwnProperty.call(p,k));if(!explicit){if(key==='dispatch_view')return !!(p.transfers||p.transfers_create||p.transfers_approve||p.transfers_pickup||p.transfers_dropoff);if(key==='dispatch_plan')return !!(p.transfers||p.transfers_create||p.transfers_approve);if(key==='dispatch_execute')return !!(p.transfers||p.transfers_pickup||p.transfers_dropoff);if(key==='dispatch_admin')return !!(p.transfers||p.transfers_approve);}}return false;}
function root(){return document.getElementById('tt-logistics-intelligence');}
function shell(){let el=root();if(el)return el;el=document.createElement('div');el.id='tt-logistics-intelligence';el.className='tt-logistics-intelligence';document.body.appendChild(el);return el;}
function close(){if(state.shortcutHandler){document.removeEventListener('keydown',state.shortcutHandler);state.shortcutHandler=null}root()?.remove();state.open=false;}
async function open(opts={}){state.open=true;shell();renderLoading();try{const [p,d]=await Promise.all([profile(),api('/command-center')]);state.permissions=p.permissions||{};state.data=d;render();focusSearch();if(opts.recordId){const el=shell().querySelector(`[data-job="${CSS.escape(String(opts.recordId))}"]`);el?.scrollIntoView({block:'center'});el?.classList.add('is-context-target');}}catch(e){renderError(e.message);}}
function renderLoading(){shell().innerHTML=`<div class="tt-li-backdrop" data-close></div><section class="tt-li-panel"><header><div><span>Dispatch</span><h2>Dispatch</h2><p>See what needs to move, who has it, and what needs attention.</p></div><button data-close aria-label="Close">&times;</button></header><div class="tt-li-loading">Loading dispatch queue…</div></section>`;bindClose();}
function renderError(m){shell().innerHTML=`<div class="tt-li-backdrop" data-close></div><section class="tt-li-panel"><header><div><span>Dispatch</span><h2>Dispatch</h2></div><button data-close>×</button></header><div class="tt-li-error">${esc(m)}</div></section>`;bindClose();}
function stat(label,val){return `<article><small>${label}</small><strong>${val}</strong></article>`;}
function jobCard(j){const r=j.intelligence?.reasons||[];return `<article class="tt-li-job" data-job="${j.id}"><div class="tt-li-job-top"><div><strong>${esc(j.job_number)}</strong><span>${esc(j.job_type.replaceAll('_',' '))}</span></div><b class="risk-${j.intelligence?.score>=35?'high':'normal'}">${j.intelligence?.score||0} risk</b></div><div class="tt-li-route"><span>${esc(j.origin_label)}</span><i>→</i><span>${esc(j.destination_label)}</span></div><div class="tt-li-meta"><span>${esc(j.status)}</span><span>${esc(j.priority)} priority</span><span>${esc(j.assignee_name||'Unassigned')}</span>${j.vehicle_label?`<span>${esc(j.vehicle_label)}</span>`:''}</div>${r.length?`<p>${esc(r.join(' • '))}</p>`:''}</article>`;}
function transferCard(t){return `<article class="tt-li-transfer"><div><strong>${esc(t.transfer_number)}</strong><small>${esc(t.status)}</small></div><p>${esc(t.from_branch_name)} → ${esc(t.to_branch_name)}</p>${can('dispatch_plan')?`<button data-transfer="${t.id}">Create dispatch job</button>`:''}</article>`;}
function filteredJobs(){const jobs=state.data?.jobs||[],q=state.query.trim().toLowerCase();if(!q)return jobs;return jobs.filter(j=>[j.job_number,j.job_type,j.origin_label,j.destination_label,j.status,j.priority,j.assignee_name,j.vehicle_label,...(j.intelligence?.reasons||[])].filter(Boolean).join(' ').toLowerCase().includes(q));}
function render(){const d=state.data||{summary:{},jobs:[],uncovered_transfers:[]},jobs=filteredJobs(),coverage=d.uncovered_transfers||[];shell().innerHTML=`<div class="tt-li-backdrop" data-close></div><section class="tt-li-panel"><header><div><span>Dispatch</span><h2>Dispatch</h2><p>See what needs to move, who has it, and what needs attention.</p></div><div class="tt-li-shortcuts"><span><kbd>/</kbd> Search</span><span><kbd>F2</kbd> Refresh</span><span><kbd>F3</kbd> Needs coverage</span></div><button data-close aria-label="Close">&times;</button></header><div class="tt-li-stats">${stat('Open',d.summary.open_jobs||0)}${stat('At risk',d.summary.at_risk||0)}${stat('Unassigned',d.summary.unassigned||0)}${stat('In transit',d.summary.in_transit||0)}</div><main class="tt-li-body"><section class="tt-li-queue"><div class="tt-li-section-head"><div><h3>Dispatch queue</h3><span>${jobs.length} shown</span></div><div class="tt-li-queue-actions"><input id="tt-li-search" value="${esc(state.query)}" placeholder="Search job, route, driver or status /" aria-keyshortcuts="/"><button id="tt-li-refresh" aria-keyshortcuts="F2">Refresh</button></div></div>${d.routing_note?`<p class="tt-li-note">${esc(d.routing_note)}</p>`:''}<div class="tt-li-list">${jobs.length?jobs.map(jobCard).join(''):'<div class="tt-li-empty">No dispatch jobs match this view.</div>'}</div></section><details class="tt-li-coverage" ${coverage.length?'open':''}><summary><span>Needs coverage</span><em>${coverage.length} transfer${coverage.length===1?'':'s'} without dispatch</em></summary><div class="tt-li-coverage-body">${coverage.length?coverage.map(transferCard).join(''):'<div class="tt-li-empty">Every open transfer has dispatch coverage.</div>'}</div></details></main></section>`;bindClose();bind();}
async function refresh(){const b=shell().querySelector('#tt-li-refresh');if(b){b.disabled=true;b.textContent='Refreshing…'}try{state.data=await api('/command-center');render();notice('Dispatch queue refreshed.','success')}catch(e){notice(e.message,'error');if(b){b.disabled=false;b.textContent='Refresh'}}}
async function fromTransfer(id){try{await api('/from-transfer/'+id,{method:'POST',body:'{}'});await refresh();notice('Dispatch job created from transfer.','success')}catch(e){notice(e.message,'error')}}
function bindClose(){shell().querySelectorAll('[data-close]').forEach(x=>x.addEventListener('click',close));}
function bind(){bindShortcuts();shell().querySelector('#tt-li-refresh')?.addEventListener('click',refresh);const input=shell().querySelector('#tt-li-search');let timer;input?.addEventListener('input',()=>{clearTimeout(timer);state.query=input.value;timer=setTimeout(()=>{render();focusSearch()},120)});shell().querySelectorAll('[data-transfer]').forEach(x=>x.addEventListener('click',()=>fromTransfer(x.dataset.transfer)));}
// Keep the established queue bindings and field-execution integrations.
// Lanes are views of authoritative job state; moving a card never posts a status.
const renderQueue=render;
let selectedJob=null;
function laneFor(j){
 if(j.execution_stage==='failed'||j.status==='delayed')return 'exceptions';
 if(j.status==='completed'||j.execution_stage==='completed')return 'delivered';
 if(j.status==='in_transit'||['in_transit','at_destination'].includes(j.execution_stage))return 'transit';
 if(j.assignee_employee_id||j.driver_employee_id)return 'assigned';
 if(j.scheduled_for||j.status==='scheduled'||j.status==='ready')return 'scheduled';
 return 'unassigned';
}
function deadline(j){const value=j.promised_at||j.scheduled_for;if(!value)return 'No time set';const date=new Date(value);if(!Number.isFinite(date.getTime()))return 'Check delivery time';return `${j.promised_at?'Due':'Scheduled'} ${date.toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}`;}
render=function(){
 renderQueue();
 const host=root(),list=host.querySelector('.tt-li-list');if(!list)return;
 host.classList.add('tt-dispatch-board');
 const jobs=filteredJobs(),lanes=[['unassigned','Unassigned'],['scheduled','Scheduled'],['assigned','Assigned'],['transit','In transit'],['exceptions','Exceptions']];
 const cards=[...list.children];
 list.classList.add('tt-dispatch-lanes');list.setAttribute('aria-label','Dispatch jobs by stage');
 list.replaceChildren();
 for(const [key,title]of lanes){
  const column=document.createElement('section');column.className='tt-dispatch-lane';column.dataset.lane=key;
  const matching=jobs.filter(j=>laneFor(j)===key);
  column.innerHTML=`<header><h4>${title}</h4><span>${matching.length}</span></header><div class="tt-dispatch-lane__jobs"></div>`;
  const target=column.lastElementChild;
  for(const job of matching){const card=cards.find(c=>c.dataset.job===String(job.id));if(!card)continue;
   const overdue=job.promised_at&&new Date(job.promised_at).getTime()<Date.now();
   card.classList.toggle('is-overdue',!!overdue);card.classList.toggle('is-expanded',String(job.id)===String(selectedJob));
   card.querySelectorAll('.tt-li-route span').forEach((span,i)=>{span.dataset.routeLabel=i===0?'Pickup':'Drop-off'});
   const timing=document.createElement('p');timing.className='tt-dispatch-deadline';timing.textContent=(overdue?'Overdue · ':'')+deadline(job);card.appendChild(timing);
   const button=document.createElement('button');button.type='button';button.dataset.id=String(job.id);button.className='tt-dispatch-open';button.textContent='Job controls';button.setAttribute('aria-expanded',String(card.classList.contains('is-expanded')));
   button.onclick=()=>{const open=!card.classList.contains('is-expanded');host.querySelectorAll('.tt-li-job.is-expanded').forEach(c=>{c.classList.remove('is-expanded');c.querySelector('.tt-dispatch-open')?.setAttribute('aria-expanded','false')});card.classList.toggle('is-expanded',open);button.setAttribute('aria-expanded',String(open));selectedJob=open?job.id:null;};
   card.appendChild(button);target.appendChild(card);
  }
  if(!matching.length)target.innerHTML='<p class="tt-dispatch-clear">No jobs in this lane</p>';
  list.appendChild(column);
 }
 host.onkeydown=e=>{if(e.key==='Escape'&&selectedJob!=null){const card=host.querySelector('.tt-li-job.is-expanded');card?.classList.remove('is-expanded');const button=card?.querySelector('.tt-dispatch-open');button?.setAttribute('aria-expanded','false');button?.focus();selectedJob=null;e.preventDefault();}};
 const workload=new Map();for(const j of state.data?.jobs||[]){const id=j.driver_employee_id||j.assignee_employee_id;if(!id)continue;const entry=workload.get(String(id))||{name:j.assignee_name||'Assigned driver',count:0};entry.count++;workload.set(String(id),entry);}
 const aside=document.createElement('section');aside.className='tt-dispatch-team';aside.setAttribute('aria-label','Assigned driver workload');
 aside.innerHTML=`<h3>Driver workload</h3><p>Open jobs by recorded assignment. Shift availability is checked during planning.</p>${[...workload.values()].map(d=>`<div><strong>${esc(d.name)}</strong><span>${d.count} open job${d.count===1?'':'s'}</span></div>`).join('')||'<p>No drivers assigned to open jobs.</p>'}<button type="button" class="secondary" data-dispatch-plan>Routes &amp; driver planning</button>`;
 aside.querySelector('button').onclick=()=>{if(window.TotalToolsRoutePlanner?.open)window.TotalToolsRoutePlanner.open();else notice('Open Route Planning from the dispatch workspace.','info')};
 if(!can('dispatch_plan'))aside.querySelector('button').remove();
 host.querySelector('.tt-li-body').appendChild(aside);
 const history=document.createElement('section');history.className='tt-dispatch-history';history.innerHTML='<button type="button" class="secondary" data-delivered-toggle aria-expanded="false">Delivered history</button><div data-delivered-content hidden></div>';list.after(history);
 history.querySelector('[data-delivered-toggle]').onclick=async e=>{const content=history.querySelector('[data-delivered-content]'),button=e.currentTarget;const expanded=button.getAttribute('aria-expanded')==='true';button.setAttribute('aria-expanded',String(!expanded));content.hidden=expanded;if(!expanded&&!content.dataset.loaded)await loadDelivered(content,null,false);};
 window.dispatchEvent(new Event('tt-dispatch-refreshed'));
};
async function loadDelivered(content,cursor,append){
 const toggle=content.parentElement.querySelector('[data-delivered-toggle]');toggle.disabled=true;
 try{const data=await api('/delivered'+(cursor?'?before='+encodeURIComponent(cursor):''));if(!document.body.contains(content))return;
  if(!append)content.replaceChildren();content.querySelector('[data-history-more]')?.remove();
  for(const job of data.jobs){const row=document.createElement('article');row.className='tt-dispatch-delivered';row.innerHTML=`<div><strong>${esc(job.job_number)}</strong><span>${esc(job.origin_label)} → ${esc(job.destination_label)}</span><small>${esc(job.driver_name||'Driver not recorded')} · ${esc(job.vehicle_label||'Vehicle not recorded')}</small></div><div><strong>${job.completed_at?esc(new Date(/^\d{4}-\d{2}-\d{2} \d{2}:/.test(job.completed_at)?job.completed_at.replace(' ','T')+'Z':job.completed_at).toLocaleString()):'Completion time not recorded'}</strong><span>${Number(job.delivery_proof_count)>0?'Delivery evidence recorded':'Delivery evidence not recorded'}</span><button type="button" data-review-delivery>Review delivery evidence</button><div data-delivery-evidence hidden></div></div>`;
   row.querySelector('[data-review-delivery]').onclick=async e=>{const button=e.currentTarget,details=row.querySelector('[data-delivery-evidence]');button.disabled=true;try{const evidence=await api('/jobs/'+encodeURIComponent(job.id)+'/execution');details.hidden=false;details.innerHTML=(evidence.proofs||[]).filter(p=>p.proof_type==='delivery').map(p=>`<p><strong>${esc(p.recipient_name||p.signature_name||'Recipient not recorded')}</strong><br>${esc(p.evidence_reference||'No reference recorded')}</p>`).join('')||'<p>No delivery evidence recorded.</p>';}catch(error){notice(error.message,'error');}finally{button.disabled=false;}};
   content.appendChild(row);}
  if(!data.jobs.length&&!append)content.textContent='No completed deliveries recorded.';
  if(data.next_cursor){const more=document.createElement('button');more.type='button';more.dataset.historyMore='';more.textContent='Load older deliveries';more.onclick=()=>loadDelivered(content,data.next_cursor,true);content.appendChild(more);}
  content.dataset.loaded='true';
 }catch(e){notice(e.message,'error');if(!append)content.textContent='Delivery history could not load. Close and reopen to retry.';}
 finally{toggle.disabled=false;}
}
window.TotalToolsLogisticsIntelligence={open,close,refresh,capabilities:()=>({plan:can('dispatch_plan')||can('dispatch_admin'),execute:can('dispatch_execute')||can('dispatch_plan')||can('dispatch_admin'),admin:can('dispatch_admin')}),openRecord:(id)=>{selectedJob=id;return open({recordId:id})}};
})();
