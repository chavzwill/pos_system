(()=>{'use strict';
const VERSION='20260825-2025';
const loaded=new Set();
const nativeFetch=window.fetch.bind(window);
let profileResponsePromise=null;
window.fetch=function(input,init){const url=typeof input==='string'?input:(input&&input.url)||'',method=String(init?.method||'GET').toUpperCase();if(method==='GET'&&/\/api\/workspace-profile\/me(?:\?|$)/.test(url)){if(!profileResponsePromise)profileResponsePromise=nativeFetch(input,init).then(r=>{if(!r.ok)profileResponsePromise=null;return r;}).catch(e=>{profileResponsePromise=null;throw e;});return profileResponsePromise.then(r=>r.clone());}return nativeFetch(input,init);};
function add(src){if(loaded.has(src)||document.querySelector(`script[data-shell-deferred="${src}"]`))return;loaded.add(src);const s=document.createElement('script');s.src=`${src}?v=${VERSION}`;s.async=false;s.dataset.shellDeferred=src;document.body.appendChild(s);}
function schedule(){const run=()=>{['/guided-mode.js','/guided-mode-orchestrator.js','/guided-mode-access.js','/guided-mode-completion.js','/guided-mode-role-context.js','/guided-mode-record-context.js','/guided-mode-exact-action.js','/guided-mode-hardening.js','/guided-mode-integrity.js','/guided-mode-adversarial.js','/guided-mode-qa.js','/total-tools-identity.js','/shell-native-support.js','/workspace-quality-pass.js'].forEach(add);};if('requestIdleCallback'in window)requestIdleCallback(run,{timeout:450});else setTimeout(run,60);}
if(document.readyState==='complete')schedule();else window.addEventListener('load',schedule,{once:true});
})();