(()=>{'use strict';
let raf=0,last=null;
const norm=s=>String(s||'').toLowerCase().replace(/\s+/g,' ').trim();
const guide=()=>document.getElementById('tt-guided-mode');
const visible=el=>{if(!el||!(el instanceof Element)||!el.isConnected||!el.getClientRects().length)return false;const s=getComputedStyle(el);return s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity||1)!==0&&!el.disabled;};
const task=()=>guide()?.querySelector('.tt-guide__head p')?.textContent?.trim()||'';
const step=()=>{const m=(guide()?.querySelector('.tt-guide__step-count')?.textContent||'').match(/step\s+(\d+)/i);return m?Number(m[1]):0;};
const map={
 'Complete a sale':{1:['point of sale','pos','sales'],2:['search products','product search','scan','barcode'],3:['select customer','customer'],4:['checkout','pay','complete sale','payment']},
 'Hold or recall a sale':{1:['point of sale','pos'],2:['hold','suspend'],3:['recall','held sales','open holds']},
 'Return or refund a transaction':{1:['transactions','sales history','returns'],2:['search','transaction'],3:['return','refund','process return']},
 'Open or close a cash drawer':{1:['cash drawer','cash management','drawer'],2:['open drawer','start drawer','opening balance'],3:['close drawer','reconcile','count denominations']},
 'Create or work a repair':{1:['repairs','work orders','service'],2:['new work order','create work order','new repair'],3:['assign technician','technician','save update']},
 'Create or manage a rental':{1:['rentals','rental'],2:['new rental','create rental','rental agreement'],3:['issue','activate','checkout rental'],4:['return rental','check in','return']},
 'Dispatch, route or complete a delivery':{1:['dispatch','logistics'],2:['dispatch queue','jobs','unassigned'],3:['schedule','assignee','vehicle'],4:['in transit','completed','complete']},
 'Adjust inventory':{1:['inventory','products'],2:['adjust','stock adjustment','inventory adjustment'],3:['reason','adjustment reason','apply adjustment']},
 'Run a stock or cycle count':{1:['warehouse','inventory','cycle count'],2:['new count','start count','cycle count'],3:['commit','finalize','complete count']},
 'Create or approve a purchase request':{1:['purchase requests','purchasing'],2:['new purchase request','create request'],3:['approve','reject'],4:['convert to po','create po']},
 'Create, edit, copy, cancel or receive a PO':{1:['purchase orders','purchasing'],2:['new purchase order','create po'],3:['edit','revise','copy','duplicate','cancel','approve po','mark sent'],4:['receive','receive items','goods received']},
 'Create, dispatch or receive a branch transfer':{1:['transfers','branch transfers'],2:['new transfer','create transfer'],3:['dispatch','in transit'],4:['receive','receive transfer']},
 'Create or manage a quotation':{1:['quotations','quotes'],2:['new quotation','create quote'],3:['send','approve','accept']},
 'Run, export or print a report':{1:['reports','reporting'],2:['date','branch','filter'],3:['run report','apply','refresh'],4:['export','csv','excel','print','pdf']},
 'Review technician compensation':{1:['technician','repairs','work orders'],2:['compensation','pay period','performance'],3:['rate','plan','metrics'],4:['finalize','approve payroll','payroll']},
 'Use ERP / inventory intelligence':{1:['erp','intelligence','analytics'],2:['recommend','transfer','replenish','supplier'],3:['create transfer','purchase request','apply']}
};
function candidates(){return [...document.querySelectorAll('button,a,[role="button"],[role="tab"],input,select,textarea,label')].filter(el=>visible(el)&&!el.closest('#tt-guided-mode'));}
function labelFor(el){return norm(el.getAttribute('aria-label')||el.getAttribute('placeholder')||el.name||el.id||el.textContent||'');}
function find(){if(document.querySelector('[data-guide-hardened-target="true"]'))return null;const terms=map[task()]?.[step()]||[];if(!terms.length)return null;const xs=candidates();for(const term of terms){const n=norm(term);let hit=xs.find(el=>labelFor(el)===n);if(hit)return{el,term};hit=xs.find(el=>labelFor(el).startsWith(n));if(hit)return{el:hit,term};hit=xs.find(el=>labelFor(el).includes(n));if(hit)return{el:hit,term};}return null;}
function clear(){if(last){last.classList.remove('tt-guide-fallback-highlight');last.removeAttribute('data-guide-fallback-target');last=null;}}
function dock(el){const card=guide()?.querySelector('.tt-guide');if(!card||!visible(el))return;const r=el.getBoundingClientRect();card.classList.remove('tt-guide--top','tt-guide--bottom');card.classList.add((r.top+r.height/2)<innerHeight/2?'tt-guide--bottom':'tt-guide--top');}
function run(){raf=0;if(!guide()){clear();return;}if(document.querySelector('[data-guide-hardened-target="true"]')){clear();return;}const hit=find();if(!hit){clear();return;}if(last!==hit.el){clear();last=hit.el;last.classList.add('tt-guide-fallback-highlight');last.setAttribute('data-guide-fallback-target','true');}dock(hit.el);const r=hit.el.getBoundingClientRect();if(r.top<64||r.bottom>innerHeight-64)hit.el.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'center',inline:'nearest'});}
function schedule(){if(raf)return;raf=requestAnimationFrame(run);}
new MutationObserver(schedule).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class','hidden','aria-selected','disabled']});
['click','input','change','focusin'].forEach(x=>document.addEventListener(x,()=>setTimeout(schedule,30),true));
window.addEventListener('resize',schedule,{passive:true});window.addEventListener('scroll',schedule,{passive:true});setInterval(schedule,500);
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',schedule,{once:true});else schedule();
})();