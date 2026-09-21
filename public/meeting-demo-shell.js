(()=>{'use strict';
let mounted=false;
function q(s,r=document){return r.querySelector(s)}
function qa(s,r=document){return [...r.querySelectorAll(s)]}
function enhance(){
  const app=q('.shell-app'),top=q('.shell-topbar');
  if(!app||!top||mounted)return;
  mounted=true;

  const left=top.firstElementChild;
  const branch=top.lastElementChild;

  const search=document.createElement('label');
  search.className='shell-command-search';
  search.setAttribute('aria-label','Search your tools');
  search.innerHTML='<input type="search" placeholder="Search your tools and workspaces" autocomplete="off"><kbd>Ctrl K</kbd>';

  const quick=document.createElement('button');
  quick.type='button';
  quick.className='shell-quick-actions';
  quick.textContent='Quick actions';
  quick.setAttribute('aria-haspopup','menu');
  quick.setAttribute('aria-expanded','false');

  if(branch&&branch!==left){
    top.insertBefore(search,branch);
    top.insertBefore(quick,branch);
  }else{
    top.appendChild(search);
    top.appendChild(quick);
  }

  const input=q('input',search);
  function cards(){return qa('.shell-card').filter(card=>!card.hidden)}
  function filter(){
    const term=input.value.trim().toLowerCase();
    qa('.shell-card').forEach(card=>{
      card.hidden=!!term&&!card.textContent.toLowerCase().includes(term);
    });
  }
  input.addEventListener('input',filter);
  input.addEventListener('keydown',e=>{
    if(e.key==='Escape'){
      input.value='';
      filter();
      input.blur();
    }
    if(e.key==='Enter'){
      const first=cards()[0]?.querySelector('button');
      if(first){
        e.preventDefault();
        first.click();
      }
    }
  });
  document.addEventListener('keydown',e=>{
    if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){
      e.preventDefault();
      input.focus();
      input.select();
    }
  });

  function closeMenu(){
    q('.shell-quick-menu')?.remove();
    quick.setAttribute('aria-expanded','false');
  }
  quick.addEventListener('click',e=>{
    e.stopPropagation();
    if(q('.shell-quick-menu')){
      closeMenu();
      return;
    }
    const available=cards().slice(0,7);
    if(!available.length)return;

    const menu=document.createElement('div');
    menu.className='shell-quick-menu';
    menu.setAttribute('role','menu');
    menu.innerHTML='<strong>Quick actions</strong><span>Open one of the tools available in this workspace.</span>';

    available.forEach(card=>{
      const source=card.querySelector('button');
      const title=card.querySelector('strong')?.textContent?.trim()||'Open tool';
      if(!source)return;
      const action=document.createElement('button');
      action.type='button';
      action.setAttribute('role','menuitem');
      action.textContent=title;
      action.addEventListener('click',()=>{
        closeMenu();
        source.click();
      });
      menu.appendChild(action);
    });

    quick.insertAdjacentElement('afterend',menu);
    quick.setAttribute('aria-expanded','true');
    menu.querySelector('button')?.focus();
  });
  document.addEventListener('click',e=>{
    if(!e.target.closest('.shell-quick-menu')&&!e.target.closest('.shell-quick-actions'))closeMenu();
  });

  const hero=q('.shell-hero p');
  if(hero)hero.textContent='Everything you can use for your job is here. Choose a task below, or search for what you need.';
}
const observer=new MutationObserver(()=>{if(!mounted)enhance();});
observer.observe(document.documentElement,{subtree:true,childList:true});
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',enhance,{once:true});
else enhance();
})();