(()=>{'use strict';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let advancing=false,lastSignal='';
function root(){return document.getElementById('tt-guided-mode');}
function task(){return root()?.querySelector('.tt-guide__head p')?.textContent?.trim()||'';}
function step(){const t=root()?.querySelector('.tt-guide__step-count')?.textContent||'';const m=t.match(/step\s+(\d+)/i);return m?Number(m[1]):0;}
function next(){return root()?.querySelector('[data-guide-next]');}
function announce(text){let n=document.getElementById('tt-guide-live');if(!n){n=document.createElement('div');n.id='tt-guide-live';n.setAttribute('role','status');n.setAttribute('aria-live','polite');n.style.cssText='position:fixed;left:-9999px;width:1px;height:1px;overflow:hidden';document.body.appendChild(n);}n.textContent=text;}
function successCue(text='Step complete'){const g=root()?.querySelector('.tt-guide__step');if(!g)return;g.classList.add('is-complete');let b=g.querySelector('.tt-guide__complete');if(!b){b=document.createElement('div');b.className='tt-guide__complete';g.appendChild(b);}b.textContent='✓ '+text;}
async function advance(reason){if(advancing||!root())return;const key=`${task()}:${step()}:${reason}`;if(key===lastSignal)return;lastSignal=key;advancing=true;try{successCue();announce(`Guided Mode confirmed this step is complete. ${reason}`);await sleep(420);const b=next();if(b&&!b.disabled&&root())b.click();}finally{setTimeout(()=>{advancing=false;},120);}}
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
function domCompletion(){if(advancing||!root())return;const t=task(),s=step();
 if(t==='Complete a sale'&&s===2&&document.querySelector('#tt-sales-workspace .tt-sales__line'))advance('Product added to the sale.');
 if(t==='Complete a sale'&&s===3&&document.querySelector('#tt-sales-workspace .tt-sales__customer-selected'))advance('Customer selected.');
 if(t==='Hold or recall a sale'&&s===3&&document.querySelector('#tt-sales-workspace [data-tx],#tt-held-sales-workspace [data-hold]'))successCue('Held transactions are available');
 if(t==='Return or refund a transaction'&&s===2&&document.querySelector('#tt-cashier-controls [data-selected],#tt-sales-workspace [data-tx].is-selected'))successCue('Original transaction selected');
 if(t==='Create, edit, copy, cancel or receive a PO'&&s===2&&document.querySelector('#tt-purchasing-workspace .tt-purch__composer'))successCue('Purchase order form ready');
 if(t==='Create or approve a purchase request'&&s===2&&document.querySelector('#tt-purchasing-workspace .tt-purch__composer'))successCue('Purchase request form ready');
 if(t==='Run, export or print a report'&&s===2){const area=document.querySelector('#tt-operational-reports');if(area&&[...area.querySelectorAll('input,select')].some(hasValue))successCue('Report filters selected');}
 if(t==='Use ERP / inventory intelligence'&&s===2&&document.querySelector('#tt-inventory-intelligence [data-recommendation],#tt-inventory-intelligence .recommendation,#tt-inventory-intelligence article'))successCue('Recommendation evidence is visible');
}
let raf=0;const observer=new MutationObserver(()=>{if(raf)return;raf=requestAnimationFrame(()=>{raf=0;domCompletion();});});observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class','hidden','aria-selected','data-selected']});
document.addEventListener('change',()=>setTimeout(domCompletion,0),true);document.addEventListener('click',()=>setTimeout(domCompletion,80),true);
})();