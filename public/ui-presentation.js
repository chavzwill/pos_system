(()=>{'use strict';
let active=null,opening=false,lastTrigger=null,sequence=0;
const dialogs=new WeakSet(),returns=new Map();
const visible=n=>n instanceof HTMLElement&&n.getClientRects().length>0&&getComputedStyle(n).visibility!=='hidden';
const focusable=root=>[...root.querySelectorAll('input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),button:not([disabled]),a[href],[tabindex="0"]')].filter(visible);
function labelControls(root){
 root.querySelectorAll('input,select,textarea').forEach(n=>{if(!n.labels?.length&&!n.hasAttribute('aria-label')&&!n.hasAttribute('aria-labelledby'))n.setAttribute('aria-label',n.placeholder||String(n.name||'').replace(/_/g,' ')||'Select option');});
 root.querySelectorAll('button').forEach(n=>{const t=n.textContent.trim();if(!n.hasAttribute('aria-label')&&/^[×✕]$/.test(t))n.setAttribute('aria-label',n.matches('[data-remove],[data-tender-remove]')?'Remove item':'Close dialog');});
}
function syncMenu(){const root=document.getElementById('shell-root'),menu=document.getElementById('shell-menu'),side=document.querySelector('.shell-sidebar'),main=document.querySelector('.shell-main');const mobile=matchMedia('(max-width:1023px)').matches,open=!!root?.classList.contains('menu-open');if(menu)menu.setAttribute('aria-expanded',open?'true':'false');if(side)side.inert=mobile&&!open;if(main)main.inert=mobile&&open;}
window.addEventListener('resize',syncMenu);
function restoreHome(){
 const previous=active?.trigger;active=null;
 window.TotalToolsShellUI?.home?.();
 if(previous?.isConnected)requestAnimationFrame(()=>previous.focus({preventScroll:true}));
}
function closeWorkspace(){
 if(!active)return;
 const old=active;active=null;old.api.close?.();
 if(old.root.isConnected)old.root.remove();
 window.TotalToolsShellUI?.home?.();
 if(old.trigger?.isConnected)requestAnimationFrame(()=>old.trigger.focus({preventScroll:true}));
}
async function mount(key,title,api,options={}){
 const content=document.getElementById('shell-content');
 if(!content)return api.open(options);
 opening=true;
 const trigger=document.activeElement;
 if(active&&active.key!==key){active.api.close?.();active.root.remove();active=null;}
 const before=new Set(document.body.children);
 try{
  await api.open(key==='receiving-workspace'?(options?.poId||null):options);
  let root=active?.key===key?active.root:null;
  if(!root)root=[...document.body.children].filter(n=>!before.has(n)&&n instanceof HTMLElement&&!['SCRIPT','STYLE','LINK'].includes(n.tagName)&&!['tt-guided-mode','shell-toast-host'].includes(n.id)).find(n=>n.querySelector('h2,h3,header,form')||n.matches('[id^=tt-],.wow-overlay,.arw-overlay,.cm-overlay,.iaw-layer'));
  if(!root)throw new Error('The workspace did not mount its operational content.');
  root.dataset.ttWorkspace=key;root.setAttribute('role','region');root.removeAttribute('aria-modal');root.tabIndex=-1;
  const heading=root.querySelector('h1,h2,h3');
  if(heading){if(!heading.id)heading.id='tt-workspace-heading-'+(++sequence);root.setAttribute('aria-labelledby',heading.id);}else root.setAttribute('aria-label',title||'Workspace');
  for(const child of root.children){if(child.getAttribute('role')==='dialog'){child.removeAttribute('role');child.removeAttribute('aria-modal');}}
  content.replaceChildren(root);active={key,title,api,root,trigger};
  labelControls(root);document.title=(title||'Workspace')+' · Total Tools';
  document.dispatchEvent(new CustomEvent('tt:workspace-mounted',{detail:{key,title}}));
  const input=root.querySelector('input[type=search],input[id*="search"],[data-search]');
  requestAnimationFrame(()=>{if(input)input.focus({preventScroll:true});else root.focus({preventScroll:true});});
  return true;
 }finally{opening=false;}
}
function inspect(node){
 if(!(node instanceof HTMLElement))return;
 labelControls(node);
 const found=[...(node.matches('[role=dialog]')?[node]:[]),...node.querySelectorAll('[role=dialog]')];
 for(const dialog of found){
  if(dialogs.has(dialog)||dialog.closest('.shell-command,.shell-input-dialog')||dialog.getAttribute('aria-modal')!=='true')continue;
  dialogs.add(dialog);returns.set(dialog,lastTrigger||document.activeElement);
  if(!dialog.hasAttribute('aria-labelledby')&&!dialog.hasAttribute('aria-label')){const h=dialog.querySelector('h1,h2,h3');if(h){if(!h.id)h.id='tt-dialog-title-'+(++sequence);dialog.setAttribute('aria-labelledby',h.id);}else dialog.setAttribute('aria-label','Review details');}
  requestAnimationFrame(()=>{if(dialog.isConnected&&dialog.getAttribute('aria-modal')==='true')(focusable(dialog)[0]||dialog).focus?.({preventScroll:true});});
 }
}
document.addEventListener('pointerdown',e=>{if(e.target.closest)lastTrigger=e.target.closest('button,a,input,select,textarea')||document.activeElement;},true);
document.addEventListener('click',e=>{setTimeout(syncMenu,0);if(e.target.closest?.('#shell-menu'))setTimeout(()=>{if(document.getElementById('shell-root')?.classList.contains('menu-open'))document.querySelector('.shell-nav button')?.focus();},0);
 if(e.target.closest?.('.shell-nav [data-domain]')){if(active)closeWorkspace();return;}
 const close=e.target.closest?.('[data-close],button[aria-label^="Close"],button[class*="__close"]');
 if(close&&active)setTimeout(()=>{if(active&&!active.root.isConnected)restoreHome();},0);
},true);
document.addEventListener('keydown',e=>{
 const app=document.getElementById('shell-root'),menu=document.getElementById('shell-menu');
 if(app?.classList.contains('menu-open')){
  if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();app.classList.remove('menu-open');syncMenu();menu?.focus();return;}
  if(e.key==='Tab'){const controls=[menu,...focusable(document.querySelector('.shell-sidebar'))].filter(visible),first=controls[0],last=controls.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
 }

 if((e.key==='Enter'||e.key===' ')&&e.target instanceof HTMLElement)lastTrigger=e.target;
 if(e.key==='Escape'&&document.getElementById('tt-guided-mode'))return;
 const modal=[...document.querySelectorAll('[role=dialog][aria-modal=true]')].filter(visible).filter(n=>!n.closest('.shell-command,.shell-input-dialog')).at(-1);
 if(modal){
  const controls=focusable(modal),first=controls[0],last=controls.at(-1);
  if(e.key==='Tab'&&first){if(e.shiftKey&&(!modal.contains(document.activeElement)||document.activeElement===first)){e.preventDefault();last.focus();}else if(!e.shiftKey&&(!modal.contains(document.activeElement)||document.activeElement===last)){e.preventDefault();first.focus();}}
  if(e.key==='Escape'){
   const close=modal.querySelector('[data-cancel],[data-close],[data-tx-close],[data-modal-close],[aria-label^="Close"],button[class*="close"]');
   if(close){e.preventDefault();e.stopImmediatePropagation();close.click();}
  }
 }else if(e.key==='Escape'&&active&&!document.querySelector('.shell-command,.shell-input-dialog')){
  e.preventDefault();e.stopImmediatePropagation();closeWorkspace();
 }
},true);
new MutationObserver(records=>{
 for(const record of records)for(const node of record.addedNodes)inspect(node);syncMenu();
 for(const [dialog,target] of returns){if(!dialog.isConnected){returns.delete(dialog);if(target?.isConnected)requestAnimationFrame(()=>target.focus?.({preventScroll:true}));}}
 if(active&&!opening&&!active.root.isConnected)restoreHome();
}).observe(document.body,{childList:true,subtree:true});
window.TotalToolsPresentation={mount,close:closeWorkspace};
})();