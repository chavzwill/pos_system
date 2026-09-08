(()=>{'use strict';
const root=document.getElementById('shell-root');
if(!root)return;

function ensureToastHost(){
  let host=document.getElementById('tt-premium-toast-stack');
  if(host)return host;
  host=document.createElement('section');
  host.id='tt-premium-toast-stack';
  host.className='tt-premium-toast-stack';
  host.setAttribute('aria-label','Notifications');
  host.setAttribute('aria-live','polite');
  host.setAttribute('aria-relevant','additions text');
  document.body.appendChild(host);
  return host;
}

function notify(message,{tone='error',persist=tone==='error'}={}){
  const text=String(message??'').trim();
  if(!text)return;
  const host=ensureToastHost();
  const item=document.createElement('div');
  item.className=`tt-premium-toast tt-premium-toast--${tone}`;
  item.setAttribute('role',tone==='error'?'alert':'status');
  item.innerHTML=`<div class="tt-premium-toast__mark" aria-hidden="true"></div><div class="tt-premium-toast__copy"><strong>${tone==='error'?'Action needs attention':'Update'}</strong><span></span></div><button type="button" class="tt-premium-toast__close" aria-label="Dismiss notification">×</button>`;
  item.querySelector('span').textContent=text;
  const close=()=>item.remove();
  item.querySelector('button').addEventListener('click',close);
  host.appendChild(item);
  if(!persist)window.setTimeout(close,4800);
}

// Replace browser chrome alerts with an app-owned, accessible notification surface.
window.alert=(message)=>notify(message,{tone:'error',persist:true});
window.TotalToolsPremiumUI={notify};

let drawerBackdrop=null;
let lastDrawerTrigger=null;
let drawerBound=false;

function isCompact(){return window.matchMedia('(max-width: 900px)').matches;}
function getFocusable(container){
  return [...container.querySelectorAll('a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])')]
    .filter(el=>!el.hidden&&el.getAttribute('aria-hidden')!=='true'&&el.offsetParent!==null);
}
function setDrawerState(open,{restoreFocus=true}={}){
  const sidebar=root.querySelector('.shell-sidebar');
  const main=root.querySelector('.shell-main');
  const trigger=document.getElementById('shell-menu');
  if(!sidebar||!trigger)return;
  const active=Boolean(open&&isCompact());
  root.classList.toggle('menu-open',active);
  trigger.setAttribute('aria-expanded',String(active));
  trigger.setAttribute('aria-controls','tt-shell-sidebar');
  sidebar.id='tt-shell-sidebar';
  sidebar.setAttribute('aria-label','POS navigation');
  if(active){
    lastDrawerTrigger=trigger;
    sidebar.setAttribute('role','dialog');
    sidebar.setAttribute('aria-modal','true');
    if(main)main.inert=true;
    document.body.classList.add('tt-drawer-open');
    if(drawerBackdrop)drawerBackdrop.hidden=false;
    requestAnimationFrame(()=>getFocusable(sidebar)[0]?.focus());
  }else{
    sidebar.setAttribute('role','navigation');
    sidebar.removeAttribute('aria-modal');
    if(main)main.inert=false;
    document.body.classList.remove('tt-drawer-open');
    if(drawerBackdrop)drawerBackdrop.hidden=true;
    if(restoreFocus&&lastDrawerTrigger&&document.contains(lastDrawerTrigger))lastDrawerTrigger.focus({preventScroll:true});
  }
}
function syncDrawerFromClass(){
  const active=root.classList.contains('menu-open');
  const trigger=document.getElementById('shell-menu');
  if(trigger)trigger.setAttribute('aria-expanded',String(Boolean(active&&isCompact())));
  if(!active||!isCompact())setDrawerState(false,{restoreFocus:false});
  else setDrawerState(true,{restoreFocus:false});
}
function bindDrawer(){
  const trigger=document.getElementById('shell-menu');
  const sidebar=root.querySelector('.shell-sidebar');
  if(!trigger||!sidebar||drawerBound)return;
  drawerBound=true;
  trigger.type='button';
  trigger.setAttribute('aria-expanded','false');
  trigger.setAttribute('aria-haspopup','dialog');
  drawerBackdrop=document.createElement('button');
  drawerBackdrop.type='button';
  drawerBackdrop.className='tt-shell-drawer-backdrop';
  drawerBackdrop.hidden=true;
  drawerBackdrop.tabIndex=-1;
  drawerBackdrop.setAttribute('aria-label','Close navigation');
  root.appendChild(drawerBackdrop);
  drawerBackdrop.addEventListener('click',()=>setDrawerState(false));
  trigger.addEventListener('click',()=>queueMicrotask(syncDrawerFromClass));
  sidebar.addEventListener('click',e=>{
    if(e.target.closest('[data-domain],#shell-logout'))queueMicrotask(syncDrawerFromClass);
  });
  new MutationObserver(syncDrawerFromClass).observe(root,{attributes:true,attributeFilter:['class']});
  document.addEventListener('keydown',e=>{
    if(!root.classList.contains('menu-open')||!isCompact())return;
    if(e.key==='Escape'){
      e.preventDefault();
      setDrawerState(false);
      return;
    }
    if(e.key!=='Tab')return;
    const items=getFocusable(sidebar);
    if(!items.length)return;
    const first=items[0],last=items[items.length-1];
    if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
    else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
  });
  window.addEventListener('resize',()=>{if(!isCompact())setDrawerState(false,{restoreFocus:false});},{passive:true});
}

const observer=new MutationObserver(()=>{
  if(root.classList.contains('shell-app'))bindDrawer();
});
observer.observe(root,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});
if(root.classList.contains('shell-app'))bindDrawer();
})();
