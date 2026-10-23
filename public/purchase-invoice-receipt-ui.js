(()=>{'use strict';
const base='/api/purchase-orders/receiving-controls/invoice-receipts';
let overlay=null,info=null,selectedInvoice=null,retry=null;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','"':'&quot;',"'":'&#39;'}[c]));
const money=v=>new Intl.NumberFormat('en-JM',{style:'currency',currency:'JMD'}).format(Number(v)||0);
async function get(path,options={}){const res=await fetch(base+path,{credentials:'same-origin',headers:{Accept:'application/json','Content-Type':'application/json',...(options.headers||{})},...options});const data=await res.json().catch(()=>({}));if(!res.ok)throw new Error(data.error||'Unable to reconcile supplier invoice');return data;}
const status=(s,fail=false)=>{const el=overlay?.querySelector('.tt-ir__status');if(el){el.textContent=s;el.classList.toggle('is-error',fail)}};
function close(){overlay?.remove();overlay=null;info=null;selectedInvoice=null;retry=null;}
function poId(){
 const n=Number(document.querySelector('#tt-rr-po')?.value||0);
 return Number.isSafeInteger(n)&&n>0?n:null;
}
function layout(){
 return '<div class="tt-ir__shade" data-close></div><section class="tt-ir__panel" role="dialog" aria-modal="true" aria-labelledby="tt-ir-title">'
 +'<header class="tt-ir__header"><div><span>RECEIVING / 3-WAY MATCH</span><h2 id="tt-ir-title">Link supplier invoice</h2><p>Match the supplier bill to the actual goods receipt, not just to the purchase order.</p></div><button type="button" class="secondary" data-close aria-label="Close invoice matching">×</button></header>'
 +'<div class="tt-ir__body"><p class="tt-ir__status" role="status">Loading available invoices and delivery receipts…</p><div id="tt-ir-detail"></div></div></section>';
}
function options(items,value,empty='Choose posted supplier invoice'){
 return '<option value="">'+esc(empty)+'</option>'+items.map(x=>'<option value="'+x.id+'"'+(String(x.id)===String(value)?' selected':'')+'>'+esc(x.invoice_number)+' · '+money(x.subtotal)+' · '+esc(x.purchase_order_id?'Linked to this PO':'Not yet assigned to a PO')+'</option>').join('');
}
function invoiceDetail(){
 if(!info)return'';
 const inv=info.invoices.find(x=>String(x.id)===String(selectedInvoice));
 const linked=inv?info.links.filter(x=>Number(x.supplier_invoice_id)===Number(inv.id)):[];
 const parts=info.receipt_items.filter(x=>Number(x.remaining_qty)>0);
 const receiptRows=parts.map(x=>'<tr><td><strong>'+esc(x.receipt_number)+'</strong><small>'+esc(String(x.received_at||'').slice(0,16))+'</small></td>'
 +'<td>'+esc(x.product_name||x.sku||'Item')+'<small>'+esc(x.sku||'')+'</small></td><td>'+esc(x.remaining_qty)+' of '+esc(x.quantity_received)+'</td>'
 +'<td><input type="number" min="0" step="any" max="'+esc(x.remaining_qty)+'" name="qty" data-item="'+x.receipt_item_id+'" value="0" aria-label="Billed quantity for '+esc(x.sku||x.product_name||'item')+'"></td>'
 +'<td><input type="number" min="0" step="0.01" name="cost" data-item="'+x.receipt_item_id+'" value="'+esc(Number(x.unit_cost).toFixed(2))+'" aria-label="Invoiced unit cost for '+esc(x.sku||x.product_name||'item')+'"></td></tr>').join('');
 const linkedRows=linked.map(l=>{
  const line=info.receipt_items.find(x=>Number(x.receipt_item_id)===Number(l.purchase_receipt_item_id));
  return '<div class="tt-ir__linked"><span>'+esc(line?.receipt_number||'Receipt')+' · '+esc(line?.product_name||'Item')+' · '+esc(l.quantity_invoiced)+' units</span><b>'+money(Number(l.invoice_line_cents)/100)+'</b></div>';
 }).join('');
 return '<div class="tt-ir__summary"><div><span>Purchase order</span><strong>'+esc(info.po.po_number)+'</strong></div><div><span>Receipts recorded</span><strong>'+new Set(info.receipt_items.map(x=>x.receipt_id)).size+'</strong></div><div><span>Invoices to reconcile</span><strong>'+info.invoices.length+'</strong></div></div>'
 +'<label class="tt-ir__choose">Posted supplier invoice<select id="tt-ir-invoice">'+options(info.invoices,selectedInvoice)+'</select></label>'
 +(inv?'<div class="tt-ir__invoice"><span>Invoice '+esc(inv.invoice_number)+' · current match: <strong>'+esc(inv.match_status)+'</strong></span><div><span>Invoice merchandise</span><strong>'+money(inv.subtotal)+'</strong></div><div><span>Previously linked</span><strong>'+money(Number(inv.allocated_cents)/100)+'</strong></div><div><span>Unmatched amount</span><strong>'+money(Number(inv.unmatched_subtotal_cents)/100)+'</strong></div></div>'
 +'<p class="tt-ir__hint">Enter only the units this invoice bills for. The same invoice can cover multiple receipts. A partial or cost-different match remains under review and is not automatically payment-cleared.</p>'
 +(parts.length?'<form id="tt-ir-match"><div class="tt-ir__tablewrap"><table><thead><tr><th>Goods receipt</th><th>Item</th><th>Unbilled quantity</th><th>Invoiced qty</th><th>Invoice unit cost (JMD)</th></tr></thead><tbody>'+receiptRows+'</tbody></table></div><div class="tt-ir__footer"><span id="tt-ir-preview">No receipt lines selected</span><button type="submit">Link invoice to received goods</button></div></form>':'<p class="tt-ir__empty">No unbilled receipt quantities remain. Confirm existing allocations or contact finance if corrections are needed.</p>')
 +(linkedRows?'<h3>Already linked evidence</h3><div class="tt-ir__linkedlist">'+linkedRows+'</div>':'')
 +'<p class="tt-ir__hint">If quantities or costs do not match, the discrepancy must be reviewed in Accounts Payable before payment. These links never change retail stock or selling prices.</p>'
 :'<p class="tt-ir__empty">'+(info.invoices.length?'Choose an invoice to link to delivered items.':'No posted supplier invoices found for this supplier and PO. Post the supplier invoice in Supplier Bills & Payments first, then return here to match its delivery lines.')+'</p>')
 +'<p class="tt-ir__hint">Original scanned PDFs and images require approved private, durable storage. This screen links invoice records and receiving evidence; it does not claim a file has been uploaded.</p>';
}
function currentLines(form){
 return [...form.querySelectorAll('input[name=qty]')].map(el=>{
  const quantity=Number(el.value),cost=form.querySelector('input[name=cost][data-item="'+el.dataset.item+'"]');
  return{receipt_item_id:Number(el.dataset.item),quantity_invoiced:el.value,invoice_unit_cost:cost?.value,quantityNumber:quantity,costNumber:Number(cost?.value)};
 }).filter(x=>x.quantityNumber>0);
}
function updatePreview(){
 const form=overlay?.querySelector('#tt-ir-match');if(!form)return;
 const selected=currentLines(form);
 const sum=selected.reduce((s,x)=>s+Math.round(x.quantityNumber*Math.round(x.costNumber*100)),0);
 const inv=info.invoices.find(x=>String(x.id)===String(selectedInvoice));
 const current=Number(inv?.allocated_cents||0);
 const label=selected.length?selected.length+' receipt lines · '+money(sum/100)+' now · '+money((sum+current)/100)+' total matched':'No receipt lines selected';
 overlay.querySelector('#tt-ir-preview').textContent=label;
}
function render(){
 if(!overlay)return;
 overlay.querySelector('#tt-ir-detail').innerHTML=invoiceDetail();
 overlay.querySelector('#tt-ir-invoice')?.addEventListener('change',e=>{selectedInvoice=e.target.value;retry=null;render()});
 const form=overlay.querySelector('#tt-ir-match');
 if(form){
  form.addEventListener('input',()=>{retry=null;updatePreview()});
  form.addEventListener('submit',async e=>{
   e.preventDefault();
   if(!selectedInvoice)return status('Choose an invoice.',true);
   const lines=currentLines(form);
   if(!lines.length)return status('Enter a positive billed quantity for at least one goods receipt line.',true);
   for(const l of lines){
    const found=info.receipt_items.find(x=>Number(x.receipt_item_id)===l.receipt_item_id);
    if(!found||!Number.isFinite(l.quantityNumber)||l.quantityNumber>Number(found.remaining_qty)+1e-6)return status('Quantity cannot exceed the available received units.',true);
   }
   if(!retry)retry='invoice-receipt-'+(globalThis.crypto?.randomUUID?.()||String(Date.now())+String(Math.random()).slice(2));
   const btn=form.querySelector('button[type=submit]');btn.disabled=true;status('Saving receipt-to-invoice evidence…');
   try{
    const resp=await get('/orders/'+info.po.id+'/invoices/'+selectedInvoice+'/allocate',{method:'POST',headers:{'Idempotency-Key':retry},body:JSON.stringify({lines:lines.map(x=>({receipt_item_id:x.receipt_item_id,quantity_invoiced:x.quantity_invoiced,invoice_unit_cost:x.invoice_unit_cost}))})});
    retry=null;info=await get('/orders/'+info.po.id);status(resp.payment_cleared?'Invoice matches recorded receipts and is payment-eligible.':'Invoice linked. Quantity or unit-cost variance requires Finance review before payment.');
    render();
   }catch(err){status(err.message,true);}finally{btn.disabled=false;}
  });
  updatePreview();
 }
}
async function open(orderId){
 const n=Number(orderId||poId());
 if(!Number.isSafeInteger(n)||n<=0){return window.TotalToolsShellUI?.toast?.('Select or open a purchase order before linking its invoice.','error');}
 close();overlay=document.createElement('div');overlay.className='tt-ir';overlay.innerHTML=layout();document.body.appendChild(overlay);
 overlay.querySelectorAll('[data-close]').forEach(x=>x.onclick=close);
 overlay.querySelector('.tt-ir__panel').onkeydown=e=>{if(e.key==='Escape')close()};
 try{info=await get('/orders/'+n);status('Use an existing supplier invoice and match its received lines.');render();}
 catch(e){status(e.message,true);}
}
function launch(){
 const host=document.querySelector('.tt-rr__panel .tt-rr__search');
 if(!host||host.querySelector('.tt-ir-launch'))return;
 const btn=document.createElement('button');btn.type='button';btn.className='tt-ir-launch';btn.textContent='Link supplier invoice';
 btn.addEventListener('click',()=>open());host.appendChild(btn);
}
window.TotalToolsInvoiceReceiptMatching={open,close};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>{new MutationObserver(launch).observe(document.body,{childList:true,subtree:true});launch()},{once:true});
else{new MutationObserver(launch).observe(document.body,{childList:true,subtree:true});launch()}
})();