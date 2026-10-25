(()=>{'use strict';
const drafts=new Map(),forms=new Map(),seen=new WeakSet();let owner='',checking=false,replay=false;
function scope(){const p=window.__TT_WORKSPACE_PROFILE__,id=p?.employee?.id,branch=p?.employee?.default_branch_id;if(!id)return '';return String(id)+':'+String(branch||'');}
function current(){const next=scope();if(next!==owner){drafts.clear();owner=next;}return next;}
function put(key,value){if(!current())return;drafts.delete(key);drafts.set(key,{value:structuredClone(value),expires:Date.now()+30*60*1000});if(drafts.size>20)drafts.delete(drafts.keys().next().value);}
function take(key){if(!current())return null;const entry=drafts.get(key);if(!entry||entry.expires<Date.now()){drafts.delete(key);return null;}return structuredClone(entry.value);}
function clear(key){if(key)drafts.delete(key);else{drafts.clear();forms.clear();owner='';}}
function watch(root,options){current();forms.set(root,{...options,owner:scope()});if(!seen.has(root)){seen.add(root);const keep=()=>queueMicrotask(()=>{const work=forms.get(root);if(root.isConnected&&work?.owner===scope()&&work.dirty())work.keep();});root.addEventListener('input',keep);root.addEventListener('change',keep);}}
function active(within){const all=[...forms].filter(([root,value])=>root.isConnected&&value.owner===scope());const local=within?all.filter(([root])=>root.contains(within)):[];return (local.length?local:all).map(([,value])=>value).filter(value=>value.dirty());}
async function leave({discard=false,within=null}={}){if(replay)return true;const pending=active(within);if(!pending.length)return true;if(checking)return false;checking=true;try{
 const busy=pending.some(x=>x.saving?.());if(busy){window.TotalToolsShellUI?.toast?.('A submission is in progress. Wait for its result before leaving.','info');return false;}
 const agreed=await window.TotalToolsShellUI?.confirm?.({title:'Leave unfinished purchasing work?',message:discard?'Signing out clears all tab drafts. Unconfirmed submissions may already exist; check their records before submitting again. Continue signing out?':'Keep this draft in the current tab and leave this task? Return to the same task to resume it. Closing or refreshing the app loses tab drafts.',confirmLabel:discard?'Sign out and clear drafts':'Keep draft and leave',cancelLabel:'Continue editing'});
 if(!agreed)return false;pending.forEach(x=>x.keep());return true;
 }finally{checking=false;}}
const navigation='[data-close],[data-compose-close],.shell-nav [data-domain],[data-open],.shell-command-result,#shell-logout,[data-tab],#tt-purch-new-po,#tt-purch-new-pr,#tt-purch-refresh,#tt-fr-search-btn,[data-po],#tt-fr-clear';
document.addEventListener('click',event=>{if(replay)return;const button=event.target.closest?.(navigation);if(!button||button.closest('.shell-input-dialog')||!active(button).length)return;const restoring=!!window.__TT_NAV_RESTORING__;event.preventDefault();event.stopImmediatePropagation();leave({discard:button.id==='shell-logout',within:button}).then(ok=>{if(ok&&button.isConnected){replay=true;const previous=window.__TT_NAV_RESTORING__;if(restoring)window.__TT_NAV_RESTORING__=true;try{button.click();}finally{window.__TT_NAV_RESTORING__=previous;replay=false;}}});},true);
document.addEventListener('keydown',event=>{if(replay||document.querySelector('#shell-root.menu-open')||!['Escape','F2','F3'].includes(event.key)||event.target.closest?.('.shell-input-dialog,.shell-command')||!active(event.target).length)return;event.preventDefault();event.stopImmediatePropagation();leave({within:event.target}).then(ok=>{if(!ok)return;replay=true;try{(event.target.isConnected?event.target:document).dispatchEvent(new KeyboardEvent('keydown',{key:event.key,bubbles:true,cancelable:true}));}finally{replay=false;}});},true);
window.addEventListener('beforeunload',event=>{if(active().length){event.preventDefault();event.returnValue='';}});
new MutationObserver(()=>{if(owner&&scope()!==owner){clear();return;}for(const [root,work]of forms)if(!root.isConnected){if(work.owner===scope()&&work.dirty())work.keep();forms.delete(root);}}).observe(document.body,{subtree:true,childList:true});
window.TotalToolsWorkProtection={put,take,clear,watch,leave};
})();
