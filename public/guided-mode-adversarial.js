(()=>{'use strict';
const GUIDE='tt-guided-mode';
let baseline=null,lastProfileSig='',lastVisibility=Date.now(),raf=0;
const root=()=>document.getElementById(GUIDE),q=(s,r=document)=>r.querySelector(s),qa=(s,r=document)=>[...r.querySelectorAll(s)];
const norm=s=>String(s||'').trim().replace(/\s+/g,' ');
function task(){const g=root();return{title:norm(q('.tt-guide__head p',g)?.textContent),step:norm(q('.tt-guide__step-count',g)?.textContent),record:norm(q('.tt-guide__record-context strong,.tt-guide__record-note strong',g)?.textContent)};}
function stepNumber(){const m=task().step.match(/step\s+(\d+)/i);return m?Number(m[1]):0;}
function workspace(){const surfaces=[['purchasing','#tt-purchasing-workspace'],['repairs','#tt-work-orders-workspace'],['rentals','#tt-rentals-workspace'],['inventory','#tt-inventory-workspace'],['quotes','#tt-quotes'],['returns','#tt-cashier-controls'],['dispatch','#tt-logistics-intelligence'],['receivables','.arw-overlay.open'],['sales','#tt-sales-workspace']];for(const [name,sel] of surfaces)if(q(sel))return name;return q('.shell-nav [data-domain].is-active')?.dataset.domain||'';}
function profileSig(){const p=window.__TT_WORKSPACE_PROFILE__;if(!p)return'';return JSON.stringify({employee:p.employee?.id||null,domains:[...(p.domains||[])].sort(),role:p.employee?.role||p.employee?.role_name||''});}
function pause(msg){window.TotalToolsGuidedModeIntegrity?.pause?.(msg);}
function snapshot(){return{...task(),workspace:workspace(),profile:profileSig()};}
function capture(){baseline=snapshot();lastProfileSig=baseline.profile||lastProfileSig;}
function meaningfulChange(a,b){if(!a||!b||a.title!==b.title||a.step!==b.step)return false;if(a.profile&&b.profile&&a.profile!==b.profile)return'profile';if(a.workspace&&b.workspace&&a.workspace!==b.workspace)return'workspace';if(a.record&&b.record&&a.record!==b.record)return'record';return false;}
function intendedWorkspaceChange(){return stepNumber()===1||window.__TT_GUIDED_NAVIGATION__===true;}
function validateContinuity(){raf=0;const g=root();if(!g){baseline=null;return;}const now=snapshot();if(!baseline){baseline=now;return;}const change=meaningfulChange(baseline,now);if(change==='profile'){pause('Your signed-in role or permissions changed while this guide was active. Guided Mode paused so the workflow can be revalidated for the current employee.');baseline=now;return;}if(change==='workspace'&&!intendedWorkspaceChange()){pause('The active workspace changed unexpectedly during this guided step. Reopen the required area or choose the task again.');baseline=now;return;}if(change==='workspace'&&intendedWorkspaceChange()){window.TotalToolsGuidedModeIntegrity?.resume?.();}
 // Record selection is commonly the action the current step asks the employee to perform.
 // Treat it as progress, not as an adversarial context switch. Exact-action and completion
 // layers re-evaluate the newly selected record before exposing a write action.
 baseline=now;}
function schedule(){if(!raf)raf=requestAnimationFrame(validateContinuity);}
function guardRapidLauncher(e){if(!e.target.closest?.('#tt-guide-launcher,#tt-guide-access,#tt-guide-quick'))return;const guides=document.querySelectorAll('#'+GUIDE);if(guides.length>1){[...guides].slice(1).forEach(x=>x.remove());pause('Guided Mode recovered from a duplicate launcher event. Only one guide is active.');}}
function revalidateAfterResume(){if(!root())return;if(Date.now()-lastVisibility>30000)pause('You returned after Guided Mode was in the background. Recheck the current record and controls before continuing.');schedule();}
function profileWatch(){const sig=profileSig();if(lastProfileSig&&sig&&sig!==lastProfileSig&&root())pause('Your employee permissions changed. Guided Mode paused until the current task is revalidated.');if(sig)lastProfileSig=sig;}
document.addEventListener('click',e=>{guardRapidLauncher(e);if(e.target.closest?.('[data-id],[data-tx],.tt-wo-row,.tt-rent__row,.tt-inv__row,.tt-quote-card,.arw-row'))setTimeout(schedule,90);},true);
window.addEventListener('popstate',()=>{if(root()){pause('Browser navigation changed while this workflow was active. Guided Mode paused so the current step can be revalidated.');setTimeout(schedule,80);}});
document.addEventListener('visibilitychange',()=>{if(document.hidden){lastVisibility=Date.now();return;}revalidateAfterResume();});
window.addEventListener('pageshow',e=>{if(e.persisted&&root()){pause('This page was restored from browser history. Guided Mode paused to prevent stale workflow state.');setTimeout(schedule,80);}});
const observer=new MutationObserver(()=>{profileWatch();schedule();});observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class','hidden','aria-selected','data-selected']});
function runAdversarialChecks(){const g=root(),integrity=window.TotalToolsGuidedModeIntegrity?.run?.()||null,ext=qa('.tt-guide-highlight,.tt-guide-exact-highlight').filter(x=>!g?.contains(x)),s=snapshot();const checks=[{name:'single-guide',pass:document.querySelectorAll('#'+GUIDE).length<=1},{name:'single-target',pass:ext.filter(x=>x.getClientRects().length).length<=1},{name:'task-has-workspace-context',pass:!g||!s.title||!!s.workspace},{name:'profile-consistency',pass:!g||!s.profile||s.profile===profileSig()},{name:'integrity-layer',pass:!integrity||integrity.ok!==false}];return{ok:checks.every(x=>x.pass),checks,state:s,integrity,timestamp:new Date().toISOString()};}
window.TotalToolsGuidedModeAdversarial={run:runAdversarialChecks,revalidate:()=>{schedule();return runAdversarialChecks();},capture};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>{capture();schedule();},{once:true});else{capture();schedule();}
})();