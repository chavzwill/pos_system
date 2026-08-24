(() => {
  'use strict';

  const GUIDE_CLASS = 'tt-guide-highlight';
  const TASKS = [
    { id:'sale', title:'Complete a sale', keywords:['sale','checkout','cashier','ring up','sell','payment'], steps:[
      { find:['point of sale','pos','sales'], text:'Open the Point of Sale workspace.' },
      { find:['search products','scan','barcode','product search'], text:'Search for or scan the customer’s product.' },
      { find:['customer','select customer'], text:'Select the customer when needed, or continue with the permitted walk-in flow.' },
      { find:['checkout','pay','complete sale','payment'], text:'Review quantities, prices, tax and discounts, then open checkout. Confirm tender before completing the transaction.' }
    ]},
    { id:'hold', title:'Hold or recall a sale', keywords:['hold','recall','park sale','suspend sale'], steps:[
      { find:['point of sale','pos'], text:'Open Point of Sale.' },
      { find:['hold','suspend'], text:'Use Hold after confirming the cart is correct. A hold should not be treated as payment.' },
      { find:['recall','held','open holds'], text:'To continue later, open the held-sales list and recall the correct transaction.' }
    ]},
    { id:'return', title:'Return or refund a transaction', keywords:['return','refund','reverse sale','money back'], steps:[
      { find:['transactions','sales history','returns'], text:'Open transaction history or the Returns workspace.' },
      { find:['search','transaction'], text:'Locate the original transaction. Never create a return against the wrong receipt.' },
      { find:['return','refund'], text:'Choose Return/Refund, select the correct items and quantities, record the reason, and follow any supervisor authorization shown by the POS.' }
    ]},
    { id:'drawer', title:'Open or close a cash drawer', keywords:['drawer','cash drawer','till','open drawer','close drawer','reconcile'], steps:[
      { find:['drawer','cash management'], text:'Open Cash Drawer / Cash Management.' },
      { find:['open drawer','start drawer','opening balance'], text:'At shift start, open the drawer and record the verified opening cash.' },
      { find:['close drawer','reconcile','count denominations'], text:'At shift end, count actual cash, reconcile the drawer and record any variance before closing.' }
    ]},
    { id:'repair', title:'Create or work a repair', keywords:['repair','work order','service','technician','machine repair'], steps:[
      { find:['repairs','work orders','service'], text:'Open Repairs / Work Orders.' },
      { find:['new work order','create work order','new repair'], text:'Create the work order and capture the customer, equipment, reported issue and intake condition.' },
      { find:['assign technician','technician'], text:'Assign the appropriate technician and follow diagnosis, parts/labor authorization, repair, QC and collection states.' }
    ]},
    { id:'rental', title:'Create or manage a rental', keywords:['rental','rent','hire equipment','rental agreement'], steps:[
      { find:['rentals','rental'], text:'Open Rentals.' },
      { find:['new rental','create rental','rental agreement'], text:'Create the rental using the correct customer, branch, item and date range.' },
      { find:['issue','activate','checkout rental'], text:'Verify availability, deposits/eligibility and condition before issuing the rental.' },
      { find:['return rental','check in','return'], text:'At return, record condition, damage/fees where applicable, and complete the rental lifecycle.' }
    ]},
    { id:'dispatch', title:'Dispatch, route or complete a delivery', keywords:['dispatch','route','routing','delivery','driver','logistics','vehicle','in transit','pickup'], steps:[
      { find:['dispatch & logistics intelligence','dispatch','logistics'], text:'Open Dispatch & Logistics Intelligence.' },
      { find:['unassigned','dispatch queue','jobs'], text:'Review the dispatch queue, priority, promised time, assignment state and operational risk before choosing work.' },
      { find:['schedule','assignee','vehicle'], text:'Assign the authorized employee and vehicle, then schedule the movement using verified capacity and timing.' },
      { find:['ready','in transit','delayed','completed'], text:'Move the dispatch through its real lifecycle. Record delays rather than hiding them, and mark completed only after the movement is actually finished.' }
    ]},
    { id:'inventory-adjust', title:'Adjust inventory', keywords:['adjust inventory','stock adjustment','damage stock','write off','inventory correction'], steps:[
      { find:['inventory','products'], text:'Open Inventory.' },
      { find:['adjust','stock adjustment','inventory adjustment'], text:'Choose the controlled stock-adjustment action for the exact item and branch.' },
      { find:['reason','adjustment reason'], text:'Enter the verified quantity change and a real reason. Do not disguise sales, transfers or cycle-count variance as manual adjustments.' }
    ]},
    { id:'count', title:'Run a stock or cycle count', keywords:['cycle count','stock count','physical count','inventory count'], steps:[
      { find:['warehouse','inventory','cycle count'], text:'Open Warehouse / Inventory Counts.' },
      { find:['new count','start count','cycle count'], text:'Start a count for the correct branch/location and scope.' },
      { find:['commit','finalize','complete count'], text:'Enter physical quantities, review variances and commit through the count workflow so the variance remains auditable.' }
    ]},
    { id:'pr', title:'Create or approve a purchase request', keywords:['purchase request','pr','request purchase','replenish'], steps:[
      { find:['purchase requests','purchasing'], text:'Open Purchase Requests.' },
      { find:['new purchase request','create request'], text:'Create the request with the correct branch, products, quantities and business reason.' },
      { find:['approve','reject'], text:'Authorized approvers should review demand and sourcing evidence before approving or rejecting.' },
      { find:['convert to po','create po'], text:'When approved, convert through the controlled PO flow rather than creating unrelated duplicate purchasing records.' }
    ]},
    { id:'po', title:'Create, edit, copy, cancel or receive a PO', keywords:['purchase order','po','receive po','copy po','cancel po','edit po'], steps:[
      { find:['purchase orders','purchasing'], text:'Open Purchase Orders.' },
      { find:['new purchase order','create po'], text:'Create or open the correct PO. Verify supplier, branch, terms and line quantities.' },
      { find:['edit','revise','copy','duplicate','cancel'], text:'Use the explicit revise, copy/reuse or cancel action. A copied PO should become a new PO rather than overwrite the original audit trail.' },
      { find:['receive','receive items','goods received'], text:'When receiving, record only quantities physically received. Never over-receive a line or mark missing goods as received.' }
    ]},
    { id:'transfer', title:'Create, dispatch or receive a branch transfer', keywords:['transfer','branch transfer','move stock','dispatch transfer','receive transfer'], steps:[
      { find:['transfers','branch transfers'], text:'Open Branch Transfers.' },
      { find:['new transfer','create transfer'], text:'Create the transfer using the correct source/destination branches and verified stock.' },
      { find:['dispatch','pick up','in transit'], text:'Dispatch only after source quantities are confirmed. This should move the transfer into its in-transit lifecycle.' },
      { find:['receive','receive transfer'], text:'Destination staff should receive only what physically arrived and record discrepancies instead of guessing.' }
    ]},
    { id:'quote', title:'Create or manage a quotation', keywords:['quote','quotation','estimate'], steps:[
      { find:['quotations','quotes'], text:'Open Quotations.' },
      { find:['new quotation','create quote'], text:'Create the quotation with the correct customer, branch, items and validity period.' },
      { find:['send','approve','accept'], text:'Review before sending/acceptance. Once accepted, material revisions should use the controlled copy/reissue path so sourcing side effects are not duplicated.' }
    ]},
    { id:'reports', title:'Run, export or print a report', keywords:['report','reports','export','csv','excel','print','pdf'], steps:[
      { find:['reports','reporting'], text:'Open Reports.' },
      { find:['date','branch','filter'], text:'Set the reporting period, branch and other filters first.' },
      { find:['run report','apply','refresh'], text:'Run or refresh the report and review the results.' },
      { find:['export','csv','excel','print','pdf'], text:'Use the report’s Export or Print controls. Printed reports can be saved as PDF through the browser print dialog where supported.' }
    ]},
    { id:'compensation', title:'Review technician compensation', keywords:['technician pay','technician compensation','pay period','incentive','technician metrics'], steps:[
      { find:['technician','repairs','work orders'], text:'Open the technician/service management area.' },
      { find:['compensation','pay period','performance'], text:'Open Technician Compensation / Performance.' },
      { find:['rate','plan','metrics'], text:'Review the admin-configured rate and compensation plan that applies to the pay period.' },
      { find:['finalize','approve payroll','payroll'], text:'Verify evidence before finalizing. Missing QC, rework, attendance or other evidence should remain unavailable rather than being invented.' }
    ]},
    { id:'erp', title:'Use ERP / inventory intelligence', keywords:['erp','intelligence','smart transfer','recommendation','slow moving','stockout','supplier performance'], steps:[
      { find:['erp','intelligence','analytics'], text:'Open ERP Intelligence / Analytics.' },
      { find:['recommend','transfer','replenish','supplier'], text:'Review the recommendation and the evidence behind it: branch stock, demand, supplier performance or movement history.' },
      { find:['create transfer','purchase request','apply'], text:'When action is justified, use the normal controlled transfer/purchasing workflow. Intelligence should recommend; it should not silently mutate inventory.' }
    ]}
  ];

  const state = { open:false, task:null, step:0, target:null, observer:null };
  const norm = s => String(s || '').toLowerCase().replace(/\s+/g,' ').trim();
  const visible = el => !!el && el instanceof Element && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';

  function textCandidates() {
    return [...document.querySelectorAll('button,a,[role="button"],[role="tab"],nav li,.nav-item,.menu-item,.sidebar-item,.tab,th,h1,h2,h3,label')].filter(visible);
  }
  function findTarget(terms=[]) {
    const exactId = terms.map(t => document.querySelector(`[data-guide-id="${CSS.escape(t)}"]`)).find(visible);
    if (exactId) return exactId;
    const candidates = textCandidates();
    for (const term of terms) {
      const n = norm(term);
      const exact = candidates.find(el => norm(el.textContent) === n); if (exact) return exact;
      const starts = candidates.find(el => norm(el.textContent).startsWith(n)); if (starts) return starts;
      const contains = candidates.find(el => norm(el.textContent).includes(n)); if (contains) return contains;
    }
    return null;
  }
  function clearHighlight() { document.querySelectorAll('.'+GUIDE_CLASS).forEach(el => el.classList.remove(GUIDE_CLASS)); state.target=null; }
  function highlight(step) {
    clearHighlight();
    const target = findTarget(step.find || []);
    state.target = target;
    if (!target) return false;
    target.classList.add(GUIDE_CLASS);
    target.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto':'smooth', block:'center', inline:'nearest' });
    return true;
  }
  function bestTask(query) {
    const q = norm(query); if (!q) return null;
    let best=null, score=0;
    TASKS.forEach(task => {
      let s=0; [...task.keywords,task.title].forEach(k => { const n=norm(k); if(q===n)s+=12; else if(q.includes(n))s+=7; else n.split(' ').forEach(w=>{if(w.length>3&&q.includes(w))s+=1;}); });
      if(s>score){score=s;best=task;}
    });
    return score ? best : null;
  }
  function shell() { return document.getElementById('tt-guided-mode'); }
  function render() {
    const root=shell(); if(!root)return;
    const task=state.task; const step=task?.steps[state.step]; const found=step ? highlight(step) : false;
    root.innerHTML=`<div class="tt-guide-backdrop" data-guide-close></div><section class="tt-guide" role="dialog" aria-modal="true" aria-labelledby="tt-guide-title">
      <div class="tt-guide__head"><div><span class="tt-guide__eyebrow">Total Tools POS</span><h2 id="tt-guide-title">Guided Mode</h2><p>${task ? escapeHtml(task.title) : 'Tell me what you want to do and I’ll guide you through the POS.'}</p></div><button class="tt-guide__close" type="button" aria-label="Close Guided Mode" data-guide-close>×</button></div>
      <div class="tt-guide__body">${task ? `<div class="tt-guide__step"><span class="tt-guide__step-count">Step ${state.step+1} of ${task.steps.length}</span><h3>${found?'Follow the highlighted control':'Control not currently available'}</h3><p>${escapeHtml(step.text)}</p>${found?'<p class="tt-guide__hint">The correct area is highlighted on the screen. Complete the action there, then choose Next.</p>':'<p class="tt-guide__hint">This control may be hidden because of your permissions, the current record state, or a missing prerequisite. Guided Mode will not tell you to click a control that is not actually available.</p>'}</div><div class="tt-guide__actions"><button type="button" data-guide-home>Choose another task</button><div><button type="button" data-guide-prev ${state.step===0?'disabled':''}>Back</button><button type="button" class="is-primary" data-guide-next>${state.step===task.steps.length-1?'Finish':'Next'}</button></div></div>` : `<form class="tt-guide__search" data-guide-search><input id="tt-guide-input" autocomplete="off" placeholder="e.g. dispatch a delivery, receive a PO, close my drawer" aria-label="What do you want to do?"/><button type="submit">Guide me</button></form><div class="tt-guide__suggestions">${TASKS.map(t=>`<button type="button" class="tt-guide__chip" data-task="${t.id}">${escapeHtml(t.title)}</button>`).join('')}</div>`}</div>
    </section>`;
    bind();
    queueMicrotask(()=>root.querySelector(task?'[data-guide-next]':'#tt-guide-input')?.focus());
  }
  function escapeHtml(s){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
  function choose(task){state.task=task;state.step=0;render();}
  function close(){clearHighlight();state.open=false;state.task=null;state.step=0;shell()?.remove();state.observer?.disconnect();state.observer=null;document.getElementById('tt-guide-launcher')?.focus();}
  function open(){if(state.open)return;state.open=true;const root=document.createElement('div');root.id='tt-guided-mode';document.body.appendChild(root);render();state.observer=new MutationObserver(()=>{if(state.task){const step=state.task.steps[state.step]; if(step && !visible(state.target)) highlight(step);}});state.observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class','style','hidden']});}
  function bind(){const root=shell(); if(!root)return; root.querySelectorAll('[data-guide-close]').forEach(x=>x.addEventListener('click',close)); root.querySelector('[data-guide-search]')?.addEventListener('submit',e=>{e.preventDefault();const q=root.querySelector('#tt-guide-input')?.value||'';const task=bestTask(q);if(task)choose(task);else{const toast=document.createElement('div');toast.className='tt-guide-toast';toast.textContent='I could not match that task yet. Try words like sale, repair, dispatch, rental, purchase order, transfer, inventory, report, drawer or technician pay.';document.body.appendChild(toast);setTimeout(()=>toast.remove(),4500);}}); root.querySelectorAll('[data-task]').forEach(btn=>btn.addEventListener('click',()=>choose(TASKS.find(t=>t.id===btn.dataset.task)))); root.querySelector('[data-guide-home]')?.addEventListener('click',()=>{clearHighlight();state.task=null;state.step=0;render();}); root.querySelector('[data-guide-prev]')?.addEventListener('click',()=>{if(state.step>0){state.step--;render();}}); root.querySelector('[data-guide-next]')?.addEventListener('click',()=>{if(!state.task)return;if(state.step>=state.task.steps.length-1)close();else{state.step++;render();}});}
  function install(){
    if(document.getElementById('tt-guide-launcher'))return;
    const skip=document.createElement('a');skip.className='tt-pos-skip';skip.href='#main-content';skip.textContent='Skip to POS content';document.body.prepend(skip);
    const main=document.querySelector('main,.main-content,#content,.content') || document.body.querySelector(':scope > div'); if(main && !main.id)main.id='main-content';
    const btn=document.createElement('button');btn.id='tt-guide-launcher';btn.className='tt-guide-launcher';btn.type='button';btn.setAttribute('aria-haspopup','dialog');btn.innerHTML='<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3a7 7 0 0 0-4.2 12.6c.8.6 1.2 1.2 1.3 1.9h5.8c.1-.7.5-1.3 1.3-1.9A7 7 0 0 0 12 3Z" stroke="currentColor" stroke-width="1.8"/><path d="M9.5 21h5M9.5 18.5h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg><span>Guided Mode</span>';btn.addEventListener('click',open);document.body.appendChild(btn);
    document.addEventListener('keydown',e=>{if(e.key==='Escape'&&state.open)close();});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);else install();
})();