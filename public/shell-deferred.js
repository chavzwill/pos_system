(()=>{'use strict';
const VERSION='20260909-replacement-variation-v5';
const loaded=new Set();
let scheduled=false;
function ensureStyle(){if(document.querySelector('link[data-native-pos-stability]'))return;const l=document.createElement('link');l.rel='stylesheet';l.href=`/native-pos-stability.css?v=${VERSION}`;l.dataset.nativePosStability='1';document.head.appendChild(l);}
function add(src){if(loaded.has(src)||document.querySelector(`script[data-shell-deferred="${src}"]`))return;loaded.add(src);const s=document.createElement('script');s.src=`${src}?v=${VERSION}`;s.async=false;s.dataset.shellDeferred=src;s.onerror=()=>console.error('Deferred POS enhancer failed to load',src);document.body.appendChild(s);}
function loadAuthenticatedEnhancers(){if(scheduled)return;scheduled=true;const run=()=>{ensureStyle();
  // Keep the global authenticated shell deliberately small. Older builds loaded
  // many overlapping Guided Mode and logistics mutation observers here, which
  // caused duplicated handlers, expensive DOM churn and renderer instability.
  // Workspace-specific enhancers now belong to the workspace that opens them.
  [
    '/security-permission-extension.js',
    '/guided-mode.js',
    '/replacement-identity-exchange-ui.js',
    '/total-tools-identity.js',
    '/shell-native-support.js',
    '/operations-attention-center.js',
    '/workspace-quality-pass.js'
  ].forEach(add);
};if('requestIdleCallback'in window)requestIdleCallback(run,{timeout:350});else setTimeout(run,40);}
function authenticated(){return !!window.__TT_WORKSPACE_PROFILE__||!!document.querySelector('.shell-app');}
function schedule(){if(authenticated())return loadAuthenticatedEnhancers();const root=document.getElementById('shell-root');if(!root)return;const observer=new MutationObserver(()=>{if(authenticated()){observer.disconnect();loadAuthenticatedEnhancers();}});observer.observe(root,{attributes:true,attributeFilter:['class'],childList:true,subtree:false});}
if(document.readyState==='complete')schedule();else window.addEventListener('load',schedule,{once:true});
})();