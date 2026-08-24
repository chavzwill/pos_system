(()=>{'use strict';
const VERSION='20260824-1348';
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
function activeDomain(){const active=document.querySelector('.shell-nav [data-domain].is-active');if(active?.dataset.domain)return active.dataset.domain;const title=String(document.getElementById('shell-title')?.textContent||'').toLowerCase();if(title.includes('sales'))return'sales';if(title.includes('repair')||title.includes('service'))return'service';if(title.includes('rental'))return'rentals';if(title.includes('dispatch')||title.includes('logistics'))return'dispatch';if(title.includes('inventory')||title.includes('warehouse'))return'inventory';if(title.includes('purchasing'))return'purchasing';if(title.includes('customer')||title.includes('crm'))return'crm';if(title.includes('finance')||title.includes('account'))return'finance';if(title.includes('administration'))return'administration';if(title.includes('marketing'))return'marketing';return'';}
function loadCore(){add('/guided-mode.js');add('/total-tools-identity.js');}
function loadForActiveDomain(){const d=activeDomain();if(!d)return false;
  if(d==='sales'){add('/customer-programs-shell-bridge.js');add('/cash-drawer-shell-bridge.js');add('/ecommerce-operations-shell-bridge.js');}
  else if(d==='marketing')add('/customer-programs-shell-bridge.js');
  else if(d==='inventory'){add('/warehouse-shell-bridge.js');add('/suppliers-shell-bridge.js');add('/catalog-admin-shell-bridge.js');add('/ecommerce-operations-shell-bridge.js');}
  else if(d==='purchasing')add('/suppliers-shell-bridge.js');
  else if(d==='finance'){add('/cash-drawer-shell-bridge.js');add('/accounts-receivable-shell-bridge.js');add('/commissions-shell-bridge.js');}
  else if(d==='administration'){add('/ecommerce-operations-shell-bridge.js');add('/integration-admin-shell-bridge.js');add('/denominations-shell-bridge.js');}
  return true;
}
let lastDomain='';
function syncDomain(){const d=activeDomain();if(!d||d===lastDomain)return false;lastDomain=d;loadForActiveDomain();return true;}
function schedule(){loadCore();const run=()=>{if(syncDomain())return;let tries=0;const timer=setInterval(()=>{tries++;if(syncDomain()||tries>20)clearInterval(timer);},100);};if('requestIdleCallback'in window)requestIdleCallback(run,{timeout:700});else setTimeout(run,80);}
document.addEventListener('click',e=>{if(!e.target.closest?.('.shell-nav [data-domain]'))return;setTimeout(syncDomain,0);},true);
window.addEventListener('popstate',()=>setTimeout(syncDomain,0));
if(document.readyState==='complete')schedule();else window.addEventListener('load',schedule,{once:true});
})();