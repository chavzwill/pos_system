(()=>{'use strict';
const TASK_CONTEXT={
 'Complete a sale':{domain:'sales',feature:'sales-workspace',selector:'#tt-sales-workspace'},
 'Hold or recall a sale':{domain:'sales',feature:'sales-workspace',selector:'#tt-sales-workspace'},
 'Return or refund a transaction':{domain:'sales',feature:'cashier-controls-workspace',selector:'#tt-cashier-controls'},
 'Open or close a cash drawer':{domain:'sales'},
 'Create or work a repair':{domain:'service',feature:'work-orders-workspace',selector:'#tt-work-orders-workspace'},
 'Create or manage a rental':{domain:'rentals',feature:'rentals-workspace',selector:'#tt-rentals-workspace'},
 'Dispatch, route or complete a delivery':{domain:'dispatch',feature:'logistics-intelligence',selector:'#tt-logistics-intelligence'},
 'Adjust inventory':{domain:'inventory',feature:'inventory-workspace',selector:'#tt-inventory-workspace'},
 'Run a stock or cycle count':{domain:'inventory'},
 'Create or approve a purchase request':{domain:'purchasing',feature:'purchasing-workspace',selector:'#tt-purchasing-workspace',tab:'pr'},
 'Create, edit, copy, cancel or receive a PO':{domain:'purchasing',feature:'purchasing-workspace',selector:'#tt-purchasing-workspace',tab:'po'},
 'Create, dispatch or receive a branch transfer':{domain:'inventory',feature:'transfers-workspace',selector:'#tt-transfers-workspace'},
 'Create or manage a quotation':{domain:'sales',feature:'quotations-workspace',selector:'#tt-quotes'},
 'Run, export or print a report':{domain:'finance',feature:'operational-reports',selector:'#tt-operational-reports'},
 'Review technician compensation':{domain:'service'},
 'Use ERP / inventory intelligence':{domain:'purchasing',feature:'inventory-intelligence',selector:'#tt-inventory-intelligence'}
};
const API={
 'sales-workspace':'TotalToolsSalesWorkspace','cashier-controls-workspace':'TotalToolsCashierControls','work-orders-workspace':'TotalToolsWorkOrdersWorkspace','rentals-workspace':'TotalToolsRentalsWorkspace','logistics-intelligence':'TotalToolsLogisticsIntelligence','inventory-workspace':'TotalToolsInventoryWorkspace','purchasing-workspace':'TotalToolsPurchasingWorkspace','transfers-workspace':'TotalToolsTransfersWorkspace','quotations-workspace':'TotalToolsQuotationsWorkspace','operational-reports':'TotalToolsOperationalReports','inventory-intelligence':'TotalToolsInventoryIntelligence'
};
let running=false,lastKey='',advancedSetup='';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const visible=el=>!!el&&el.isConnected&&el.getClientRects().length>0&&getComputedStyle(el).visibility!=='hidden'&&getComputedStyle(el).display!=='none';
const guideRoot=()=>document.getElementById('tt-guided-mode');
function title(){return guideRoot()?.querySelector('.tt-guide__head p')?.textContent?.trim()||'';}
function step(){const m=(guideRoot()?.querySelector('.tt-guide__step-count')?.textContent||'').match(/step\s+(\d+)/i);return m?Number(m[1]):0;}
function announce(text){let n=document.getElementById('tt-guide-live');if(!n){n=document.createElement('div');n.id='tt-guide-live';n.setAttribute('role','status');n.setAttribute('aria-live','polite');n.style.cssText='position:fixed;left:-9999px;width:1px;height:1px;overflow:hidden';document.body.appendChild(n);}n.textContent=text;}
function clickDomain(domain){if(!domain)return true;const b=[...document.querySelectorAll('.shell-nav [data-domain]')].find(x=>x.dataset.domain===domain);if(!b)return false;if(!b.classList.contains('is-active'))b.click();return true;}
function ready(ctx){if(!ctx?.feature)return true;const el=document.querySelector(ctx.selector||'');if(!visible(el))return false;const global=API[ctx.feature];return !global||typeof window[global]?.open==='function';}
async function openWorkspace(ctx,taskTitle){if(!ctx?.feature)return true;if(ready(ctx))return true;if(typeof window.TotalToolsShellOpen!=='function')throw new Error('Workspace loader is not ready.');await window.TotalToolsShellOpen(ctx.feature,taskTitle);for(let i=0;i<30;i++){if(ready(ctx))return true;await sleep(80);}throw new Error('The required workspace did not become ready.');}
async function selectPurchasingTab(tab){if(!tab)return true;for(let i=0;i<25;i++){const r=document.getElementById('tt-purchasing-workspace');const b=r?.querySelector(`[data-tab="${tab}"]`);if(b&&visible(b)){if(!b.classList.contains('is-active'))b.click();return true;}await sleep(80);}throw new Error(`Purchasing ${tab==='po'?'Purchase Orders':'Purchase Requests'} tab is unavailable.`);}
function nextButton(){return guideRoot()?.querySelector('[data-guide-next]')||null;}
function setNext(label,disabled=false){const b=nextButton();if(!b)return;b.textContent=label;b.disabled=disabled;if(disabled)b.setAttribute('aria-disabled','true');else b.removeAttribute('aria-disabled');}
function pause(message){window.TotalToolsGuidedModeIntegrity?.pause?.(message);announce(message);setNext('Retry',false);}
function resume(){window.TotalToolsGuidedModeIntegrity?.resume?.();}
function currentTarget(){return [...document.querySelectorAll('.tt-guide-highlight,.tt-guide-exact-highlight')].find(el=>!el.closest('#tt-guided-mode')&&visible(el))||null;}
function positionCoach(){const g=guideRoot()?.querySelector('.tt-guide'),t=currentTarget();if(!g||!t)return;const r=t.getBoundingClientRect(),middle=r.top+r.height/2;g.classList.toggle('tt-guide--top',middle>innerHeight/2);g.classList.toggle('tt-guide--bottom',middle<=innerHeight/2);}
function decorate(){const r=guideRoot();if(!r)return;const s=step(),counter=r.querySelector('.tt-guide__step-count');if(counter&&!r.querySelector('.tt-guide__progress')){const m=counter.textContent.match(/of\s+(\d+)/i),total=m?Number(m[1]):0,p=document.createElement('div');p.className='tt-guide__progress';p.setAttribute('aria-hidden','true');p.innerHTML=`<span style="width:${total?Math.min(100,(s/total)*100):0}%"></span>`;counter.insertAdjacentElement('afterend',p);}const card=r.querySelector('.tt-guide__step');if(card&&!card.querySelector('.tt-guide__coach-note')){const n=document.createElement('div');n.className='tt-guide__coach-note';n.textContent=s===1?'I’m opening and verifying the correct workspace now. You do not need to press anything for this setup step.':'Use the highlighted control in the workspace. Guided Mode stays open while you work.';card.appendChild(n);}positionCoach();}
async function completeSetup(taskTitle,ctx,key){if(advancedSetup===key)return;setNext('Opening…',true);clickDomain(ctx.domain);await sleep(80);await openWorkspace(ctx,taskTitle);if(ctx.feature==='purchasing-workspace'&&ctx.tab)await selectPurchasingTab(ctx.tab);if(!ready(ctx))throw new Error('Workspace verification failed.');resume();advancedSetup=key;announce(`${taskTitle} workspace is ready. Moving to the first real action.`);setNext('Next',false);await sleep(220);const r=guideRoot();if(!r||title()!==taskTitle||step()!==1)return;const b=nextButton();if(b&&!b.disabled)b.click();}
async function orchestrate(){if(running)return;const modal=guideRoot();if(!modal){lastKey='';advancedSetup='';return;}const taskTitle=title(),s=step(),ctx=TASK_CONTEXT[taskTitle];decorate();if(!ctx||!s)return;const key=`${taskTitle}:${s}`;if(key===lastKey&&!(s===1&&!advancedSetup))return;lastKey=key;running=true;try{
 if(s===1&&ctx.feature){await completeSetup(taskTitle,ctx,`${taskTitle}:setup`);return;}
 clickDomain(ctx.domain);if(ctx.feature&&!ready(ctx))await openWorkspace(ctx,taskTitle);if(ctx.feature==='purchasing-workspace'&&ctx.tab)await selectPurchasingTab(ctx.tab);resume();await sleep(60);decorate();
}catch(err){pause(`Guided Mode could not prepare this step. ${err.message}`);}finally{running=false;}}
const observer=new MutationObserver(()=>{if(guideRoot())setTimeout(orchestrate,0);else{lastKey='';advancedSetup='';}});observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class','hidden','data-guide-context']});
document.addEventListener('click',e=>{if(e.target.closest?.('[data-task],[data-guide-next],[data-guide-prev],[data-guide-home],#tt-guide-launcher'))setTimeout(orchestrate,25);if(e.target.closest?.('.tt-guide-highlight,.tt-guide-exact-highlight'))setTimeout(()=>{decorate();positionCoach();},100);},true);
window.addEventListener('resize',()=>guideRoot()&&positionCoach(),{passive:true});
window.TotalToolsGuidedModeOrchestrator={recheck:orchestrate,workspaceReady:(taskTitle)=>ready(TASK_CONTEXT[taskTitle]),contexts:TASK_CONTEXT};
})();