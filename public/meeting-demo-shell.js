(()=>{'use strict';
let mounted=false;
function q(s,r=document){return r.querySelector(s)}
function qa(s,r=document){return [...r.querySelectorAll(s)]}
function enhance(){
  const app=q('.shell-app'),top=q('.shell-topbar');
  if(!app||!top||mounted)return;
  mounted=true;
  const left=top.firstElementChild;
  const search=document.createElement('label');
  search.className='shell-command-search';
  search.setAttribute('aria-label','Search operational tools');
  search.innerHTML='<input type="search" placeholder="Search tools, workspaces, operations…" autocomplete="off"><kbd>⌘K</kbd>';
  const quick=document.createElement('button');
  quick.type='button';quick.className='shell-quick-actions';quick.textContent='⚡ Quick actions';
  const health=document.createElement('button');
  health.type='button';health.className='shell-quick-actions shell-readiness';health.textContent='✓ System health';
  const branch=top.lastElementChild;
  if(branch&&branch!==left){top.insertBefore(search,branch);top.insertBefore(quick,branch);top.insertBefore(health,branch);}else{top.appendChild(search);top.appendChild(quick);top.appendChild(health);}
  const input=q('input',search);
  function filter(){const term=input.value.trim().toLowerCase();qa('.shell-card').forEach(card=>{card.hidden=!!term&&!card.textContent.toLowerCase().includes(term)});}
  input.addEventListener('input',filter);
  input.addEventListener('keydown',e=>{if(e.key==='Escape'){input.value='';filter();input.blur();}if(e.key==='Enter'){const first=qa('.shell-card').find(c=>!c.hidden);first?.querySelector('button')?.focus();}});
  document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();input.focus();input.select();}});
  quick.addEventListener('click',()=>{
    const buttons=qa('.shell-card button');
    const preferred=buttons.find(b=>/point of sale|purchasing|work orders|operational attention|inventory/i.test(b.closest('.shell-card')?.textContent||''))||buttons[0];
    preferred?.focus();preferred?.scrollIntoView({behavior:'smooth',block:'center'});
  });
  health.addEventListener('click',async()=>{
    if(!window.TotalToolsSystemHealth){health.disabled=true;health.textContent='Loading health checks…';await new Promise(r=>setTimeout(r,120));health.disabled=false;health.textContent='✓ System health';}
    window.TotalToolsSystemHealth?.open?.();
  });
  const hero=q('.shell-hero p');
  if(hero)hero.textContent='Fast access to the operational tools, intelligence and controls available to your role.';
}
const obs=new MutationObserver(()=>{if(!mounted)enhance();});
obs.observe(document.documentElement,{subtree:true,childList:true});
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',enhance,{once:true});else enhance();
})();