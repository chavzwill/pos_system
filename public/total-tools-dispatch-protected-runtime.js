(()=>{'use strict';
const BYPASS='ttDispatchProtectedBypass';
function ui(){return window.TotalToolsPremiumUI||{}}
async function ask(options){if(ui().confirm)return ui().confirm(options);return window.confirm(options.message||options.title||'Confirm?')}
function notify(message,tone='success'){if(ui().notify)return ui().notify(message,{tone,persist:tone==='error'});if(tone==='error')window.alert(message)}
async function api(path,opts={}){const r=await fetch('/api/logistics-intelligence'+path,{credentials:'same-origin',headers:{'Content-Type':'application/json',...(opts.headers||{})},...opts});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||`Request failed (${r.status})`);return d}
function cardFor(el){return el?.closest?.('.tt-li-job')||null}
function jobId(el){return Number(cardFor(el)?.querySelector('[data-id]')?.dataset.id||0)}
function jobLabel(el){const card=cardFor(el);return card?.querySelector('.tt-li-job-top strong')?.textContent?.trim()||'this dispatch job'}
function selectedText(select){return select?.selectedOptions?.[0]?.textContent?.trim()||''}
function clickOptions(button){
  const job=jobLabel(button),card=cardFor(button);
  if(button.matches('[data-field-assign]')){
    const driverSelect=card?.querySelector('[data-driver]'),vehicleSelect=card?.querySelector('[data-vehicle]');
    if(!driverSelect?.value||!vehicleSelect?.value)return null;
    const driver=selectedText(driverSelect),vehicle=selectedText(vehicleSelect);
    return {title:'Confirm driver and vehicle assignment?',message:`${job} will be assigned to ${driver} using ${vehicle}. This establishes operational responsibility for the dispatch execution.`,confirmLabel:'Confirm assignment',tone:'warning'};
  }
  if(button.matches('[data-stage]')){
    const action=button.dataset.stage;
    const map={
      depart_origin:{title:'Mark dispatch as departed?',message:`${job} will be recorded as en route to the origin. This starts field-execution timing and becomes part of the custody/audit trail.`,confirmLabel:'Mark departed',tone:'warning'},
      arrive_origin:{title:'Confirm arrival at origin?',message:`${job} will be recorded as arrived at the pickup/source location. This becomes authoritative field-execution evidence for the stop.`,confirmLabel:'Confirm origin arrival'},
      arrive_destination:{title:'Confirm arrival at destination?',message:`${job} will be recorded as arrived at the destination. Delivery proof should be captured before the dispatch is completed.`,confirmLabel:'Confirm destination arrival'}
    };return map[action]||null;
  }
  if(button.matches('[data-complete]'))return {title:'Complete this dispatch job?',message:`${job} will be closed as completed. Completion finalizes the current field-execution lifecycle and should only be recorded after required delivery/custody evidence is present.`,confirmLabel:'Complete dispatch',tone:'warning'};
  if(button.matches('[data-transfer]')){
    const transfer=button.closest('.tt-li-transfer')?.querySelector('strong')?.textContent?.trim()||'this branch transfer';
    return {title:'Create dispatch coverage for this transfer?',message:`${transfer} will be handed into the Dispatch queue as an operational movement job. The transfer remains the authoritative stock-movement record.`,confirmLabel:'Create dispatch job',tone:'warning'};
  }
  return null;
}
function modalOptions(form){
  if(form.id!=='tt-field-form')return null;
  const title=form.closest('#tt-field-modal')?.querySelector('h3')?.textContent?.trim()||'';
  if(/^Confirm pickup and custody$/i.test(title))return {title:'Confirm pickup and custody handoff?',message:'This records custody moving to the dispatch operation at the origin. Verify the releasing party and any evidence reference before confirming pickup.',confirmLabel:'Confirm custody pickup',tone:'warning'};
  if(/^Pickup proof$/i.test(title))return {title:'Save pickup proof?',message:'This evidence becomes part of the authoritative dispatch custody record. Verify the witness/releasing party, signature name, reference, photo and notes before saving.',confirmLabel:'Save pickup evidence'};
  if(/^Delivery \/ receipt proof$/i.test(title))return {title:'Save proof of delivery?',message:'The recipient, acknowledgement, evidence reference, photo and notes will become authoritative proof that the destination handoff occurred.',confirmLabel:'Save delivery evidence',tone:'warning'};
  if(/^Record failed attempt$/i.test(title))return {title:'Record failed dispatch attempt?',message:'This records a failed service attempt against the dispatch job and may drive customer communication, exception handling, rescheduling and performance evidence. Confirm the failure reason is accurate.',confirmLabel:'Record failed attempt',tone:'danger'};
  if(/^Reschedule dispatch$/i.test(title))return {title:'Reschedule this dispatch?',message:'The current execution commitment will be superseded by the new scheduled date/time. Confirm the revised commitment before saving.',confirmLabel:'Confirm reschedule',tone:'warning'};
  if(/^Cancel dispatch job$/i.test(title))return {title:'Cancel this dispatch job?',message:'Cancellation removes this job from active Dispatch execution and releases any pre-pickup vehicle commitment. Cancellation is blocked after custody pickup; use the failed-attempt or completion workflow instead.',confirmLabel:'Cancel dispatch',tone:'danger'};
  return null;
}
function actionModal(title,body,label,onSubmit){
  let host=document.getElementById('tt-field-modal');if(!host){host=document.createElement('div');host.id='tt-field-modal';document.body.appendChild(host)}
  host.innerHTML=`<div class="tt-dispatch-protected-modal__backdrop" data-close></div><section class="tt-dispatch-protected-modal" role="dialog" aria-modal="true" aria-labelledby="tt-dispatch-protected-title"><header><h3 id="tt-dispatch-protected-title"></h3><button type="button" data-close aria-label="Close">×</button></header><form id="tt-field-form">${body}<div id="tt-field-error" role="alert"></div><footer><button type="button" data-close>Cancel</button><button type="submit"></button></footer></form></section>`;
  host.querySelector('h3').textContent=title;host.querySelector('button[type="submit"]').textContent=label;
  const close=()=>host.remove();host.querySelectorAll('[data-close]').forEach(x=>x.addEventListener('click',close));
  const form=host.querySelector('form');form.onsubmit=async e=>{e.preventDefault();const submit=e.currentTarget.querySelector('[type="submit"]'),err=host.querySelector('#tt-field-error');err.textContent='';submit.disabled=true;try{await onSubmit(new FormData(e.currentTarget));close()}catch(x){err.textContent=x.message;submit.disabled=false}};
  requestAnimationFrame(()=>form.querySelector('input,textarea,select,button')?.focus())
}
function cancelDispatch(button){
  const id=jobId(button),label=jobLabel(button);if(!id)return;
  actionModal('Cancel dispatch job',`<p class="tt-dispatch-protected-modal__context"><strong>${label}</strong><br>Give an operational reason. Jobs that have already taken custody cannot be cancelled here.</p><label>Cancellation reason<textarea name="reason" rows="3" required placeholder="Why is this dispatch being cancelled?"></textarea></label>`,'Cancel dispatch',async fd=>{await api(`/jobs/${id}/cancel`,{method:'POST',body:JSON.stringify({reason:fd.get('reason')})});notify(`${label} cancelled.`);await window.TotalToolsLogisticsIntelligence?.refresh?.()})
}
async function protectClick(e){
  const cancelButton=e.target.closest?.('[data-tt-dispatch-cancel]');
  if(cancelButton&&cancelButton.closest('#tt-logistics-intelligence')){e.preventDefault();e.stopImmediatePropagation();cancelDispatch(cancelButton);return}
  const button=e.target.closest?.('[data-field-assign],[data-stage],[data-complete],[data-transfer]');
  if(!button||button.dataset[BYPASS]==='1'||!button.closest('#tt-logistics-intelligence'))return;
  const options=clickOptions(button);if(!options)return;
  e.preventDefault();e.stopImmediatePropagation();
  const ok=await ask(options);if(!ok)return;
  button.dataset[BYPASS]='1';
  try{button.click()}finally{queueMicrotask(()=>delete button.dataset[BYPASS])}
}
async function protectSubmit(e){
  const form=e.target;if(!(form instanceof HTMLFormElement)||form.dataset[BYPASS]==='1')return;
  const options=modalOptions(form);if(!options)return;
  e.preventDefault();e.stopImmediatePropagation();
  const submitter=e.submitter instanceof HTMLElement?e.submitter:null;
  const ok=await ask(options);if(!ok)return;
  form.dataset[BYPASS]='1';
  try{form.requestSubmit(submitter instanceof HTMLButtonElement||submitter instanceof HTMLInputElement?submitter:undefined)}finally{queueMicrotask(()=>delete form.dataset[BYPASS])}
}
function matchesAndDescendants(scope,selector){const out=[];if(scope?.matches?.(selector))out.push(scope);scope?.querySelectorAll?.(selector).forEach(node=>out.push(node));return out}
function stageOf(panel){const raw=panel.querySelector('strong')?.textContent||'';return raw.split('·').slice(1).join('·').trim().toLowerCase()}
function enhancePanel(panel){
  panel.dataset.ttProtectedDispatch='1';panel.setAttribute('aria-label','Protected dispatch field execution controls');
  const stage=stageOf(panel),allowed=['not assigned','assigned','rescheduled','en route to origin','at origin','failed'];
  if(!allowed.includes(stage)||panel.querySelector('[data-tt-dispatch-cancel]'))return;
  const id=jobId(panel);if(!id)return;
  const wrap=document.createElement('div');wrap.className='tt-dispatch-protected-actions';wrap.innerHTML='<button type="button" data-tt-dispatch-cancel>Cancel dispatch</button>';panel.appendChild(wrap)
}
function enhance(scope=document){
  matchesAndDescendants(scope,'#tt-logistics-intelligence [data-field-execution]').forEach(enhancePanel);
  matchesAndDescendants(scope,'#tt-logistics-intelligence [data-field-assign],#tt-logistics-intelligence [data-stage],#tt-logistics-intelligence [data-complete],#tt-logistics-intelligence [data-transfer]').forEach(button=>button.dataset.ttProtectedAction='1');
  const modal=scope.matches?.('#tt-field-modal')?scope:scope.querySelector?.('#tt-field-modal');
  if(modal){const form=modal.querySelector('#tt-field-form'),title=modal.querySelector('h3')?.textContent||'';if(form&&modalOptions(form)){form.dataset.ttProtectedDispatchForm='1';form.setAttribute('aria-label',`${title} — protected dispatch action`)}}
}
document.addEventListener('click',protectClick,true);
document.addEventListener('submit',protectSubmit,true);
const observer=new MutationObserver(records=>records.forEach(record=>record.addedNodes.forEach(node=>{if(node.nodeType===1)enhance(node)})));
observer.observe(document.body,{childList:true,subtree:true});
enhance(document);
window.TotalToolsDispatchProtectedUI={refresh:()=>enhance(document)};
})();