(()=>{'use strict';
const TASK_CONTEXT={
 'Complete a sale':{domain:'sales',feature:'sales-workspace'},
 'Hold or recall a sale':{domain:'sales',feature:'sales-workspace'},
 'Return or refund a transaction':{domain:'sales',feature:'cashier-controls-workspace'},
 'Open or close a cash drawer':{domain:'sales'},
 'Create or work a repair':{domain:'service',feature:'work-orders-workspace'},
 'Create or manage a rental':{domain:'rentals',feature:'rentals-workspace'},
 'Dispatch, route or complete a delivery':{domain:'dispatch',feature:'logistics-intelligence'},
 'Adjust inventory':{domain:'inventory',feature:'inventory-workspace'},
 'Run a stock or cycle count':{domain:'inventory'},
 'Create or approve a purchase request':{domain:'purchasing',feature:'purchasing-workspace',tab:'pr'},
 'Create, edit, copy, cancel or receive a PO':{domain:'purchasing',feature:'purchasing-workspace',tab:'po'},
 'Create, dispatch or receive a branch transfer':{domain:'inventory',feature:'transfers-workspace'},
 'Create or manage a quotation':{domain:'sales',feature:'quotations-workspace'},
 'Run, export or print a report':{domain:'finance',feature:'operational-reports'},
 'Review technician compensation':{domain:'service'},
 'Use ERP / inventory intelligence':{domain:'purchasing',feature:'inventory-intelligence'}
};
let running=false,lastKey='';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function visible(el){return !!el&&el.getClientRects().length>0&&getComputedStyle(el).visibility!=='hidden';}
function taskTitle(){return document.querySelector('#tt-guided-mode .tt-guide__head p')?.textContent?.trim()||'';}
function stepNumber(){const t=document.querySelector('#tt-guided-mode .tt-guide__step-count')?.textContent||'';const m=t.match(/step\s+(\d+)/i);return m?Number(m[1]):0;}
function clickDomain(domain){const btn=[...document.querySelectorAll('.shell-nav [data-domain]')].find(x=>x.dataset.domain===domain);if(btn&&!btn.classList.contains('is-active'))btn.click();return !!btn;}
async function openFeature(key){if(!key)return true;if(workspaceOpen(key))return true;for(let i=0;i<12;i++){const btn=document.querySelector(`[data-open="${CSS.escape(key)}"]`);if(btn&&visible(btn)){btn.click();await sleep(180);if(workspaceOpen(key))return true;}await sleep(100);}return workspaceOpen(key);}
function workspaceOpen(key){const ids={
 'purchasing-workspace':'tt-purchasing-workspace','sales-workspace':'tt-sales-workspace','work-orders-workspace':'tt-work-orders-workspace','rentals-workspace':'tt-rentals-workspace','transfers-workspace':'tt-transfers-workspace','quotations-workspace':'tt-quotations-workspace','operational-reports':'tt-operational-reports','cashier-controls-workspace':'tt-cashier-controls','inventory-workspace':'tt-inventory-workspace','inventory-intelligence':'tt-inventory-intelligence','logistics-intelligence':'tt-logistics-intelligence'};
 const id=ids[key];return id?!!document.getElementById(id):false;
}
async function setPurchasingTab(tab){for(let i=0;i<15;i++){const root=document.getElementById('tt-purchasing-workspace');if(root){const btn=root.querySelector(`[data-tab="${tab}"]`);if(btn){if(!btn.classList.contains('is-active'))btn.click();return true;}}await sleep(100);}return false;}
function announce(text){let n=document.getElementById('tt-guide-live');if(!n){n=document.createElement('div');n.id='tt-guide-live';n.setAttribute('role','status');n.setAttribute('aria-live','polite');n.style.cssText='position:fixed;left:-9999px;width:1px;height:1px;overflow:hidden';document.body.appendChild(n);}n.textContent=text;}
async function orchestrate(){if(running)return;const modal=document.getElementById('tt-guided-mode');if(!modal)return;const title=taskTitle(),step=stepNumber(),ctx=TASK_CONTEXT[title];if(!ctx||!step)return;const key=`${title}:${step}`;if(key===lastKey)return;lastKey=key;running=true;try{
 clickDomain(ctx.domain);await sleep(80);
 await openFeature(ctx.feature);
 if(ctx.feature==='purchasing-workspace'&&ctx.tab)await setPurchasingTab(ctx.tab);
 // Step-specific actions make the guide move the user to the right control rather than merely describing it.
 if(title==='Create, edit, copy, cancel or receive a PO'&&step===2){const b=document.querySelector('#tt-purchasing-workspace #tt-purch-new-po');if(b&&visible(b)){b.scrollIntoView({block:'center',behavior:'smooth'});b.classList.add('tt-guide-highlight');}}
 if(title==='Create or approve a purchase request'&&step===2){const b=document.querySelector('#tt-purchasing-workspace #tt-purch-new-pr');if(b&&visible(b)){b.scrollIntoView({block:'center',behavior:'smooth'});b.classList.add('tt-guide-highlight');}}
 announce(`Guided Mode opened ${ctx.domain} and prepared step ${step}.`);
 // Trigger a harmless DOM mutation so the original guide re-runs its target finder against the newly opened workspace.
 modal.dataset.guideContext=`${Date.now()}`;
}finally{running=false;}}
const observer=new MutationObserver(()=>{if(document.getElementById('tt-guided-mode'))setTimeout(orchestrate,0);else lastKey='';});
observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class','data-guide-context']});
document.addEventListener('click',e=>{if(e.target.closest?.('[data-task],[data-guide-next],[data-guide-prev],[data-guide-home],#tt-guide-launcher'))setTimeout(orchestrate,30);},true);
})();