(()=>{'use strict';
const BYPASS='ttDispatchProtectedBypass';
function ui(){return window.TotalToolsPremiumUI||{}}
async function ask(options){if(ui().confirm)return ui().confirm(options);return window.confirm(options.message||options.title||'Confirm?')}
function cardFor(el){return el?.closest?.('.tt-li-job')||null}
function jobLabel(el){const card=cardFor(el);return card?.querySelector('[data-id]')?.textContent?.trim()||card?.querySelector('strong')?.textContent?.trim()||'this dispatch job'}
function selectedText(select){return select?.selectedOptions?.[0]?.textContent?.trim()||''}
function clickOptions(button){
  const job=jobLabel(button),card=cardFor(button);
  if(button.matches('[data-field-assign]')){
    const driver=selectedText(card?.querySelector('[data-driver]')),vehicle=selectedText(card?.querySelector('[data-vehicle]'));
    return {title:'Confirm driver and vehicle assignment?',message:`${job} will be assigned to ${driver||'the selected driver'} using ${vehicle||'the selected vehicle'}. This establishes operational responsibility for the dispatch execution.`,confirmLabel:'Confirm assignment',tone:'warning'};
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
  return null;
}
async function protectClick(e){
  const button=e.target.closest?.('[data-field-assign],[data-stage],[data-complete]');
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
function enhance(scope=document){
  scope.querySelectorAll?.('#tt-logistics-intelligence [data-field-execution]').forEach(panel=>{panel.dataset.ttProtectedDispatch='1';panel.setAttribute('aria-label','Protected dispatch field execution controls')});
  scope.querySelectorAll?.('#tt-logistics-intelligence [data-field-assign],#tt-logistics-intelligence [data-stage],#tt-logistics-intelligence [data-complete]').forEach(button=>button.dataset.ttProtectedAction='1');
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