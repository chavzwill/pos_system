(()=>{'use strict';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let advancing=false,lastSignal='',flowTarget=null;
function root(){return document.getElementById('tt-guided-mode');}
function task(){return root()?.querySelector('.tt-guide__head p')?.textContent?.trim()||'';}
function step(){const t=root()?.querySelector('.tt-guide__step-count')?.textContent||'';const m=t.match(/step\s+(\d+)/i);return m?Number(m[1]):0;}
function next(){return root()?.querySelector('[data-guide-next]');}
function visible(el){return !!el&&el.isConnected&&el.getClientRects().length>0&&getComputedStyle(el).visibility!=='hidden'&&getComputedStyle(el).display!=='none';}
function announce(text){let n=document.getElementById('tt-guide-live');if(!n){n=document.createElement('div');n.id='tt-guide-live';n.setAttribute('role','status');n.setAttribute('aria-live','polite');n.style.cssText='position:fixed;left:-9999px;width:1px;height:1px;overflow:hidden';document.body.appendChild(n);}n.textContent=text;}
function successCue(text='Step complete'){const g=root()?.querySelector('.tt-guide__step');if(!g)return;g.classList.add('is-complete');let b=g.querySelector('.tt-guide__complete');if(!b){b=document.createElement('div');b.className='tt-guide__complete';g.appendChild(b);}b.textContent='✓ '+text;}
function clearFlowTarget(){if(flowTarget){flowTarget.classList.remove('tt-guide-exact-highlight');flowTarget.removeAttribute('data-guide-hardened-target');flowTarget=null;}}
function guideTarget(el,title,text){if(!root()||!visible(el))return false;clearFlowTarget();document.querySelectorAll('.tt-guide-highlight').forEach(x=>x.classList.remove('tt-guide-highlight'));flowTarget=el;el.classList.add('tt-guide-exact-highlight');el.setAttribute('data-guide-hardened-target','true');const card=root().querySelector('.tt-guide__step');if(card){const h=card.querySelector('h3');const p=card.querySelector('p');const hint=card.querySelector('.tt-guide__hint');if(h)h.textContent=title;if(p)p.textContent=text;if(hint)hint.textContent='Complete this action in the workspace. Guided Mode will follow your progress automatically.';}el.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'center',inline:'nearest'});window.TotalToolsGuidedModeOrchestrator?.recheck?.();return true;}
async function advance(reason){if(advancing||!root())return;const key=`${task()}:${step()}:${reason}`;if(key===lastSignal)return;lastSignal=key;advancing=true;clearFlowTarget();try{successCue();announce(`Guided Mode confirmed this step is complete. ${reason}`);await sleep(320);const b=next();if(b&&!b.disabled&&root())b.click();}finally{setTimeout(()=>{advancing=false;},120);}}
function urlOf(input){return typeof input==='string'?input:(input&&input.url)||'';}
function methodOf(init,input){return String(init?.method||(input&&input.method)||'GET').toUpperCase();}
function writeMethod(method){return['POST','PATCH','PUT','DELETE'].includes(method);}
function networkRule(url,method,status){if(status<200||status>=300)return'';const t=task(),s=step();if(!t||!s)return'';
 if(t==='Complete a sale'&&s===4&&method==='POST'&&/\/api\/transactions(?:\?|$)/.test(url))return'Sale completed successfully.';
 if(t==='Hold or recall a sale'&&s===2&&method==='POST'&&/\/api\/transactions(?:\?|$)/.test(url))return'Sale was held successfully.';
 if(t==='Return or refund a transaction'&&s===3&&writeMethod(method)&&/\/api\/.*(?:returns?|refunds?|transactions\/.*(?:return|refund))/.test(url))return'Return or refund was recorded.';
 if(t==='Open or close a cash drawer'&&s>=2&&writeMethod(method)&&/\/api\/.*(?:cash-drawer|drawer|reconciliation|cash-count)/.test(url))return'Cash drawer action was saved.';
 if(t==='Create or approve a purchase request'&&s===2&&method==='POST'&&/\/api\/purchase-requests(?:\?|$)/.test(url))return'Purchase request created.';
 if(t==='Create or approve a purchase request'&&s===3&&/\/api\/purchase-requests\//.test(url)&&writeMethod(method))return'Purchase request decision saved.';
 if(t==='Create or approve a purchase request'&&s===4&&/\/api\/purchase-(?:requests|orders)\//.test(url)&&writeMethod(method))return'Purchase order conversion completed.';
 if(t==='Create, edit, copy, cancel or receive a PO'&&s===2&&method==='POST'&&/\/api\/purchase-orders(?:\?|$)/.test(url))return'Purchase order created.';
 if(t==='Create, edit, copy, cancel or receive a PO'&&s===3&&/\/api\/purchase-orders\//.test(url)&&writeMethod(method))return'Purchase order change saved.';
 if(t==='Create, edit, copy, cancel or receive a PO'&&s===4&&/\/api\/purchase-orders\//.test(url)&&/receive/i.test(url)&&writeMethod(method))return'Receiving was recorded.';
 if(t==='Create, dispatch or receive a branch transfer'&&s===2&&method==='POST'&&/\/api\/.*transfers/.test(url))return'Transfer created.';
 if(t==='Create, dispatch or receive a branch transfer'&&s===3&&/\/api\/.*transfers\//.test(url)&&/dispatch/i.test(url)&&writeMethod(method))return'Transfer dispatched.';
 if(t==='Create, dispatch or receive a branch transfer'&&s===4&&/\/api\/.*transfers\//.test(url)&&/receive/i.test(url)&&writeMethod(method))return'Transfer received.';
 if(t==='Adjust inventory'&&s>=2&&/\/api\/.*(?:inventory|stock|products)/.test(url)&&writeMethod(method))return'Inventory change saved.';
 if(t==='Run a stock or cycle count'&&s>=2&&/\/api\/.*(?:cycle-count|stock-count|inventory-count|counts)/.test(url)&&writeMethod(method))return'Count workflow updated.';
 if(t==='Create or manage a quotation'&&s===2&&method==='POST'&&/\/api\/.*quot/.test(url))return'Quotation created.';
 if(t==='Create or manage a quotation'&&s===3&&/\/api\/.*quot/.test(url)&&writeMethod(method))return'Quotation status was updated.';
 if(t==='Create or manage a rental'&&s>=2&&/\/api\/.*rental/.test(url)&&writeMethod(method))return'Rental workflow updated.';
 if(t==='Create or work a repair'&&s>=2&&/\/api\/.*(?:repair|work-orders)/.test(url)&&writeMethod(method))return'Repair workflow updated.';
 if(t==='Dispatch, route or complete a delivery'&&s>=3&&/\/api\/.*(?:dispatch|logistics)/.test(url)&&writeMethod(method))return'Dispatch workflow updated.';
 if(t==='Run, export or print a report'&&s===3&&method==='GET'&&/\/api\/.*(?:reports?|analytics)/.test(url))return'Report refreshed with the selected filters.';
 if(t==='Run, export or print a report'&&s===4&&method==='GET'&&/\/api\/.*(?:export|csv|xlsx|pdf|reports?)/.test(url)&&/(?:export|format=|csv|xlsx|pdf)/i.test(url))return'Report export started.';
 if(t==='Use ERP / inventory intelligence'&&s===3&&writeMethod(method)&&/\/api\/.*(?:transfers?|purchase-requests?|replenish|recommendations?)/.test(url))return'Controlled action was created from the intelligence recommendation.';
 return'';}
const nativeFetch=window.fetch.bind(window);window.fetch=async function(input,init){const response=await nativeFetch(input,init);try{const reason=networkRule(urlOf(input),methodOf(init,input),response.status);if(reason)setTimeout(()=>advance(reason),80);}catch(_){}return response;};
function hasValue(el){return !!el&&String(el.value||'').trim().length>0;}
function purchasingComposerFlow(type){const t=task(),s=step();if(s!==2)return false;const isPO=type==='po';if((isPO&&t!=='Create, edit, copy, cancel or receive a PO')||(!isPO&&t!=='Create or approve a purchase request'))return false;const workspace=document.getElementById('tt-purchasing-workspace');if(!workspace)return false;const composer=workspace.querySelector('.tt-purch__composer');if(!composer){const launch=workspace.querySelector(isPO?'#tt-purch-new-po':'#tt-purch-new-pr');return guideTarget(launch,isPO?'Start the purchase order':'Start the purchase request',`Tap ${isPO?'New Purchase Order':'New Purchase Request'} to begin. Guided Mode will stay with you inside the form.`);}
 const form=composer.querySelector('#tt-purch-compose-form');if(!form)return false;
 if(isPO){const supplier=form.querySelector('select[name="supplier_id"]');if(supplier&&!hasValue(supplier))return guideTarget(supplier,'Choose the supplier','Select the supplier this purchase order is being placed with.');}
 const item=form.querySelector('[data-line="0"] [data-line-field="product_name"]');if(item&&!hasValue(item))return guideTarget(item,'Add the first line item','Search the catalog by item name or SKU, or enter the sourced item.');
 const qty=form.querySelector('[data-line="0"] [data-line-field="quantity"]');if(qty&&Number(qty.value)<=0)return guideTarget(qty,'Enter the quantity','Enter the quantity you actually intend to order.');
 const submit=form.querySelector('button[type="submit"]');if(submit)return guideTarget(submit,isPO?'Create the purchase order':'Create the purchase request',isPO?'Review supplier, delivery date, line quantities and cost, then create the PO.':'Review the request details and submit the purchase request.');
 return false;}
function poManageFlow(){if(task()!=='Create, edit, copy, cancel or receive a PO')return false;const s=step(),ws=document.getElementById('tt-purchasing-workspace');if(!ws)return false;if(s===3){const action=ws.querySelector('[data-action="send"],[data-action="approve-po"],[data-action="cancel-po"]');if(action)return guideTarget(action,'Choose the next PO action','Use the appropriate controlled action for this purchase order. Guided Mode will progress when the saved change succeeds.');}
 if(s===4){const qty=ws.querySelector('[data-receive]');if(qty&&Number(qty.value)<=0)return guideTarget(qty,'Enter received quantity','Enter only the quantity physically received for this line.');const receive=ws.querySelector('[data-action="receive"]');if(receive)return guideTarget(receive,'Record the receipt','Confirm the entered quantities and record the goods actually received.');}
 return false;}
function domCompletion(){if(advancing||!root())return;const t=task(),s=step();
 if(purchasingComposerFlow('po')||purchasingComposerFlow('pr')||poManageFlow())return;
 clearFlowTarget();
 if(t==='Complete a sale'&&s===2&&document.querySelector('#tt-sales-workspace .tt-sales__line'))advance('Product added to the sale.');
 if(t==='Complete a sale'&&s===3&&document.querySelector('#tt-sales-workspace .tt-sales__customer-selected'))advance('Customer selected.');
 if(t==='Hold or recall a sale'&&s===3&&document.querySelector('#tt-sales-workspace [data-tx],#tt-held-sales-workspace [data-hold]'))successCue('Held transactions are available');
 if(t==='Return or refund a transaction'&&s===2&&document.querySelector('#tt-cashier-controls [data-selected],#tt-sales-workspace [data-tx].is-selected'))successCue('Original transaction selected');
 if(t==='Run, export or print a report'&&s===2){const area=document.querySelector('#tt-operational-reports');if(area&&[...area.querySelectorAll('input,select')].some(hasValue))successCue('Report filters selected');}
 if(t==='Use ERP / inventory intelligence'&&s===2&&document.querySelector('#tt-inventory-intelligence [data-recommendation],#tt-inventory-intelligence .recommendation,#tt-inventory-intelligence article'))successCue('Recommendation evidence is visible');
}
let raf=0;const observer=new MutationObserver(()=>{if(raf)return;raf=requestAnimationFrame(()=>{raf=0;domCompletion();});});observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class','hidden','aria-selected','data-selected','value']});
document.addEventListener('input',()=>setTimeout(domCompletion,0),true);document.addEventListener('change',()=>setTimeout(domCompletion,0),true);document.addEventListener('click',()=>setTimeout(domCompletion,100),true);
window.TotalToolsGuidedModeCompletion={recheck:domCompletion,advance};
})();