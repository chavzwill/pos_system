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
const WORKSPACE_IDS={
 'purchasing-workspace':'tt-purchasing-workspace','sales-workspace':'tt-sales-workspace','work-orders-workspace':'tt-work-orders-workspace','rentals-workspace':'tt-rentals-workspace','transfers-workspace':'tt-transfers-workspace','quotations-workspace':'tt-quotations-workspace','operational-reports':'tt-operational-reports','cashier-controls-workspace':'tt-cashier-controls','inventory-workspace':'tt-inventory-workspace','inventory-intelligence':'tt-inventory-intelligence','logistics-intelligence':'tt-logistics-intelligence'
};
let running=false,lastKey='',autoAdvancedKey='';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function visible(el){return !!el&&el.getClientRects().length>0&&getComputedStyle(el).visibility!=='hidden';}
function taskTitle(){return document.querySelector('#tt-guided-mode .tt-guide__head p')?.textContent?.trim()||'';}
function stepNumber(){const t=document.querySelector('#tt-guided-mode .tt-guide__step-count')?.textContent||'';const m=t.match(/step\s+(\d+)/i);return m?Number(m[1]):0;}
function clickDomain(domain){const btn=[...document.querySelectorAll('.shell-nav [data-domain]')].find(x=>x.dataset.domain===domain);if(!btn)return false;if(!btn.classList.contains('is-active'))btn.click();return true;}
function workspaceOpen(key){const id=WORKSPACE_IDS[key];return id?!!document.getElementById(id):false;}
async function openFeature(key){if(!key)return true;if(workspaceOpen(key))return true;for(let i=0;i<16;i++){const btn=document.querySelector(`[data-open="${CSS.escape(key)}"]`);if(btn&&visible(btn)){btn.click();await sleep(160);if(workspaceOpen(key))return true;}await sleep(90);}return workspaceOpen(key);}
async function setPurchasingTab(tab){for(let i=0;i<18;i++){const root=document.getElementById('tt-purchasing-workspace');if(root){const btn=root.querySelector(`[data-tab="${tab}"]`);if(btn){if(!btn.classList.contains('is-active'))btn.click();return true;}}await sleep(80);}return false;}
function announce(text){let n=document.getElementById('tt-guide-live');if(!n){n=document.createElement('div');n.id='tt-guide-live';n.setAttribute('role','status');n.setAttribute('aria-live','polite');n.style.cssText='position:fixed;left:-9999px;width:1px;height:1px;overflow:hidden';document.body.appendChild(n);}n.textContent=text;}
function guideRoot(){return document.getElementById('tt-guided-mode');}
function currentTarget(){return [...document.querySelectorAll('.tt-guide-highlight')].find(el=>!el.closest('#tt-guided-mode')&&visible(el))||null;}
function positionCoach(){const root=guideRoot(),guide=root?.querySelector('.tt-guide'),target=currentTarget();if(!guide||!target)return;const rect=target.getBoundingClientRect();const middle=rect.top+rect.height/2;guide.classList.toggle('tt-guide--top',middle>window.innerHeight/2);guide.classList.toggle('tt-guide--bottom',middle<=window.innerHeight/2);}
function decorate(){const root=guideRoot();if(!root)return;const task=taskTitle(),step=stepNumber();const counter=root.querySelector('.tt-guide__step-count');if(counter&&!root.querySelector('.tt-guide__progress')){const match=counter.textContent.match(/of\s+(\d+)/i);const total=match?Number(match[1]):0;const p=document.createElement('div');p.className='tt-guide__progress';p.setAttribute('aria-hidden','true');p.innerHTML=`<span style="width:${total?Math.min(100,(step/total)*100):0}%"></span>`;counter.insertAdjacentElement('afterend',p);}
 const card=root.querySelector('.tt-guide__step');if(card&&!card.querySelector('.tt-guide__coach-note')){const note=document.createElement('div');note.className='tt-guide__coach-note';note.textContent=step===1?'I’ll take you to the right area automatically.':'Do the highlighted action. Guided Mode stays with you while the screen changes.';card.appendChild(note);}
 if(task){try{localStorage.setItem('tt-guide-last-task',task);}catch(_){}}
 positionCoach();
}
function clickNext(){const next=guideRoot()?.querySelector('[data-guide-next]');if(next&&!next.disabled)next.click();}
async function autoAdvanceSetup(title,step,ctx,key){if(step!==1||autoAdvancedKey===key)return;const ready=(!ctx.feature||workspaceOpen(ctx.feature));if(!ready)return;autoAdvancedKey=key;announce('Workspace ready. Moving to the first action.');await sleep(260);if(taskTitle()===title&&stepNumber()===1)clickNext();}
async function orchestrate(){if(running)return;const modal=guideRoot();if(!modal)return;const title=taskTitle(),step=stepNumber(),ctx=TASK_CONTEXT[title];if(!ctx||!step){decorate();return;}const key=`${title}:${step}`;if(key===lastKey){decorate();positionCoach();return;}lastKey=key;running=true;try{
 clickDomain(ctx.domain);await sleep(70);
 await openFeature(ctx.feature);
 if(ctx.feature==='purchasing-workspace'&&ctx.tab)await setPurchasingTab(ctx.tab);
 if(title==='Create, edit, copy, cancel or receive a PO'&&step===2){const b=document.querySelector('#tt-purchasing-workspace #tt-purch-new-po');if(b&&visible(b)){b.scrollIntoView({block:'center',behavior:'smooth'});b.classList.add('tt-guide-highlight');}}
 if(title==='Create or approve a purchase request'&&step===2){const b=document.querySelector('#tt-purchasing-workspace #tt-purch-new-pr');if(b&&visible(b)){b.scrollIntoView({block:'center',behavior:'smooth'});b.classList.add('tt-guide-highlight');}}
 announce(`Guided Mode prepared ${title}, step ${step}.`);
 modal.dataset.guideContext=`${Date.now()}`;
 await sleep(60);decorate();
 await autoAdvanceSetup(title,step,ctx,key);
}finally{running=false;}}
function resetIfClosed(){if(!guideRoot()){lastKey='';autoAdvancedKey='';}}
const observer=new MutationObserver(()=>{if(guideRoot())setTimeout(orchestrate,0);else resetIfClosed();});
observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class','data-guide-context','hidden']});
document.addEventListener('click',e=>{const guideAction=e.target.closest?.('[data-task],[data-guide-next],[data-guide-prev],[data-guide-home],#tt-guide-launcher');if(guideAction)setTimeout(orchestrate,25);const target=e.target.closest?.('.tt-guide-highlight');if(target&&!target.closest('#tt-guided-mode')){announce('Action selected. Complete any required fields; Guided Mode will remain available for the next step.');setTimeout(()=>{decorate();positionCoach();},120);}},true);
window.addEventListener('resize',()=>{if(guideRoot())positionCoach();},{passive:true});
})();