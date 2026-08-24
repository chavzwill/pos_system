(()=>{'use strict';
const VERSION='20260824-1444';
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
function schedule(){const run=()=>{add('/guided-mode.js');add('/total-tools-identity.js');add('/shell-native-support.js');};if('requestIdleCallback'in window)requestIdleCallback(run,{timeout:450});else setTimeout(run,60);}
if(document.readyState==='complete')schedule();else window.addEventListener('load',schedule,{once:true});
})();