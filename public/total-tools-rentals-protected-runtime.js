(()=>{'use strict';
const ROOT='#tt-rentals-workspace';
const ui=()=>window.TotalToolsPremiumUI||{};
const notify=(message,{tone='error',persist=tone==='error'}={})=>ui().notify?ui().notify(message,{tone,persist}):alert(message);
const confirmAction=async options=>ui().confirm?ui().confirm(options):confirm(options.message||options.title||'Confirm?');

function selectedAgreement(){
  const root=document.querySelector(ROOT);
  const row=root?.querySelector('.tt-rent__row.is-selected[data-id]');
  const title=root?.querySelector('.tt-rent__detail-head h3')?.textContent?.trim()||'this rental agreement';
  return row?{id:row.dataset.id,label:title}:null;
}
async function profile(){
  const r=await fetch('/api/workspace-profile/me',{credentials:'same-origin'});
  const data=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(data.error||`Request failed (${r.status})`);
  return data;
}
async function resumeRental(){
  const agreement=selectedAgreement();
  if(!agreement)return;
  const ok=await confirmAction({
    title:`Resume ${agreement.label}?`,
    message:'Paused billing time will end and the rental due date will be extended by the paused duration. This changes the authoritative rental lifecycle.',
    confirmLabel:'Resume rental',
    cancelLabel:'Keep paused',
    tone:'default'
  });
  if(!ok)return;
  const button=document.querySelector(`${ROOT} #tt-rent-resume`);
  const original=button?.textContent||'Resume rental';
  if(button){button.disabled=true;button.textContent='Resuming…';}
  try{
    const p=await profile();
    const r=await fetch(`/api/rentals/agreements/${encodeURIComponent(agreement.id)}/resume`,{
      method:'PATCH',credentials:'same-origin',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({employee_id:p?.employee?.id||null})
    });
    const data=await r.json().catch(()=>({}));
    if(!r.ok){
      const err=new Error(data.error||`Request failed (${r.status})`);
      err.status=r.status;err.retryAfter=r.headers.get('Retry-After')||'';throw err;
    }
    notify(`${agreement.label} resumed successfully.`,{tone:'success',persist:false});
    await window.TotalToolsRentalsWorkspace?.refresh?.();
  }catch(e){
    if(Number(e.status)===409){
      notify(`Another rental operation is already changing ${agreement.label}.${e.retryAfter?` Try again in about ${e.retryAfter} seconds.`:' Try again after that operation finishes.'}`,{tone:'error',persist:true});
    }else notify(e.message||'The rental could not be resumed.',{tone:'error',persist:true});
    if(button&&document.contains(button)){button.disabled=false;button.textContent=original;}
  }
}

const protectedLabels=new Map([
  ['Submit for review',{title:'Declare this item missing?',message:'This creates a controlled missing-asset case. It does not process the item as a normal return and will require independent review before inventory disposition.',confirmLabel:'Submit missing-asset case',tone:'danger'}],
  ['Approve disposition',{title:'Approve missing-asset disposition?',message:'Approval can remove the missing asset from physical inventory and record the accounting loss. Customer recovery remains separately collectible.',confirmLabel:'Approve disposition',tone:'danger'}],
  ['Reject declaration',{title:'Reject this missing-asset declaration?',message:'The declaration will not proceed to inventory disposition or customer recovery. The rejection reason remains part of the audit evidence.',confirmLabel:'Reject declaration',tone:'danger'}],
  ['Post recovery',{title:'Post customer recovery?',message:'This records the selected payment against the approved missing-asset recovery. Confirm the amount and payment method before posting.',confirmLabel:'Post recovery',tone:'default'}],
  ['Save assignments',{title:'Assign these physical rental assets?',message:'The selected serialized assets will become the authoritative units attached to this rental agreement.',confirmLabel:'Save assignments',tone:'default'}]
]);

function protectRentalModalSubmit(event){
  const form=event.target;
  if(!(form instanceof HTMLFormElement)||form.id!=='tt-rent-modal-form')return;
  if(form.dataset.ttProtectedConfirmed==='1'){
    delete form.dataset.ttProtectedConfirmed;
    return;
  }
  const submit=event.submitter||form.querySelector('[type="submit"]');
  const label=(submit?.textContent||'').trim();
  const spec=protectedLabels.get(label);
  if(!spec)return;
  event.preventDefault();
  event.stopImmediatePropagation();
  confirmAction({...spec,cancelLabel:'Go back'}).then(ok=>{
    if(!ok)return;
    form.dataset.ttProtectedConfirmed='1';
    if(typeof form.requestSubmit==='function')form.requestSubmit(submit instanceof HTMLElement?submit:undefined);
    else form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
  });
}

function enhanceModal(modal){
  if(!(modal instanceof HTMLElement)||modal.dataset.ttPremiumRentalModal==='1')return;
  modal.dataset.ttPremiumRentalModal='1';
  const heading=modal.querySelector('h3');
  if(heading&&!heading.id)heading.id=`tt-rent-modal-title-${Date.now()}`;
  modal.setAttribute('role','dialog');
  modal.setAttribute('aria-modal','true');
  if(heading?.id)modal.setAttribute('aria-labelledby',heading.id);
  const error=modal.querySelector('.tt-rent__modal-error');
  if(error){error.setAttribute('role','alert');error.setAttribute('aria-live','assertive');}
  const fields=[...modal.querySelectorAll('input,select,textarea')];
  const first=fields.find(x=>!x.disabled)||modal.querySelector('button');
  requestAnimationFrame(()=>first?.focus());
}
function enhanceRows(root){
  root.querySelectorAll('.tt-rent__row[data-id]').forEach(row=>{
    if(row.dataset.ttKeyboardRow==='1')return;
    row.dataset.ttKeyboardRow='1';row.tabIndex=0;row.setAttribute('role','button');
    row.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();row.click();}});
  });
}
function enhance(root=document){
  const rentals=root.matches?.(ROOT)?root:root.querySelector?.(ROOT);
  if(!rentals)return;
  enhanceRows(rentals);
  rentals.querySelectorAll('.tt-rent__modal').forEach(enhanceModal);
}

document.addEventListener('click',e=>{
  const button=e.target.closest?.(`${ROOT} #tt-rent-resume`);
  if(!button)return;
  e.preventDefault();e.stopImmediatePropagation();
  resumeRental();
},true);
document.addEventListener('submit',protectRentalModalSubmit,true);

new MutationObserver(records=>{
  for(const record of records)record.addedNodes.forEach(node=>{if(node.nodeType===1)enhance(node);});
  enhance(document);
}).observe(document.body,{childList:true,subtree:true});
enhance(document);
})();