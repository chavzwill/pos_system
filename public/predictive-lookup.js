(()=>{'use strict';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function lookup({domain,query,branchId='',limit=8,signal,includeVariations=true}={}){
  const p=new URLSearchParams({domain:String(domain||''),q:String(query||''),limit:String(limit||8)});
  if(branchId)p.set('branch_id',branchId);
  if(includeVariations===false)p.set('include_variations','false');
  const r=await fetch('/api/predictive-lookup?'+p,{credentials:'same-origin',signal});
  const data=await r.json().catch(()=>({}));
  if(!r.ok)throw Object.assign(new Error('Search unavailable'),{status:r.status,code:data.code||'PREDICTIVE_LOOKUP_UNAVAILABLE'});
  return data;
}
function ensureBox(input,id){
  let box=document.getElementById(id);
  if(!box){
    box=document.createElement('div');
    box.id=id;
    box.className='tt-predictive-list';
    box.setAttribute('role','listbox');
    box.hidden=true;
    input.insertAdjacentElement('afterend',box);
  }
  return box;
}
function resultHtml(r,index){
  const availability=r.availability&&Number.isFinite(Number(r.availability.on_hand))
    ? '<small>'+esc(r.availability.on_hand)+' on hand</small>' : '';
  return '<button type="button" role="option" class="tt-predictive-option" data-lookup-index="'+index+'" aria-selected="false"><span><strong>'+esc(r.primary_label)+'</strong><small>'+esc(r.secondary_label||r.matched_value||'')+'</small></span>'+availability+'</button>';
}
function attach(input,opts={}){
  if(typeof input==='string')input=document.querySelector(input);
  if(!input)return null;
  const domain=opts.domain||input.dataset.lookupDomain;
  if(!domain)return null;
  const id=opts.listId||('tt-lookup-'+Math.random().toString(36).slice(2));
  const box=ensureBox(input,id);
  let results=[],active=-1,timer=null,controller=null,requestSequence=0;
  input.setAttribute('role','combobox');
  input.setAttribute('aria-autocomplete','list');
  input.setAttribute('aria-controls',id);
  input.setAttribute('aria-expanded','false');

  function close(){
    box.hidden=true;
    input.setAttribute('aria-expanded','false');
    active=-1;
    input.removeAttribute('aria-activedescendant');
  }
  function paint(){
    box.innerHTML=results.length?results.map(resultHtml).join(''):'<div class="tt-predictive-empty">No matching records.</div>';
    box.hidden=false;
    input.setAttribute('aria-expanded','true');
    box.querySelectorAll('[data-lookup-index]').forEach(btn=>btn.addEventListener('pointerdown',e=>{
      e.preventDefault();
      select(Number(btn.dataset.lookupIndex));
    }));
  }
  function mark(){
    box.querySelectorAll('[data-lookup-index]').forEach((el,i)=>{
      const on=i===active;
      el.setAttribute('aria-selected',on?'true':'false');
      if(on){
        el.id=id+'-active';
        input.setAttribute('aria-activedescendant',el.id);
        el.scrollIntoView({block:'nearest'});
      }
    });
  }
  async function select(index){
    const row=results[index];
    if(!row)return;
    close();
    if(opts.setValue!==false)input.value=opts.valueFor?opts.valueFor(row):(row.primary_label||row.secondary_label||'');
    if(typeof opts.onSelect==='function')await opts.onSelect(row);
  }
  async function run(){
    const query=input.value.trim();
    if(query.length<(opts.minLength||2)){results=[];close();return;}
    if(controller)controller.abort();
    controller=new AbortController();
    const sequence=++requestSequence;
    box.hidden=false;
    box.innerHTML='<div class="tt-predictive-empty">Searching…</div>';
    input.setAttribute('aria-expanded','true');
    try{
      const data=await lookup({
        domain,
        query,
        branchId:typeof opts.branchId==='function'?opts.branchId():opts.branchId,
        limit:opts.limit||8,
        signal:controller.signal,
        includeVariations:opts.includeVariations!==false
      });
      if(sequence!==requestSequence)return;
      results=Array.isArray(data.results)?data.results:[];
      paint();
      if(opts.autoSelectExact&&data.exact_match&&!data.ambiguous_exact){
        const index=results.findIndex(x=>x.entity_type===data.exact_match.entity_type&&String(x.entity_id)===String(data.exact_match.entity_id));
        if(index>=0)await select(index);
      }
    }catch(error){
      if(error?.name==='AbortError'||sequence!==requestSequence)return;
      console.warn('Predictive lookup unavailable',error?.code||error?.status||'request_failed');
      results=[];
      box.hidden=false;
      box.innerHTML='<div class="tt-predictive-empty">Search is temporarily unavailable. Try again.</div>';
    }
  }
  input.addEventListener('input',()=>{
    clearTimeout(timer);
    timer=setTimeout(run,Number(opts.debounceMs??160));
  });
  input.addEventListener('keydown',e=>{
    if(e.key==='ArrowDown'){
      if(box.hidden)return;
      active=Math.min(results.length-1,active+1);
      mark();e.preventDefault();
    }else if(e.key==='ArrowUp'){
      if(box.hidden)return;
      active=Math.max(0,active-1);
      mark();e.preventDefault();
    }else if(e.key==='Enter'&&!box.hidden&&active>=0){
      e.preventDefault();select(active);
    }else if(e.key==='Escape'){
      close();
    }
  });
  input.addEventListener('blur',()=>setTimeout(close,120));
  return{
    search:run,
    close,
    destroy(){clearTimeout(timer);controller?.abort();box.remove();},
    getResults:()=>results.slice()
  };
}
function attachAll(root=document){
  root.querySelectorAll('[data-lookup-domain]').forEach(el=>{
    if(!el.dataset.lookupBound){
      el.dataset.lookupBound='1';
      attach(el,{domain:el.dataset.lookupDomain});
    }
  });
}
window.TotalToolsPredictiveLookup={lookup,attach,attachAll};
document.addEventListener('DOMContentLoaded',()=>attachAll());
})();
