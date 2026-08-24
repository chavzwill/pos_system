(()=>{'use strict';
const TASK_DOMAIN={
 'Complete a sale':'sales','Hold or recall a sale':'sales','Return or refund a transaction':'sales','Open or close a cash drawer':'sales',
 'Create or work a repair':'service','Review technician compensation':'service','Create or manage a rental':'rentals',
 'Dispatch, route or complete a delivery':'dispatch','Adjust inventory':'inventory','Run a stock or cycle count':'inventory',
 'Create, dispatch or receive a branch transfer':'inventory','Create or approve a purchase request':'purchasing',
 'Create, edit, copy, cancel or receive a PO':'purchasing','Use ERP / inventory intelligence':'purchasing',
 'Create or manage a quotation':'sales','Run, export or print a report':'finance'
};
const DOMAIN_HINTS={sales:'Sales & checkout',service:'Repairs & service',rentals:'Rentals',dispatch:'Dispatch & logistics',inventory:'Inventory & warehouse',purchasing:'Purchasing',finance:'Finance & accounting',crm:'Customers & CRM',administration:'Administration',marketing:'Marketing'};
let raf=0,lastBlocked='';
function profile(){return window.__TT_WORKSPACE_PROFILE__||null;}
function domains(){return new Set(profile()?.domains||[]);}
function guide(){return document.getElementById('tt-guided-mode');}
function activeDomain(){return document.querySelector('.shell-nav [data-domain].is-active')?.dataset.domain||profile()?.primary_workspace||'';}
function allowedTitle(title){const d=TASK_DOMAIN[title];return !d||domains().has(d);}
function toast(text){let t=document.querySelector('.tt-guide-role-toast');if(!t){t=document.createElement('div');t.className='tt-guide-toast tt-guide-role-toast';document.body.appendChild(t);}t.textContent=text;clearTimeout(t._timer);t._timer=setTimeout(()=>t.remove(),4200);}
function currentTask(){const g=guide();if(!g)return'';const step=g.querySelector('.tt-guide__step-count');return step?g.querySelector('.tt-guide__head p')?.textContent?.trim()||'':'';}
function goHome(){guide()?.querySelector('[data-guide-home]')?.click();}
function filterSuggestions(){const g=guide();if(!g||g.querySelector('.tt-guide__step-count'))return;const d=activeDomain(),chips=[...g.querySelectorAll('[data-task]')];if(!chips.length)return;
 for(const chip of chips){const title=chip.textContent.trim(),ok=allowedTitle(title);chip.hidden=!ok;chip.setAttribute('aria-hidden',ok?'false':'true');chip.dataset.guideDomain=TASK_DOMAIN[title]||'';}
 const visible=chips.filter(x=>!x.hidden);visible.sort((a,b)=>Number(b.dataset.guideDomain===d)-Number(a.dataset.guideDomain===d));const host=g.querySelector('.tt-guide__suggestions');visible.forEach(x=>host?.appendChild(x));
 let ctx=g.querySelector('.tt-guide__role-context');if(!ctx){ctx=document.createElement('div');ctx.className='tt-guide__role-context';const body=g.querySelector('.tt-guide__body');body?.insertBefore(ctx,body.querySelector('.tt-guide__suggestions'));}
 const label=DOMAIN_HINTS[d]||DOMAIN_HINTS[profile()?.primary_workspace]||'your permitted workspaces';ctx.innerHTML=`<strong>Relevant help first</strong><span>Showing tasks available to you, prioritizing ${label}. You can still use Guided Mode anytime for any other permitted area.</span>`;
}
function enforceTask(){const title=currentTask();if(!title||allowedTitle(title))return;if(lastBlocked===title)return;lastBlocked=title;goHome();toast(`That workflow is not available for your signed-in role. Guided Mode only shows tasks you are permitted to perform.`);}
function enhance(){raf=0;if(!profile())return;filterSuggestions();enforceTask();}
function schedule(){if(raf)return;raf=requestAnimationFrame(enhance);}
const observer=new MutationObserver(schedule);observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class','hidden','data-guide-context']});
document.addEventListener('click',e=>{if(e.target.closest?.('[data-domain],#tt-guide-launcher,#tt-guide-access,#tt-guide-quick,[data-guide-home],[data-task]'))setTimeout(schedule,20);},true);
window.addEventListener('tt-workspace-profile-ready',schedule);
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',schedule,{once:true});else schedule();
})();