(()=>{'use strict';
const BYPASS='ttProtectedBypass';
const premium=()=>window.TotalToolsPremiumUI||{};
async function ask(options){if(premium().confirm)return premium().confirm(options);return window.confirm(options.message||options.title||'Continue?');}
function notify(message,tone='success'){if(premium().notify)premium().notify(message,{tone,persist:tone==='error'});}
function workOrderLabel(form){const root=form.closest('#tt-work-orders-workspace');return root?.querySelector('.tt-wo__detail-head h1')?.textContent?.trim()||'this repair';}
function partLabel(form){return form.querySelector('strong')?.textContent?.trim()||'this repair part';}
function selectedSubmitter(e){return e.submitter instanceof HTMLButtonElement?e.submitter:null;}
async function protectSubmit(e){
  const form=e.target;if(!(form instanceof HTMLFormElement)||form.dataset[BYPASS]==='1')return;
  let options=null;
  if(form.id==='tt-wo-progress'){
    const next=new FormData(form).get('status');
    if(next==='awaiting_signoff')options={title:'Move repair to awaiting signoff?',message:`${workOrderLabel(form)} will leave active technician execution and be presented as ready for signoff. The progress comment becomes part of the repair audit trail.`,confirmLabel:'Move to signoff'};
  }else if(form.id==='tt-wo-qc'){
    const result=selectedSubmitter(e)?.value;
    if(result==='pass')options={title:'Record QC pass?',message:`This records a supervisor quality pass for ${workOrderLabel(form)}. Verify the operation, safety, finish and reported-issue checks before continuing.`,confirmLabel:'Record QC pass'};
    if(result==='fail')options={title:'Record QC failure?',message:`This records a failed quality review for ${workOrderLabel(form)} and becomes technician/performance evidence that may require rework before closeout.`,confirmLabel:'Record QC failure',destructive:true};
  }else if(form.id==='tt-wo-comeback'){
    const fd=new FormData(form),confirmed=fd.get('confirmed')==='true';
    options=confirmed?{title:'Confirm technician-attributable comeback?',message:`This permanently records the comeback review against ${workOrderLabel(form)} as technician-attributable performance evidence. Confirm only after the return/rework investigation is complete.`,confirmLabel:'Record confirmed comeback',destructive:true}:{title:'Clear comeback attribution?',message:`This records that the reviewed comeback is not technician-attributable. The reason remains part of the quality history.`,confirmLabel:'Record cleared review'};
  }else if(form.classList.contains('tt-rpi-action')){
    const action=selectedSubmitter(e)?.value;if(!action)return;
    const fd=new FormData(form),qty=Number(fd.get('quantity')||0),part=partLabel(form);
    const map={
      reserve:{title:'Reserve repair inventory?',message:`Reserve ${qty} unit(s) of ${part} for this work order. Available-to-promise inventory will be reduced.`,confirmLabel:'Reserve inventory'},
      consume:{title:'Consume repair inventory?',message:`Consume ${qty} unit(s) of ${part}. This posts a physical inventory reduction against the repair and becomes inventory evidence.`,confirmLabel:'Consume inventory',destructive:true},
      return:{title:'Return repair part to stock?',message:`Return ${qty} unit(s) of ${part} to available inventory. Use this only for an eligible unused/returned repair part.`,confirmLabel:'Return to stock'},
      release:{title:'Release repair reservation?',message:`Release ${qty} reserved unit(s) of ${part}. Those units will become available to other demand again.`,confirmLabel:'Release reservation'}
    };options=map[action]||null;
  }
  if(!options)return;
  e.preventDefault();e.stopImmediatePropagation();
  const submitter=selectedSubmitter(e),ok=await ask(options);if(!ok)return;
  form.dataset[BYPASS]='1';
  try{form.requestSubmit(submitter||undefined);}finally{queueMicrotask(()=>delete form.dataset[BYPASS]);}
}
async function protectDispatch(e){
  const btn=e.target.closest?.('[data-repair-dispatch]');if(!btn||btn.dataset.ttProtectedDispatch==='1')return;
  e.preventDefault();e.stopImmediatePropagation();
  const direction=btn.dataset.repairDispatch;
  const label=direction==='pickup'?'Create repair pickup dispatch job?':'Create repair return-delivery job?';
  const message=direction==='pickup'?'The work order will be handed to Dispatch as a customer equipment pickup with the repair context attached.':'The completed/collected repair will be handed to Dispatch for customer return delivery with the work-order context attached.';
  const ok=await ask({title:label,message,confirmLabel:direction==='pickup'?'Send pickup to Dispatch':'Send return to Dispatch'});if(!ok)return;
  btn.dataset.ttProtectedDispatch='1';btn.click();queueMicrotask(()=>delete btn.dataset.ttProtectedDispatch);
}
function enhance(scope=document){
  scope.querySelectorAll?.('.tt-wo-row').forEach(row=>{if(row.dataset.ttKeyboard==='1')return;row.dataset.ttKeyboard='1';row.tabIndex=0;row.setAttribute('role','button');row.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();row.click();}});});
  scope.querySelectorAll?.('.tt-rpi-action').forEach(form=>{form.setAttribute('aria-label','Protected repair inventory action');});
}
document.addEventListener('submit',protectSubmit,true);
document.addEventListener('click',protectDispatch,true);
new MutationObserver(records=>records.forEach(r=>r.addedNodes.forEach(n=>{if(n.nodeType===1)enhance(n)}))).observe(document.body,{childList:true,subtree:true});
enhance(document);
window.TotalToolsRepairsProtectedUI={refresh:()=>enhance(document),notify};
})();