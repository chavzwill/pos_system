(()=>{'use strict';
const VERSION='20260824-1340';
const loaded=new Set();
const nativeFetch=window.fetch.bind(window);
let profileResponsePromise=null;
window.fetch=function(input,init){
  const url=typeof input==='string'?input:(input&&input.url)||'';
  const method=String(init?.method||'GET').toUpperCase();
  if(method==='GET'&&/\/api\/workspace-profile\/me(?:\?|$)/.test(url)){
    if(!profileResponsePromise)profileResponsePromise=nativeFetch(input,init).then(r=>{if(!r.ok)profileResponsePromise=null;return r;}).catch(e=>{profileResponsePromise=null;throw e;});
    return profileResponsePromise.then(r=>r.clone());
  }
  return nativeFetch(input,init);
};
function add(src){if(loaded.has(src)||document.querySelector(`script[data-shell-deferred="${src}"]`))return;loaded.add(src);const s=document.createElement('script');s.src=`${src}?v=${VERSION}`;s.defer=true;s.dataset.shellDeferred=src;document.body.appendChild(s);}
function domains(){return new Set([...document.querySelectorAll('.shell-nav [data-domain]')].map(x=>x.dataset.domain).filter(Boolean));}
function has(ds,...wanted){return wanted.some(x=>ds.has(x));}
function loadForRole(){const ds=domains();if(!ds.size)return false;
  add('/guided-mode.js');add('/total-tools-identity.js');
  if(has(ds,'sales','marketing'))add('/customer-programs-shell-bridge.js');
  if(has(ds,'inventory','purchasing')){add('/warehouse-shell-bridge.js');add('/suppliers-shell-bridge.js');add('/catalog-admin-shell-bridge.js');}
  if(has(ds,'sales','finance'))add('/cash-drawer-shell-bridge.js');
  if(has(ds,'finance')){add('/accounts-receivable-shell-bridge.js');add('/commissions-shell-bridge.js');}
  if(has(ds,'sales','inventory','administration'))add('/ecommerce-operations-shell-bridge.js');
  if(has(ds,'administration')){add('/integration-admin-shell-bridge.js');add('/denominations-shell-bridge.js');}
  return true;
}
function schedule(){const run=()=>{if(loadForRole())return;let tries=0;const timer=setInterval(()=>{tries++;if(loadForRole()||tries>20)clearInterval(timer);},100);};if('requestIdleCallback'in window)requestIdleCallback(run,{timeout:900});else setTimeout(run,120);}
if(document.readyState==='complete')schedule();else window.addEventListener('load',schedule,{once:true});
})();