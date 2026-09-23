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
      { find:['dispatch & deliveries','dispatch','logistics'], text:'Open Dispatch & Deliveries.' },
      { find:['unassigned','dispatch queue','jobs'], text:'Review the dispatch queue, priority, promised time, assignment state and operational risk before choosing work.' },
      { find:['schedule','assignee','vehicle'], text:'Assign the authorized employee and vehicle, then schedule the movement using the available vehicle capacity and schedule.' },
      { find:['ready','in transit','delayed','completed'], text:'Move the dispatch through its real lifecycle. Record delays rather than hiding them, and mark completed only after the movement is actually finished.' }
    ]},
    { id:'inventory-adjust', title:'Adjust inventory', keywords:['adjust inventory','stock adjustment','damage stock','write off','inventory correction'], steps:[
      { find:['inventory','products'], text:'Open Inventory.' },
      { find:['adjust','stock adjustment','inventory adjustment'], text:'Choose the controlled stock-adjustment action for the exact item and branch.' },
      { find:['reason','adjustment reason'], text:'Enter the verified quantity change and a real reason. Do not disguise sales, transfers or cycle-count variance as manual adjustments.' }
    ]},
    { id:'brands', title:'Manage product brands', keywords:['brand','brands','brand logo','product brand','manage brands'], steps:[
      { find:['products & categories','inventory','catalog'], text:'Open Products & Categories.' },
      { find:['brands','manage brands','brand maintenance'], text:'Open Brands to review the current brand list.' },
      { find:['new brand','edit brand','brand name'], text:'Add or edit the brand using its correct name and description. Avoid creating spelling variants of an existing brand.' },
      { find:['logo image','brand logo','save brand'], text:'Add the approved brand logo when available, then save. Product assignment remains a separate deliberate catalog edit.' }
    ]},
    { id:'catalog-duplicates', title:'Review duplicate catalog products', keywords:['duplicate products','duplicate sku','catalog duplicates','merge products','consolidate products'], steps:[
      { find:['catalog management','products & categories','catalog'], text:'Open Catalog Management.' },
      { find:['catalog health','work queue'], text:'Open Catalog Health and review the work queue. Duplicate candidates are evidence for review, not an automatic merge.' },
      { find:['confirm same item','not a duplicate','needs more info'], text:'Compare the exact records. Record whether they are the same item, not duplicates, or need more information, and enter the real reason.' },
      { find:['review consolidation','plan consolidation','consolidation impact review'], text:'If the records are confirmed duplicates, review stock, units, history and the proposed surviving product before any consolidation.' },
      { find:['consolidate records','surviving product'], text:'Choose the surviving product only after the review is complete. Consolidation preserves historical records, retires duplicates and leaves consolidated records read-only.' }
    ]},
    { id:'count', title:'Run a stock or cycle count', keywords:['cycle count','stock count','physical count','inventory count'], steps:[
      { find:['warehouse','inventory','cycle count'], text:'Open Warehouse / Inventory Counts.' },
      { find:['new count','start count','cycle count'], text:'Start a count for the correct branch/location and scope.' },
      { find:['commit','finalize','complete count'], text:'Enter physical quantities, review variances and commit through the count workflow so the variance remains auditable.' }
    ]},
    { id:'pr', title:'Create or approve a purchase request', keywords:['purchase request','pr','request purchase','replenish'], steps:[
      { find:['purchase requests','purchasing'], text:'Open Purchase Requests.' },
      { find:['new purchase request','create request'], text:'Create the request with the correct branch, products, quantities and business reason.' },
      { find:['approve','reject'], text:'Authorized approvers should review demand, supplier options and supporting details before approving or rejecting.' },
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
      { find:['finalize','approve payroll','payroll'], text:'Check QC, rework and attendance records before finalizing. If required information is missing, the system should show that clearly instead of guessing.' }
    ]},
    { id:'erp', title:'Stock Planning & Replenishment', keywords:['stock planning','replenishment','reordering','smart transfer','recommendation','slow moving','stockout','supplier performance','what to order'], steps:[
      { find:['stock planning','stock health','reordering'], text:'Open Stock Planning & Replenishment.' },
      { find:['low stock','move between branches','what to order','supplier choice'], text:'Review why the system is suggesting the action: branch stock, demand, supplier performance or stock history.' },
      { find:['create transfer','purchase request'], text:'If the action makes sense, use the normal transfer or purchasing process. Suggestions must never change stock automatically.' }
    ]}
  ];

  const state = { open:false, task:null, step:0, target:null, observer:null, returnFocus:null };
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
    root.innerHTML=`<div class="tt-guide-backdrop" aria-hidden="true"></div><section class="tt-guide" role="dialog" aria-modal="false" aria-labelledby="tt-guide-title" aria-describedby="tt-guide-description">
      <div class="tt-guide__head"><div><span class="tt-guide__eyebrow">Total Tools</span><h2 id="tt-guide-title">Guide Me</h2><p id="tt-guide-description">${task ? escapeHtml(task.title) : 'Tell me what you need to do. I’ll take you to the right place and stay with you while you work.'}</p></div><button class="tt-guide__close" type="button" aria-label="Close Guide Me" data-guide-close>&times;</button></div>
      <div class="tt-guide__body">${task ? `<div class="tt-guide__step"><span class="tt-guide__step-count">Step ${state.step+1} of ${task.steps.length}</span><h3>${found?'Follow the highlighted control':'Control not currently available'}</h3><p>${escapeHtml(step.text)}</p>${found?'<p class="tt-guide__hint">The correct area is highlighted on the screen. Complete the action there, then choose Next.</p>':'<p class="tt-guide__hint">This control may be hidden because of your permissions, the current record state, or a missing prerequisite. Guide Me will not tell you to click a control that is not actually available.</p>'}</div><div class="tt-guide__actions"><button type="button" data-guide-home>Choose another task</button><div><button type="button" data-guide-prev ${state.step===0?'disabled':''}>Back</button><button type="button" class="is-primary" data-guide-next>${state.step===task.steps.length-1?'Finish':'Next'}</button></div></div>` : `<form class="tt-guide__search" data-guide-search><input id="tt-guide-input" autocomplete="off" placeholder="e.g. dispatch a delivery, receive a PO, close my drawer" aria-label="What do you want to do?"/><button type="submit">Guide me</button></form><div class="tt-guide__suggestions">${TASKS.map(t=>`<button type="button" class="tt-guide__chip" data-task="${t.id}">${escapeHtml(t.title)}</button>`).join('')}</div>`}</div>
    </section>`;
    bind();
    queueMicrotask(()=>root.querySelector(task?'[data-guide-next]':'#tt-guide-input')?.focus());
  }
  function escapeHtml(s){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
  function choose(task){state.task=task;state.step=0;render();}
  function close(){clearHighlight();state.open=false;state.task=null;state.step=0;shell()?.remove();state.observer?.disconnect();state.observer=null;const target=state.returnFocus&&state.returnFocus.isConnected?state.returnFocus:document.getElementById('shell-guide');state.returnFocus=null;target?.focus?.({preventScroll:true});}
  function open(){if(state.open){shell()?.querySelector('#tt-guide-input,[data-guide-next]')?.focus?.({preventScroll:true});return;}state.returnFocus=document.activeElement instanceof HTMLElement?document.activeElement:null;state.open=true;const root=document.createElement('div');root.id='tt-guided-mode';document.body.appendChild(root);render();requestAnimationFrame(()=>root.classList.add('is-open'));state.observer=new MutationObserver(()=>{if(state.task){const step=state.task.steps[state.step]; if(step && !visible(state.target)) highlight(step);}});state.observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class','style','hidden']});}
  function bind(){const root=shell(); if(!root)return; root.querySelectorAll('[data-guide-close]').forEach(x=>x.addEventListener('click',close)); root.querySelector('[data-guide-search]')?.addEventListener('submit',e=>{e.preventDefault();const q=root.querySelector('#tt-guide-input')?.value||'';const task=bestTask(q);if(task)choose(task);else{const toast=document.createElement('div');toast.className='tt-guide-toast';toast.textContent='I could not match that task yet. Try words like sale, repair, dispatch, rental, purchase order, transfer, inventory, report, drawer or technician pay.';document.body.appendChild(toast);setTimeout(()=>toast.remove(),4500);}}); root.querySelectorAll('[data-task]').forEach(btn=>btn.addEventListener('click',()=>choose(TASKS.find(t=>t.id===btn.dataset.task)))); root.querySelector('[data-guide-home]')?.addEventListener('click',()=>{clearHighlight();state.task=null;state.step=0;render();}); root.querySelector('[data-guide-prev]')?.addEventListener('click',()=>{if(state.step>0){state.step--;render();}}); root.querySelector('[data-guide-next]')?.addEventListener('click',()=>{if(!state.task)return;if(state.step>=state.task.steps.length-1)close();else{state.step++;render();}});}
  window.TotalToolsGuideMe={open,openTask:(id)=>{const task=TASKS.find(t=>t.id===id);if(!task)return false;if(!state.open)open();choose(task);return true;},tasks:()=>TASKS.map(t=>({id:t.id,title:t.title}))};
  function install(){
    if(!document.querySelector('.tt-pos-skip')){const skip=document.createElement('a');skip.className='tt-pos-skip';skip.href='#main-content';skip.textContent='Skip to POS content';document.body.prepend(skip);}
    const main=document.querySelector('main,.main-content,#content,.content') || document.body.querySelector(':scope > div'); if(main && !main.id)main.id='main-content';
    document.getElementById('tt-guide-launcher')?.remove();
    document.addEventListener('keydown',e=>{if(e.key==='Escape'&&state.open)close();});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);else install();
})();