(()=>{'use strict';
const API='/api/purchase-orders/receiving-controls/invoices';
let root=null,detail=null,orderId=null;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c]));
const money=v=>new Intl.NumberFormat('en-JM',{style:'currency',currency:'JMD'}).format(Number(v||0));
const mCents=v=>money(Number(v||0)/100);
async function api(url,opts={}){const response=await fetch(API+url,{credentials:'same-origin',headers:{'Content-Type':'application/json',...(opts.headers||{})},...opts});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||'Invoice receipt request failed');return data}
function notice(v,error=false){const el=root?.querySelector('#tt-inv-status');if(el){el.textContent=String(v||'');el.classList.toggle('has-error',!!error)}}
function close(){root?.remove();root=null;detail=null;orderId=null}
function skeleton(){root=document.createElement('div');root.className='tt-inv';root.innerHTML='<div class="tt-inv__shade" data-close></div><section class="tt-inv__panel" role="dialog" aria-modal="true" aria-labelledby="tt-inv-title"><header class="tt-inv__head"><div><small>PURCHASING / RECEIPT RECONCILIATION</small><h2 id="tt-inv-title">Supplier invoices &amp; deliveries</h2><p>Connect each supplier invoice to the delivery it covers, without posting duplicate payables or stock.</p></div><button type="button" data-close aria-label="Close invoice reconciliation">×</button></header><div class="tt-inv__body" id="tt-inv-body"><p>Loading receiving evidence…</p></div><footer class="tt-inv__footer"><span id="tt-inv-status" role="status"></span><button class="secondary" data-close>Done</button></footer></section>';document.body.appendChild(root);root.querySelectorAll('[data-close]').forEach(x=>x.addEventListener('click',close));root.querySelector('.tt-inv__panel').addEventListener('keydown',e=>{if(e.key==='Escape')close()})}
function invoiceOptions(){return'<option value="">Record an invoice reference awaiting Finance</option>'+(detail?.posted_invoices||[]).map(i=>'<option value="'+i.id+'" data-number="'+esc(i.invoice_number)+'" data-date="'+esc(i.invoice_date)+'" data-subtotal="'+esc(Number(i.subtotal).toFixed(2))+'">'+esc(i.invoice_number)+' · '+money(i.subtotal)+' posted</option>').join('')}
function receiptOptions(){return'<option value="">Choose a goods receipt</option>'+(detail?.receipts||[]).map(r=>'<option value="'+r.id+'">'+esc(r.receipt_number)+' · '+esc(String(r.received_at).slice(0,16))+' · '+money(r.total_cost)+'</option>').join('')}
function render(){
 if(!root||!detail)return;
 const receipts=detail.receipts||[],evidence=detail.evidence||[],posted=detail.posted_invoices||[];
 const summary='<div class="tt-inv__summary"><div><small>PO</small><strong>'+esc(detail.po.po_number)+'</strong></div><div><small>Deliveries</small><strong>'+receipts.length+'</strong></div><div><small>Supplier invoices posted</small><strong>'+posted.length+'</strong></div><div><small>Awaiting AP match</small><strong>'+evidence.filter(x=>x.finance_status==='pending_ap').length+'</strong></div></div>';
 const rows=receipts.length?receipts.map(r=>{
  const assigned=evidence.filter(e=>Number(e.receipt_id)===Number(r.id)),diff=Number(r.unmatched_receipt_cents);
  return'<article class="tt-inv__receipt"><div class="tt-inv__receipt-head"><strong>'+esc(r.receipt_number)+'</strong><span>'+money(r.total_cost)+' · '+esc(String(r.received_at||'').slice(0,16))+'</span></div><p>Invoice allocations: '+mCents(r.invoice_allocated_cents)+' · Difference: <strong>'+mCents(diff)+'</strong>'+(diff===0?' · Matched': ' · Review difference')+'</p>'
  +(assigned.length?assigned.map(e=>'<div class="tt-inv__evidence"><div><strong>'+esc(e.invoice_number)+'</strong><small>'+esc(e.invoice_date)+' · '+mCents(e.allocated_value_cents)+' allocated</small></div><span>'+esc(e.finance_status==='pending_ap'?'Awaiting Finance posting':'Linked to posted invoice')+'</span>'+(e.finance_status==='pending_ap'?'<button type="button" class="secondary" data-confirm="'+e.id+'">Link posted invoice</button>':'')+'</div>').join(''):'<p class="tt-inv__muted">No invoice reference is linked to this delivery yet.</p>')+'</article>';
 }).join(''):'<div class="tt-inv__empty">No goods receipts on this purchase order. Receive the delivery first, then link its invoice.</div>';
 const input=receipts.length?'<form id="tt-inv-form" class="tt-inv__form"><div class="tt-inv__form-heading"><strong>Link an invoice to a goods receipt</strong><span>Enter the merchandise subtotal (before tax and freight). This records evidence, not a new payable.</span></div>'
 +'<label>Goods receipt<select name="receipt_id" required>'+receiptOptions()+'</select></label>'
 +'<label>Existing posted invoice<select name="posted_invoice_id">'+invoiceOptions()+'</select></label>'
 +'<label>Supplier invoice number<input name="invoice_number" required maxlength="120" autocomplete="off" placeholder="As printed on supplier invoice"></label>'
 +'<label>Invoice date<input name="invoice_date" type="date" required></label>'
 +'<label>Invoice merchandise subtotal (JMD)<input name="invoice_subtotal" type="number" step="0.01" min="0.01" required></label>'
 +'<label>Value of this invoice allocated to this receipt (JMD)<input name="allocated_value" type="number" step="0.01" min="0.01" required></label>'
 +'<label class="tt-inv__wide">Receiving note<textarea name="notes" maxlength="1000" placeholder="Invoice discrepancy, split delivery, credit still pending, etc."></textarea></label>'
 +'<button type="submit">Save receipt–invoice link</button><p class="tt-inv__hint">If Finance has not posted the invoice, it stays “Awaiting AP match.” It is not automatically payable.</p></form>':'';
 root.querySelector('#tt-inv-body').innerHTML=summary+'<div class="tt-inv__section-head"><h3>Deliveries and invoice matching</h3><p>Multiple receipts and invoices can be tracked against the same PO.</p></div>'+rows+input;
 const form=root.querySelector('#tt-inv-form');
 if(form){
  form.querySelector('[name=posted_invoice_id]').addEventListener('change',()=>{
    const sel=form.querySelector('[name=posted_invoice_id]').selectedOptions[0];
    if(!sel?.value)return;
    form.querySelector('[name=invoice_number]').value=sel.dataset.number||'';
    form.querySelector('[name=invoice_date]').value=sel.dataset.date?.slice(0,10)||'';
    form.querySelector('[name=invoice_subtotal]').value=sel.dataset.subtotal||'';
  });
  form.querySelector('[name=receipt_id]').addEventListener('change',()=>{
    const receipt=receipts.find(x=>String(x.id)===form.querySelector('[name=receipt_id]').value);
    if(receipt)form.querySelector('[name=allocated_value]').value=(Math.max(0,Number(receipt.unmatched_receipt_cents))/100).toFixed(2);
  });
  form.addEventListener('submit',async e=>{
    e.preventDefault();const fd=new FormData(form),receiptId=fd.get('receipt_id');if(!receiptId)return notice('Choose the receipt.',true);
    const button=form.querySelector('button[type=submit]');button.disabled=true;
    try{
      const payload={invoice_number:fd.get('invoice_number'),invoice_date:fd.get('invoice_date'),invoice_subtotal:fd.get('invoice_subtotal'),allocated_value:fd.get('allocated_value'),notes:fd.get('notes')};
      const result=await api('/receipts/'+encodeURIComponent(receiptId),{method:'POST',body:JSON.stringify(payload)});
      await reload();notice(result.finance_status==='pending_ap'?'Invoice evidence recorded. Finance must post and match the invoice.':'Posted supplier invoice linked to receipt.');
    }catch(err){notice(err.message,true);button.disabled=false}
  });
 }
 root.querySelectorAll('[data-confirm]').forEach(button=>button.addEventListener('click',async()=>{
  const e=evidence.find(x=>String(x.id)===button.dataset.confirm);if(!e)return;
  const match=posted.find(x=>String(x.invoice_number).trim().toUpperCase().replace(/[^A-Z0-9]/g,'')===String(e.invoice_number).trim().toUpperCase().replace(/[^A-Z0-9]/g,''));
  if(!match)return notice('No matching posted invoice for '+e.invoice_number+'. Ask Finance to post it against this PO first.',true);
  button.disabled=true;
  try{await api('/evidence/'+e.id+'/confirm',{method:'POST',body:JSON.stringify({supplier_invoice_id:match.id})});await reload();notice('Existing Finance invoice confirmed; no new payable created.')}
  catch(err){notice(err.message,true);button.disabled=false}
 }));
}
async function reload(){if(!orderId)return;detail=await api('/orders/'+orderId);render()}
async function open(value){
 const id=Number(value);if(!Number.isSafeInteger(id)||id<=0){window.TotalToolsShellUI?.toast?.('Open a purchase order first.','error');return}
 close();orderId=id;skeleton();
 try{await reload();notice('Review invoice allocations before completing AP reconciliation.')}catch(err){notice(err.message,true);root.querySelector('#tt-inv-body').textContent='Unable to load invoice matching: '+err.message}
}
window.TotalToolsReceiptInvoiceLinks={open,close};
})();