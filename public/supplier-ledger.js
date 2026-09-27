(()=>{'use strict';
const state={open:false,overview:null,invoices:[],branch_id:''};
const PAYMENT_OPERATION_STORAGE='tt_supplier_payment_operation_v1';
const money=v=>new Intl.NumberFormat(undefined,{style:'currency',currency:'JMD',maximumFractionDigits:0}).format(Number(v||0));
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const notice=(message,tone='info')=>{const ui=window.TotalToolsShellUI;if(ui?.toast)ui.toast(String(message||''),tone);else console.error(String(message||''))};
async function api(path,opts={}){const r=await fetch('/api/supplier-ledger'+path,{credentials:'same-origin',headers:{'Content-Type':'application/json',...(opts.headers||{})},...opts});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||'Request failed');return d;}
function stable(value){if(Array.isArray(value))return value.map(stable);if(value&&typeof value==='object')return Object.keys(value).sort().reduce((o,k)=>(o[k]=stable(value[k]),o),{});return value;}
function paymentFingerprint(body){const clean={...(body||{})};for(const k of ['duplicate_payment_override_pin','duplicate_payment_override_reason','payment_similarity_override_pin','payment_similarity_override_reason','supplier_credit_override_pin','supplier_credit_override_reason'])delete clean[k];return JSON.stringify(stable(clean));}
function readPaymentOperation(){try{return JSON.parse(sessionStorage.getItem(PAYMENT_OPERATION_STORAGE)||'null');}catch{return null;}}
function clearPaymentOperation(){try{sessionStorage.removeItem(PAYMENT_OPERATION_STORAGE);}catch{}}
function paymentOperationFor(body){
  const fingerprint=paymentFingerprint(body),existing=readPaymentOperation();
  if(existing?.key&&existing?.fingerprint){
    if(existing.fingerprint!==fingerprint)throw new Error('A supplier payment is still awaiting a deterministic retry. Retry the unchanged payment first before editing or starting another payment.');
    return existing.key;
  }
  const key=`supplier-payment-${Date.now()}-${globalThis.crypto?.randomUUID?.()||Math.random().toString(36).slice(2)}`;
  try{sessionStorage.setItem(PAYMENT_OPERATION_STORAGE,JSON.stringify({key,fingerprint,created_at:new Date().toISOString()}));}catch{}
  return key;
}
function root(){return document.getElementById('tt-supplier-ledger');}
function shell(){let e=root();if(e)return e;e=document.createElement('div');e.id='tt-supplier-ledger';e.className='tt-supplier-ledger';document.body.appendChild(e);return e;}
function close(){root()?.remove();state.open=false;}
async function load(){const q=state.branch_id?'?branch_id='+encodeURIComponent(state.branch_id):'';const [overview,invoices]=await Promise.all([api('/overview'+q),api('/invoices'+(q?q+'&status=open':'?status=open'))]);state.overview=overview;state.invoices=invoices;render();}
async function open(){if(state.open)return;state.open=true;renderLoading();try{await load();}catch(e){renderError(e.message);}}
function renderLoading(){shell().innerHTML=`<div class="tt-supplier-ledger__backdrop" data-close></div><section class="tt-supplier-ledger__panel"><header><div><span class="eyebrow">Finance</span><h2>Supplier Bills & Payments</h2><p>Posted supplier invoices, payment allocation and AP aging.</p></div><button data-close>×</button></header><div class="tt-supplier-ledger__loading">Loading supplier ledger…</div></section>`;bindClose();}
function renderError(m){shell().innerHTML=`<div class="tt-supplier-ledger__backdrop" data-close></div><section class="tt-supplier-ledger__panel"><header><div><span class="eyebrow">Finance</span><h2>Supplier Bills & Payments</h2></div><button data-close>×</button></header><div class="tt-supplier-ledger__error">${esc(m)}</div></section>`;bindClose();}
function kpi(l,v,s=''){return `<article class="tt-supplier-ledger-kpi"><small>${esc(l)}</small><strong>${esc(v)}</strong>${s?`<span>${esc(s)}</span>`:''}</article>`;}
function invoiceRows(){return state.invoices.length?state.invoices.map(r=>`<tr><td>${esc(r.invoice_number)}</td><td>${esc(r.supplier_name)}</td><td>${esc(r.po_number||'—')}</td><td>${esc(r.due_date||'—')}</td><td>${money(r.total)}</td><td>${money(r.paid_amount)}</td><td><strong>${money(r.balance_due)}</strong></td></tr>`).join(''):'<tr><td colspan="7">No open supplier invoices.</td></tr>';}
function render(){const o=state.overview,s=o.summary,a=o.aging;shell().innerHTML=`<div class="tt-supplier-ledger__backdrop" data-close></div><section class="tt-supplier-ledger__panel"><header><div><span class="eyebrow">Finance</span><h2>Supplier Bills & Payments</h2><p>Formal payables begin only when a supplier invoice is posted.</p></div><button data-close>×</button></header><div class="tt-supplier-ledger__toolbar"><label>Branch ID<input id="tt-supplier-ledger-branch" value="${esc(state.branch_id)}" placeholder="All branches"></label><button id="tt-supplier-ledger-refresh">Refresh</button><button id="tt-supplier-ledger-forecast">Cash forecast</button><button id="tt-supplier-ledger-post">Post supplier invoice</button><button id="tt-supplier-ledger-pay">Record payment</button></div><div class="tt-supplier-ledger__body"><div class="tt-supplier-ledger-kpis">${kpi('Open AP',money(s.open_ap),`${s.posted_invoices||0} posted invoices`)}${kpi('Overdue AP',money(s.overdue_ap),'Past due supplier invoices')}${kpi('Not yet due',money(s.not_yet_due_ap),'Posted but not overdue')}${kpi('90+ days',money(a.over_90),'Oldest payable exposure')}</div><div class="tt-supplier-ledger-note"><strong>Ledger rule:</strong> ${esc(o.basis)}</div><details class="tt-supplier-ledger-disclosure"><summary><span><strong>Accounts payable aging</strong><small>See how long posted supplier invoices have been outstanding</small></span><em>+</em></summary><div class="tt-supplier-ledger-disclosure-body"><div class="tt-supplier-ledger-aging">${kpi('Current / not overdue',money(a.current_due))}${kpi('1–30 days',money(a.days_1_30))}${kpi('31–60 days',money(a.days_31_60))}${kpi('61–90 days',money(a.days_61_90))}${kpi('90+ days',money(a.over_90))}</div></div></details><section><div class="tt-supplier-ledger-sectionhead"><div><span class="eyebrow">Open invoices</span><h3>What is actually payable</h3></div><span>${state.invoices.length} open</span></div><div class="tt-supplier-ledger-table"><table><thead><tr><th>Invoice</th><th>Supplier</th><th>PO</th><th>Due</th><th>Total</th><th>Paid</th><th>Balance</th></tr></thead><tbody>${invoiceRows()}</tbody></table></div></section></div></section>`;bindClose();bind();}
function modal(title,fields,onSubmit){const host=document.createElement('div');host.className='tt-supplier-ledger-modal';host.innerHTML=`<div class="tt-supplier-ledger-modal__card"><header><h3>${esc(title)}</h3><button type="button" data-dismiss>×</button></header><form>${fields}<div class="tt-supplier-ledger-modal__actions"><button type="button" data-dismiss>Cancel</button><button type="submit">Save</button></div></form></div>`;shell().appendChild(host);host.querySelectorAll('[data-dismiss]').forEach(x=>x.addEventListener('click',()=>host.remove()));host.querySelector('form').addEventListener('submit',async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(e.currentTarget).entries());const submit=e.currentTarget.querySelector('[type="submit"]');submit.disabled=true;try{await onSubmit(data);host.remove();await load();}catch(err){notice(err.message,'error');}finally{submit.disabled=false;}});}
async function showCashForecast(){
  try{
    const branch=state.branch_id?('&branch_id='+encodeURIComponent(state.branch_id)):'';
    const forecast=await api('/cash-forecast?horizon_days=30'+branch);
    const s=forecast.summary||{};
    const top=(forecast.suppliers||[]).slice(0,12).map(x=>`<tr><td>${esc(x.supplier_name)}</td><td>${money(x.open_ap)}</td><td>${money(x.planned_recoverable_offsets)}</td><td><strong>${money(x.cash_due_30_days)}</strong></td><td>${money(x.overdue_cash)}</td><td>${money(x.actionable_discount_total)}</td><td>${money(x.unmatched_formal_credit_notes)}</td></tr>`).join('');
    const host=document.createElement('div');host.className='tt-supplier-ledger-modal';
    host.innerHTML=`<div class="tt-supplier-ledger-modal__card" style="max-width:1100px"><header><div><span class="eyebrow">Finance</span><h3>30-day supplier cash forecast</h3></div><div style="display:flex;gap:8px"><button type="button" id="tt-supplier-forecast-save">Save baseline</button><button type="button" id="tt-supplier-forecast-performance">Review latest performance</button><button type="button" data-dismiss>×</button></div></header><div style="padding:16px"><div class="tt-supplier-ledger-kpis">${kpi('Open AP',money(s.open_ap))}${kpi('Offsets available',money(s.offset_ready_recoverables))}${kpi('Minimum cash',money(s.minimum_cash_total))}${kpi('Due in 7 days',money(s.cash_due_7_days))}${kpi('Due in 14 days',money(s.cash_due_14_days))}${kpi('Due in 30 days',money(s.cash_due_30_days))}${kpi('Overdue',money(s.overdue_cash))}${kpi('Discounts available',money(s.actionable_discount_total))}</div><div class="tt-supplier-ledger-note" style="margin:16px 0"><strong>Forecast basis:</strong> ${esc(forecast.basis||'')}</div><div class="tt-supplier-ledger-table"><table><thead><tr><th>Supplier</th><th>Open AP</th><th>Planned offsets</th><th>Cash due 30d</th><th>Overdue</th><th>Discounts</th><th>Unmatched credits</th></tr></thead><tbody>${top||'<tr><td colspan="7">No supplier cash requirements in forecast.</td></tr>'}</tbody></table></div></div></div>`;
    shell().appendChild(host);host.querySelectorAll('[data-dismiss]').forEach(x=>x.addEventListener('click',()=>host.remove()));
    host.querySelector('#tt-supplier-forecast-save')?.addEventListener('click',async()=>{try{const snap=await api('/cash-forecast/snapshots',{method:'POST',body:JSON.stringify({branch_id:state.branch_id?Number(state.branch_id):null,horizon_days:30})});notice('Cash forecast baseline saved (#'+snap.id+')','success');}catch(e){notice(e.message,'error');}});
    host.querySelector('#tt-supplier-forecast-performance')?.addEventListener('click',async()=>{try{const q=state.branch_id?'?branch_id='+encodeURIComponent(state.branch_id):'';const snaps=await api('/cash-forecast/snapshots'+q);if(!snaps.length)throw new Error('Save a cash forecast baseline first.');const perf=await api('/cash-performance/'+snaps[0].id);const p=perf.summary||{};window.alert('Supplier cash performance vs baseline #'+snaps[0].id+'\n\nPlanned cash: '+money(p.planned_cash||0)+'\nActual cash within horizon: '+money(p.actual_cash_within_horizon||0)+'\nCash variance: '+money(p.cash_variance||0)+'\nPlanned offsets: '+money(p.planned_offsets||0)+'\nActual offsets: '+money(p.actual_offsets_within_horizon||0)+'\nPotentially early cash: '+money(p.cash_paid_before_due_without_documented_discount||0)+'\nExpired discount opportunity signal: '+money(p.potential_discount_opportunity_expired||0)+'\nCurrent overdue carryover: '+money(p.current_overdue_carryover||0)+'\n\n'+(perf.basis||''));}catch(e){notice(e.message,'error');}});
  }catch(e){notice(e.message,'error');}
}
function postInvoice(){modal('Post supplier invoice',`<label>Supplier ID<input name="supplier_id" type="number" required></label><label>Purchase order ID<input name="purchase_order_id" type="number"></label><label>Branch ID<input name="branch_id" type="number"></label><label>Invoice number<input name="invoice_number" required></label><label>Invoice date<input name="invoice_date" type="date" required></label><label>Due date<input name="due_date" type="date"></label><label>Subtotal<input name="subtotal" type="number" step="0.01" required></label><label>Tax<input name="tax_amount" type="number" step="0.01" value="0"></label><label>Total<input name="total" type="number" step="0.01" required></label><label>Payment terms / supplier reference<input name="payment_terms_reference" placeholder="e.g. 2/10 Net 30 on invoice"></label><label>Early-payment discount deadline<input name="discount_deadline" type="date"></label><label>Documented discount amount<input name="discount_amount" type="number" step="0.01" min="0" value="0"></label><label>Late-fee effective date<input name="late_fee_effective_date" type="date"></label><label>Documented late-fee amount<input name="late_fee_amount" type="number" step="0.01" min="0" value="0"></label><label>Notes<textarea name="notes"></textarea></label>`,d=>api('/invoices',{method:'POST',body:JSON.stringify(d)}));}
function recordPayment(){modal('Record supplier payment',`<label>Supplier ID<input name="supplier_id" type="number" required></label><label>Branch ID<input name="branch_id" type="number"></label><label>Payment date<input name="payment_date" type="date" required></label><label>Amount<input name="amount" type="number" step="0.01" required></label><label>Payment method<input name="payment_method" placeholder="Bank transfer, cheque, cash"></label><label>Reference<input name="reference"></label><label>Notes<textarea name="notes"></textarea></label>`,async d=>{
  const supplierId=Number(d.supplier_id),branchId=Number(d.branch_id)||null;
  const suffix='?supplier_id='+encodeURIComponent(supplierId)+(branchId?'&branch_id='+encodeURIComponent(branchId):'');
  let [position,plan,timing]=await Promise.all([
    api('/payments/credit-position?supplier_id='+encodeURIComponent(supplierId)),
    api('/payments/net-plan'+suffix),
    api('/payment-timing'+suffix)
  ]);
  if(Number(timing.summary?.actionable_discount_total||0)>0||Number(timing.summary?.stated_late_fee_exposure||0)>0||Number(timing.summary?.not_yet_due_ap||0)>0){
    const discountRows=(timing.invoices||[]).filter(x=>x.discount_actionable).slice(0,5).map(x=>x.invoice_number+': save '+money(Math.min(Number(x.discount_amount||0),Number(x.balance_due||0)))+' by '+x.discount_deadline).join('\n');
    const timingText='Documented discounts available: '+money(timing.summary?.actionable_discount_total||0)+'\nStated late-fee exposure: '+money(timing.summary?.stated_late_fee_exposure||0)+'\nAP not yet due: '+money(timing.summary?.not_yet_due_ap||0)+'\nOverdue AP: '+money(timing.summary?.overdue_ap||0)+(discountRows?'\n\nDiscount opportunities:\n'+discountRows:'')+(Number(timing.summary?.invoices_with_partial_discount_terms||0)>0?'\n\nSome partially paid invoices have discount terms that require supplier verification.':'');
    window.alert('Supplier payment timing\n\n'+timingText+'\n\nTiming guidance uses only documented supplier terms and does not post discounts or late fees.');
  }
  if(plan.proposed_ap_offset>0||plan.unmatched_formal_credit_notes>0){
    const suggested=(plan.suggested_offsets||[]).slice(0,6).map(x=>x.claim_number+' → '+x.invoice_number+': '+money(x.amount)).join('\n');
    const planText='Open AP: '+money(plan.open_ap)+'\nProposed AP offsets: '+money(plan.proposed_ap_offset)+'\nMinimum cash after current offsets: '+money(plan.minimum_cash_after_current_offsets)+'\nUnmatched formal credit notes: '+money(plan.unmatched_formal_credit_notes)+(suggested?'\n\nSuggested offsets:\n'+suggested:'');
    window.alert('Supplier net-payment plan\n\n'+planText+'\n\nThis is a read-only preview; no credit or payment has been posted yet.');
    if(plan.proposed_ap_offset>0&&window.confirm('Apply the proposed recoverable offsets to Accounts Payable now before sending cash?')){
      const netKey='NETPLAN-'+supplierId+'-'+(branchId||0)+'-'+plan.plan_hash;
      const applied=await api('/payments/net-plan/apply',{method:'POST',headers:{'Idempotency-Key':netKey},body:JSON.stringify({supplier_id:supplierId,branch_id:branchId,plan_hash:plan.plan_hash})});
      window.alert('Applied '+money(applied.applied_amount)+' in supplier recoverable offsets. Remaining AP after execution: '+money(applied.minimum_cash_after_execution)+'.');
      if(Number(applied.minimum_cash_after_execution||0)<=0){
        clearPaymentOperation();
        window.alert('No cash payment is required after the applied offsets.');
        return applied;
      }
      const cash=Number(window.prompt('Enter the cash/bank amount you still intend to pay after offsets',String(applied.minimum_cash_after_execution)));
      if(!Number.isFinite(cash)||cash<=0){
        clearPaymentOperation();
        window.alert('Offsets were applied. No cash payment was recorded.');
        return applied;
      }
      if(cash>Number(applied.minimum_cash_after_execution||0)+0.01)throw new Error('Cash payment cannot exceed the remaining AP after the offsets you just applied.');
      d.amount=String(cash);
      position=await api('/payments/credit-position?supplier_id='+encodeURIComponent(supplierId));
    }
  }
  if(position.requires_override){
    const details='Offset-ready recoverables: '+money(position.offset_ready_recoverables)+'\nUnmatched formal credit notes: '+money(position.unmatched_credit_notes)+'\nMatched but not yet settled: '+money(position.matched_unsettled_credit)+'\nIdentified/unconfirmed claims: '+money(position.identified_unconfirmed_claims)+'\n\nAvailable supplier credit should be applied before sending more cash.';
    if(!window.confirm(details+'\n\nContinue only with independent finance approval?'))throw new Error('Supplier payment cancelled so available supplier credit can be applied first.');
    const pin=window.prompt('Independent finance/supervisor PIN');
    if(!pin)throw new Error('Independent finance authorization is required.');
    const reason=window.prompt('Reason for paying cash instead of applying available supplier credit first');
    if(!reason||reason.trim().length<10)throw new Error('A meaningful supplier-credit override reason is required.');
    d.supplier_credit_override_pin=pin.trim();
    d.supplier_credit_override_reason=reason.trim();
  }
  const operationKey=paymentOperationFor(d);
  const result=await api('/payments',{method:'POST',headers:{'Idempotency-Key':operationKey},body:JSON.stringify(d)});
  clearPaymentOperation();return result;
});}
function bindClose(){shell().querySelectorAll('[data-close]').forEach(x=>x.addEventListener('click',close));}
function bind(){shell().querySelector('#tt-supplier-ledger-refresh')?.addEventListener('click',async()=>{state.branch_id=shell().querySelector('#tt-supplier-ledger-branch').value.trim();renderLoading();try{await load();}catch(e){renderError(e.message);}});shell().querySelector('#tt-supplier-ledger-forecast')?.addEventListener('click',showCashForecast);shell().querySelector('#tt-supplier-ledger-post')?.addEventListener('click',postInvoice);shell().querySelector('#tt-supplier-ledger-pay')?.addEventListener('click',recordPayment);}
window.TotalToolsSupplierLedger={open,close,refresh:load};
})();