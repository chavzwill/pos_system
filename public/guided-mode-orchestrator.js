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
let running=false,lastKey='';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const visible=el=>!!el&&el.isConnected&&el.getClientRects().length>0&&getComputedStyle(el).visibility!=='hidden'&&getComputedStyle(el).display!=='none';
const guideRoot=()=>document.getElementById('tt-guided-mode');
function taskTitle(){return guideRoot()?.querySelector('.tt-guide__head p')?.textContent?.trim()||'';}
function stepNumber(){const m=(guideRoot()?.querySelector('.tt-guide__step-count')?.textContent||'').match(/step\s+(\d+)/i);return m?Number(m[1]):0;}
function clickDomain(domain){const btn=[...document.querySelectorAll('.shell-nav [data-domain]')].find(x=>x.dataset.domain===domain);if(!btn)return false;if(!btn.classList.contains('is-active'))btn.click();return true;}
function workspaceReady(ctx){if(!ctx?.feature)return true;const el=document.querySelector(ctx.selector||'');if(!visible(el))return false;const apiReady={
 'sales-workspace':'TotalToolsSalesWorkspace','cashier-controls-workspace':'TotalToolsCashierControls','work-orders-workspace':'TotalToolsWorkOrdersWorkspace','rentals-workspace':'TotalToolsRentalsWorkspace','logistics-intelligence':'TotalToolsLogisticsIntelligence','inventory-workspace':'TotalToolsInventoryWorkspace','purchasing-workspace':'TotalToolsPurchasingWorkspace','transfers-workspace':'TotalToolsTransfersWorkspace','quotations-workspace':'TotalToolsQuotationsWorkspace','operational-reports':'TotalToolsOperationalReports','inventory-intelligence':'TotalToolsInventoryIntelligence'
 }[ctx.feature];return !apiReady||typeof window[apiReady]?.open==='function';}
async function openFeature(ctx,title){if(!ctx?.feature)return true;if(workspaceReady(ctx))return true;if(typeof window.TotalToolsShellOpen!=='function')throw new Error('Workspace loader is not ready. Refresh the application and try again.');await window.TotalToolsShellOpen(ctx.feature,title);for(let i=0;i<25;i++){if(workspaceReady(ctx))return true;await sleep(80);}throw new Error('The workspace did not become ready after loading.');}
async function setPurchasingTab(tab){if(!tab)return true;for(let i=0;i<20;i++){const root=document.getElementById('tt-purchasing-workspace');const btn=root?.querySelector(`[data-tab="${tab}"]`);if(btn&&visible(btn)){if(!btn.classList.contains('is-active'))btn.click();return true;}await sleep(80);}return false;}
function announce(text){let n=document.getElementById('tt-guide-live');if(!n){n=document.createElement('div');n.id='tt-guide-live';n.setAttribute('role','status');n.setAttribute('aria-live','polite');n.style.cssText='position:fixed;left:-9999px;width:1px;height:1px;overflow:hidden';document.body.appendChild(n);}n.textContent=text;}
function currentTarget(){return [...document.querySelectorAll('.tt-guide-highlight,.tt-guide-exact-highlight')].find(el=>!el.closest('#tt-guided-mode')&&visible(el))||null;}
function positionCoach(){const guide=guideRoot()?.querySelector('.tt-guide'),target=currentTarget();if(!guide||!target)return;const r=target.getBoundingClientRect(),middle=r.top+r.height/2;guide.classList.toggle('tt-guide--top',middle>innerHeight/2);guide.classList.toggle('tt-guide--bottom',middle<=innerHeight/2);}
function decorate(){const root=guideRoot();if(!root)return;const step=stepNumber(),counter=root.querySelector('.tt-guide__step-count');if(counter&&!root.querySelector('.tt-guide__progress')){const m=counter.textContent.match(/of\s+(\d+)/i),total=m?Number(m[1]):0,p=document.createElement('div');p.className='tt-guide__progress';p.setAttribute('aria-hidden','true');p.innerHTML=`<span style="width:${total?Math.min(100,(step/total)*100):0}%"></span>`;counter.insertAdjacentElement('afterend',p);}const card=root.querySelector('.tt-guide__step');if(card&&!card.querySelector('.tt-guide__coach-note')){const note=document.createElement('div');note.className='tt-guide__coach-note';note.textContent=step===1?'I’ll open the required workspace and verify it is ready before you continue.':'Do the highlighted action. Guided Mode will only advance when the step is actually complete.';card.appendChild(note);}positionCoach();}
function pause(message){window.TotalToolsGuidedModeIntegrity?.pause?.(message);announce(message);}
async function orchestrate(){if(running)return;const modal=guideRoot();if(!modal)return;const title=taskTitle(),step=stepNumber(),ctx=TASK_CONTEXT[title];decorate();if(!ctx||!step)return;const key=`${title}:${step}`;if(key===lastKey&&!(step===1&&!workspaceReady(ctx)))return;lastKey=key;running=true;try{clickDomain(ctx.domain);await sleep(50);if(step===1&&ctx.feature){const next=modal.querySelector('[data-guide-next]');if(next){next.disabled=true;next.setAttribute('aria-disabled','true');next.textContent='Opening…';}try{await openFeature(ctx,title);if(ctx.feature==='purchasing-workspace'&&ctx.tab)await setPurchasingTab(ctx.tab);if(next){next.disabled=false;next.removeAttribute('aria-disabled');next.textContent='Next';}window.TotalToolsGuidedModeIntegrity?.resume?.();announce(`${title} workspace is ready. Continue when you are ready.`);}catch(err){if(next){next.disabled=false;next.removeAttribute('aria-disabled');next.textContent='Retry';}pause(`Guided Mode could not open the required workspace. ${err.message}`);return;}}
 if(ctx.feature==='purchasing-workspace'&&ctx.tab)await setPurchasingTab(ctx.tab);
 await sleep(50);decorate();
}finally{running=false;}}
const observer=new MutationObserver(()=>{if(guideRoot())setTimeout(orchestrate,0);else{lastKey='';}});observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class','hidden','data-guide-context']});
document.addEventListener('click',e=>{if(e.target.closest?.('[data-task],[data-guide-next],[data-guide-prev],[data-guide-home],#tt-guide-launcher'))setTimeout(orchestrate,25);if(e.target.closest?.('.tt-guide-highlight,.tt-guide-exact-highlight'))setTimeout(()=>{decorate();positionCoach();},100);},true);
window.addEventListener('resize',()=>guideRoot()&&positionCoach(),{passive:true});
window.TotalToolsGuidedModeOrchestrator={recheck:orchestrate,workspaceReady:(title)=>workspaceReady(TASK_CONTEXT[title]),contexts:TASK_CONTEXT};
})();