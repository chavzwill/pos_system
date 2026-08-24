(()=>{'use strict';
const GUIDE='tt-guided-mode';
let baseline=null,lastProfileSig='',lastVisibility=Date.now(),raf=0;
const root=()=>document.getElementById(GUIDE);
const q=(s,r=document)=>r.querySelector(s);
const qa=(s,r=document)=>[...r.querySelectorAll(s)];
const norm=s=>String(s||'').trim().replace(/\s+/g,' ');
function task(){const g=root();return{title:norm(q('.tt-guide__head p',g)?.textContent),step:norm(q('.tt-guide__step-count',g)?.textContent),record:norm(q('.tt-guide__record-context strong,.tt-guide__record-note strong',g)?.textContent)};}
function workspace(){const surfaces=[['purchasing','#tt-purchasing-workspace'],['repairs','#tt-work-orders-workspace'],['rentals','#tt-rentals-workspace'],['inventory','#tt-inventory-workspace'],['quotes','#tt-quotes'],['returns','#tt-cashier-controls'],['dispatch','#tt-logistics-intelligence'],['receivables','.arw-overlay.open'],['sales','#tt-sales-workspace']];for(const [name,sel] of surfaces)if(q(sel))return name;return q('.shell-nav [data-domain].is-active')?.dataset.domain||'';}
function profileSig(){const p=window.__TT_WORKSPACE_PROFILE__;if(!p)return'';return JSON.stringify({employee:p.employee?.id||null,domains:[...(p.domains||[])].sort(),role:p.employee?.role||p.employee?.role_name||''});}
function pause(msg){window.TotalToolsGuidedModeIntegrity?.pause?.(msg);}
function resume(){window.TotalToolsGuidedModeIntegrity?.resume?.();}
function snapshot(){const t=task();return{...t,workspace:workspace(),profile:profileSig()};}
function meaningfulChange(a,b){if(!a||!b)return false;if(a.title!==b.title||a.step!==b.step)return false;if(a.profile&&b.profile&&a.profile!==b.profile)return'profile';if(a.workspace&&b.workspace&&a.workspace!==b.workspace)return'workspace';if(a.record&&b.record&&a.record!==b.record)return'record';return false;}
function capture(){baseline=snapshot();lastProfileSig=baseline.profile||lastProfileSig;}
function validateContinuity(){raf=0;const g=root();if(!g){baseline=null;return;}const now=snapshot();if(!baseline){capture();return;}const change=meaningfulChange(baseline,now);if(change==='profile'){pause('Your signed-in role or permissions changed while this guide was active. Guided Mode paused so the workflow can be revalidated for the current employee.');baseline=now;return;}if(change==='workspace'){pause('The active workspace changed during this guided step. Guided Mode paused so it does not continue using instructions from the previous area.');baseline=now;return;}if(change==='record'){pause('A different record is now selected. Guided Mode paused so actions for the previous record are not applied to this one.');baseline=now;return;}baseline=now;}
function schedule(){if(!raf)raf=requestAnimationFrame(validateContinuity);}
function guardRapidLauncher(e){const launcher=e.target.closest?.('#tt-guide-launcher,#tt-guide-access,#tt-guide-quick');if(!launcher)return;const guides=document.querySelectorAll('#'+GUIDE);if(guides.length>1){[...guides].slice(1).forEach(x=>x.remove());pause('Guided Mode recovered from a duplicate launcher event. Only one guide is active.');}}
function revalidateAfterResume(){if(!root())return;const hiddenFor=Date.now()-lastVisibility;if(hiddenFor>30000){pause('You returned after Guided Mode was in the background. Recheck the current record and controls before continuing.');}schedule();}
function profileWatch(){const sig=profileSig();if(lastProfileSig&&sig&&sig!==lastProfileSig&&root())pause('Your employee permissions changed. Guided Mode paused until the current task is revalidated.');if(sig)lastProfileSig=sig;}
document.addEventListener('click',e=>{guardRapidLauncher(e);const row=e.target.closest?.('[data-id],[data-tx],.tt-wo-row,.tt-rent__row,.tt-inv__row,.tt-quote-card,.arw-row');if(row&&root())setTimeout(schedule,90);},true);
window.addEventListener('popstate',()=>{if(root()){pause('Navigation changed while this workflow was active. Guided Mode paused so the current step can be revalidated.');setTimeout(schedule,80);}});
document.addEventListener('visibilitychange',()=>{if(document.hidden){lastVisibility=Date.now();return;}revalidateAfterResume();});
window.addEventListener('pageshow',e=>{if(e.persisted&&root()){pause('This page was restored from browser history. Guided Mode paused to prevent stale workflow state.');setTimeout(schedule,80);}});
const observer=new MutationObserver(()=>{profileWatch();schedule();});observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class','hidden','aria-selected','data-selected']});
function runAdversarialChecks(){const g=root();const integrity=window.TotalToolsGuidedModeIntegrity?.run?.()||null;const ext=qa('.tt-guide-highlight,.tt-guide-exact-highlight').filter(x=>!g?.contains(x));const s=snapshot();const checks=[
{name:'single-guide',pass:document.querySelectorAll('#'+GUIDE).length<=1},
{name:'single-target',pass:ext.length<=1},
{name:'task-has-workspace-context',pass:!g||!s.title||!!s.workspace},
{name:'profile-consistency',pass:!g||!s.profile||s.profile===profileSig()},
{name:'no-background-stale-state',pass:document.visibilityState==='visible'||!!g},
{name:'integrity-layer',pass:!integrity||integrity.ok!==false}
];return{ok:checks.every(x=>x.pass),checks,state:s,integrity,timestamp:new Date().toISOString()};}
window.TotalToolsGuidedModeAdversarial={run:runAdversarialChecks,revalidate:()=>{schedule();return runAdversarialChecks();},capture,resume};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>{capture();schedule();},{once:true});else{capture();schedule();}
})();