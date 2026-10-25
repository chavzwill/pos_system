(()=>{'use strict';
const base='/api/purchase-orders/receiving-controls/invoice-receipts';
let overlay=null,info=null,selectedInvoice=null,retry=null,captureRetry=null,saving=false,dirty=false,unknown=false,capturePayload=null,acknowledged=false,allocationOperation=null,pendingKind=null;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','"':'&quot;',"'":'&#39;'}[c]));
const money=v=>new Intl.NumberFormat('en-JM',{style:'currency',currency:'JMD'}).format(Number(v)||0);
async function get(path,options={}){const res=await fetch(path.startsWith('/api/')?path:base+path,{...options,credentials:'same-origin',headers:{Accept:'application/json','Content-Type':'application/json',...(options.headers||{})}});const data=await res.json().catch(()=>({}));if(!res.ok){const error=new Error(data.error||'Unable to reconcile supplier invoice');error.status=res.status;throw error;}return data;}
const status=(s,fail=false)=>{const el=overlay?.querySelector('.tt-ir__status');if(el){el.textContent=s;el.classList.toggle('is-error',fail)}};
function close(){keepInvoiceDraft();overlay?.remove();overlay=null;info=null;selectedInvoice=null;retry=null;captureRetry=null;saving=false;dirty=false;unknown=false;capturePayload=null;acknowledged=false;allocationOperation=null;pendingKind=null;}
function poId(){
 const n=Number(document.querySelector('#tt-rr-po')?.value||0);
 return Number.isSafeInteger(n)&&n>0?n:null;
}
function layout(){
 return '<div class="tt-ir__shade" data-close></div><section class="tt-ir__panel" role="dialog" aria-modal="true" aria-labelledby="tt-ir-title">'
 +'<header class="tt-ir__header"><div><span>RECEIVING / 3-WAY MATCH</span><h2 id="tt-ir-title">Link supplier invoice</h2><p>Match the supplier bill to the actual goods receipt, not just to the purchase order.</p></div><button type="button" class="secondary" data-close aria-label="Close invoice matching">×</button></header>'
 +'<div class="tt-ir__body"><p class="tt-ir__status" role="status">Loading available invoices and delivery receipts…</p><div id="tt-ir-detail"></div></div></section>';
}
function options(items,value,empty='Choose captured or posted invoice'){
 return '<option value="">'+esc(empty)+'</option>'+items.map(x=>'<option value="'+x.id+'"'+(String(x.id)===String(value)?' selected':'')+'>'+esc(x.invoice_number)+' · '+money(x.subtotal)+' · '+esc(x.capture_id?'Captured — not posted':'Posted to AP')+'</option>').join('');
}
async function loadInfo(orderId){
 const result=await get('/orders/'+orderId);
 const captured=(result.captured_invoices||[]).map(x=>({...x,id:'capture-'+x.id,capture_id:x.id,match_status:'Not posted to AP',purchase_order_id:orderId,unmatched_subtotal_cents:Math.round(Number(x.subtotal)*100)-Number(x.allocated_cents)}));
 result.invoices=[...captured,...result.invoices];
 result.links=[...(result.captured_links||[]).map(x=>({...x,supplier_invoice_id:'capture-'+x.captured_invoice_id})),...result.links];
 return result;
}
function captureForm(){
 if(!info.can_capture)return '';
 const field=(name,label,type='text',required=false)=>'<label>'+label+'<input name="'+name+'" type="'+type+'"'+(required?' required':'')+(type==='number'?' min="0" step="0.01" value="0"':'')+(name==='invoice_date'?' value="'+new Date().toLocaleDateString('en-CA',{timeZone:'America/Jamaica'})+'"':'')+'></label>';
 return '<details class="tt-ir__capture"><summary>Capture a supplier invoice</summary><p class="tt-ir__hint">Record the bill when it arrives. Capturing does not receive goods or post a payable.</p>'
 +'<form id="tt-ir-capture"><div class="tt-ir__fields">'+field('invoice_number','Invoice number','text',true)+field('invoice_date','Invoice date','date',true)+field('due_date','Due date','date')
 +field('subtotal','Merchandise subtotal (JMD)','number',true)+field('tax_amount','Tax (JMD)','number')+field('freight_amount','Freight (JMD)','number')+field('duty_amount','Duty (JMD)','number')+field('other_landed_cost_amount','Other landed costs (JMD)','number')
 +'<label>Tax treatment<select name="tax_treatment"><option value="">Choose when tax is billed</option><option value="recoverable">Recoverable</option><option value="landed_cost">Landed cost</option><option value="expense">Expense</option></select></label></div><label>Notes<textarea name="notes" maxlength="4000" rows="2"></textarea></label>'
 +'<div class="tt-ir__footer"><span id="tt-ir-capture-total">Invoice total: '+money(0)+'</span><button type="submit">Save captured invoice</button></div></form></details>';
}
function postingActions(inv){
 if(!inv?.capture_id)return '';
 return '<div class="tt-ir__posting"><h3>Captured — not posted to Accounts Payable</h3><p class="tt-ir__hint">Receipt matching records delivery evidence. Finance must separately post this invoice before it becomes a payable.</p>'
 +(info.can_post?'<form id="tt-ir-post"><label>Posting exception reason, if needed<input name="match_override_reason" maxlength="1000" placeholder="Explain any PO or receipt value exception"></label><button type="submit">Post invoice to Accounts Payable</button></form>':'<p>Awaiting Finance posting.</p>')
 +(info.can_capture?'<details><summary>Correct a captured invoice</summary><p class="tt-ir__hint">Void an incorrect capture, then record its replacement. Its history will be kept.</p><form id="tt-ir-void"><label>Reason<input name="reason" required minlength="5" maxlength="1000"></label><button type="submit" class="secondary">Void captured invoice</button></form></details>':'')+'</div>';
}
function invoiceDetail(){
 if(!info)return'';
 const inv=info.invoices.find(x=>String(x.id)===String(selectedInvoice));
 const linked=inv?info.links.filter(x=>String(x.supplier_invoice_id)===String(inv.id)):[];
 const parts=info.receipt_items.filter(x=>Number(x.remaining_qty)>0);
 const receiptRows=parts.map(x=>'<tr data-delivery="'+esc(x.receipt_id)+'" data-search="'+esc([x.receipt_number,x.product_name,x.sku].join(' ').toLowerCase())+'"><td><strong>'+esc(x.receipt_number)+'</strong><small>'+esc(String(x.received_at||'').slice(0,16))+'</small></td>'
 +'<td>'+esc(x.product_name||x.sku||'Item')+'<small>'+esc(x.sku||'')+'</small></td><td>'+esc(x.remaining_qty)+' of '+esc(x.quantity_received)+'</td>'
 +'<td><input type="number" min="0" step="any" max="'+esc(x.remaining_qty)+'" name="qty" data-item="'+x.receipt_item_id+'" value="0" aria-label="Billed quantity for '+esc(x.sku||x.product_name||'item')+'"></td>'
 +'<td><input type="number" min="0" step="0.01" name="cost" data-item="'+x.receipt_item_id+'" value="'+esc(Number(x.unit_cost).toFixed(2))+'" aria-label="Invoiced unit cost for '+esc(x.sku||x.product_name||'item')+'"></td></tr>').join('');
 const linkedRows=linked.map(l=>{
  const line=info.receipt_items.find(x=>Number(x.receipt_item_id)===Number(l.purchase_receipt_item_id));
  return '<div class="tt-ir__linked"><span>'+esc(line?.receipt_number||'Receipt')+' · '+esc(line?.product_name||'Item')+' · '+esc(l.quantity_invoiced)+' units</span><b>'+money(Number(l.invoice_line_cents)/100)+'</b></div>';
 }).join('');
 return '<div class="tt-ir__summary"><div><span>Purchase order</span><strong>'+esc(info.po.po_number)+'</strong></div><div><span>Receipts recorded</span><strong>'+new Set(info.receipt_items.map(x=>x.receipt_id)).size+'</strong></div><div><span>Invoices to reconcile</span><strong>'+info.invoices.length+'</strong></div></div>'
 +captureForm()+'<label class="tt-ir__choose">Supplier invoice<select id="tt-ir-invoice">'+options(info.invoices,selectedInvoice)+'</select></label>'
 +(inv?'<div class="tt-ir__invoice"><span>Invoice '+esc(inv.invoice_number)+' · current match: <strong>'+esc(inv.match_status)+'</strong></span><div><span>Invoice merchandise</span><strong>'+money(inv.subtotal)+'</strong></div><div><span>Previously linked</span><strong>'+money(Number(inv.allocated_cents)/100)+'</strong></div><div><span>Unmatched amount</span><strong>'+money(Number(inv.unmatched_subtotal_cents)/100)+'</strong></div></div>'
 +'<p class="tt-ir__boundary">'+esc(inv.capture_id?'Captured invoice · no payable posted':'Posted invoice · already in Accounts Payable')+'</p><p class="tt-ir__hint">Enter only the units this invoice bills for. The same invoice can cover multiple receipts. A partial or cost-different match remains under review and is not automatically payment-cleared.</p>'
 +(parts.length?'<form id="tt-ir-match"><div class="tt-ir__filters"><label>Delivery<select id="tt-ir-delivery"><option value="">All deliveries</option>'+[...new Map(parts.map(x=>[String(x.receipt_id),x.receipt_number])).entries()].map(([id,name])=>'<option value="'+esc(id)+'">'+esc(name)+'</option>').join('')+'</select></label><label>Find received item<input id="tt-ir-find" type="search" placeholder="Item, SKU or receipt number"></label></div><p id="tt-ir-filter-count" class="tt-ir__hint" role="status"></p><div class="tt-ir__tablewrap"><table><thead><tr><th>Goods receipt</th><th>Item</th><th>Unbilled quantity</th><th>Invoiced qty</th><th>Invoice unit cost (JMD)</th></tr></thead><tbody>'+receiptRows+'</tbody></table></div><div class="tt-ir__footer"><span id="tt-ir-preview">No receipt lines selected</span><button type="submit">Link invoice to received goods</button></div></form>':'<p class="tt-ir__empty">No unbilled receipt quantities remain. Confirm existing allocations or contact finance if corrections are needed.</p>')
 +(linkedRows?'<h3>Already linked evidence</h3><div class="tt-ir__linkedlist">'+linkedRows+'</div>':'')
 +postingActions(inv)+'<p class="tt-ir__hint">If quantities or costs do not match, the discrepancy must be reviewed in Accounts Payable before payment. These links never change retail stock or selling prices.</p>'
 :'<p class="tt-ir__empty">'+(info.invoices.length?'Choose an invoice to link to delivered items.':'No supplier invoices found for this PO. Capture the invoice above, then match its delivery lines. Finance posting is a separate action.')+'</p>')
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
 const remaining=Number(inv?.unmatched_subtotal_cents||0)-sum;
 const preview=overlay.querySelector('#tt-ir-preview');preview.textContent=label+(selected.length?' · '+(remaining<0?'Exceeds unmatched merchandise by '+money(-remaining/100):'Remaining merchandise '+money(remaining/100)):'');preview.classList.toggle('is-variance',remaining<0);
 form.querySelector('button[type=submit]').disabled=!selected.length;
}
function render(){
 if(!overlay)return;
 overlay.querySelector('#tt-ir-detail').innerHTML=invoiceDetail();
 bindCaptureAndPosting();
 overlay.querySelector('#tt-ir-invoice')?.addEventListener('change',e=>{if(dirty||unknown){e.target.value=selectedInvoice||'';return status('Finish this entry or clear its unsaved fields before changing invoice.',true);}selectedInvoice=e.target.value;retry=null;render()});
 const form=overlay.querySelector('#tt-ir-match');
 if(form){
  const filter=()=>{const receipt=form.querySelector('#tt-ir-delivery').value,q=form.querySelector('#tt-ir-find').value.trim().toLowerCase();let count=0;form.querySelectorAll('tr[data-delivery]').forEach(row=>{row.hidden=!!((receipt&&row.dataset.delivery!==receipt)||(q&&!row.dataset.search.includes(q)));if(!row.hidden)count++;});form.querySelector('#tt-ir-filter-count').textContent=count+' received lines shown. Selections in other deliveries are retained.';};
  form.querySelector('#tt-ir-delivery').addEventListener('change',filter);form.querySelector('#tt-ir-find').addEventListener('input',filter);filter();
  form.addEventListener('input',e=>{if(e.target.name){dirty=true;if(!unknown){retry=null;allocationOperation=null;pendingKind=null;}}updatePreview()});
  form.addEventListener('submit',async e=>{
   e.preventDefault();
   if(unknown&&allocationOperation)return performAllocation();
   if(!selectedInvoice)return status('Choose an invoice.',true);
   const lines=currentLines(form);
   if(!lines.length)return status('Enter a positive billed quantity for at least one goods receipt line.',true);
   for(const l of lines){
    const found=info.receipt_items.find(x=>Number(x.receipt_item_id)===l.receipt_item_id);
    if(!unknown&&(!found||!Number.isFinite(l.quantityNumber)||l.quantityNumber>Number(found.remaining_qty)+1e-6))return status('Quantity cannot exceed the available received units.',true);
   }
   if(!retry)retry='invoice-receipt-'+(globalThis.crypto?.randomUUID?.()||String(Date.now())+String(Math.random()).slice(2));
   const inv=info.invoices.find(x=>String(x.id)===String(selectedInvoice));
   allocationOperation={key:retry,captured:!!inv?.capture_id,endpoint:inv?.capture_id?'/api/supplier-ledger/captured-invoices/'+inv.capture_id+'/allocate':'/orders/'+info.po.id+'/invoices/'+selectedInvoice+'/allocate',body:JSON.stringify({lines:lines.map(x=>({receipt_item_id:x.receipt_item_id,quantity_invoiced:x.quantity_invoiced,invoice_unit_cost:x.invoice_unit_cost}))})};
   await performAllocation();
  });
  updatePreview();
 }else if(unknown&&allocationOperation){const button=document.createElement('button');button.type='button';button.textContent='Link invoice to received goods';button.onclick=performAllocation;overlay.querySelector('#tt-ir-detail').prepend(button);}
}
async function performAllocation(){if(!allocationOperation||!beginInvoice('allocate'))return;const op=allocationOperation;const btn=overlay.querySelector('#tt-ir-match [type=submit]');if(btn)btn.disabled=true;status('Checking the original receipt-to-invoice operation…');try{keepInvoiceDraft();await window.TotalToolsWorkProtection?.checkpoint?.('invoice-'+info.po.id);const resp=await get(op.endpoint,{method:'POST',headers:{'Idempotency-Key':op.key},body:op.body});if(!resp.id&&!resp.invoice_id)throw new Error('Matching confirmation was not received');acknowledged=true;info=await loadInfo(info.po.id);retry=null;invoiceSaved();status(op.captured?'Delivery evidence saved. Invoice remains captured and unposted.':resp.payment_cleared?'Invoice matches recorded receipts and is payment-eligible.':'Invoice linked. Quantity or unit-cost variance requires Finance review before payment.');render();}catch(error){invoiceFailed(error);}finally{if(btn)btn.disabled=false;finishInvoice();}}
function bindCaptureAndPosting(){
 const capture=overlay.querySelector('#tt-ir-capture');
 if(capture){
  const amounts=['subtotal','tax_amount','freight_amount','duty_amount','other_landed_cost_amount'];
  const values=()=>Object.fromEntries(new FormData(capture));
  const sum=data=>amounts.reduce((total,name)=>total+Math.round(Number(data[name]||0)*100),0)/100;
  capture.addEventListener('input',()=>{dirty=true;if(!unknown){captureRetry=null;capturePayload=null;}overlay.querySelector('#tt-ir-capture-total').textContent='Invoice total: '+money(sum(values()));});
  capture.addEventListener('submit',async e=>{
   e.preventDefault();if(!beginInvoice('capture'))return;const btn=capture.querySelector('button');btn.disabled=true;
   if(!captureRetry)captureRetry='capture-'+crypto.randomUUID();
   try{
    const data=capturePayload||values();data.purchase_order_id=info.po.id;data.total=sum(data);capturePayload=data;
    keepInvoiceDraft();await window.TotalToolsWorkProtection?.checkpoint?.('invoice-'+info.po.id);const saved=await get('/api/supplier-ledger/captured-invoices',{method:'POST',headers:{'Idempotency-Key':captureRetry},body:JSON.stringify(data)});
    if(!saved.id)throw new Error('Invoice confirmation was not received');acknowledged=true;info=await loadInfo(info.po.id);selectedInvoice='capture-'+saved.id;captureRetry=null;capturePayload=null;invoiceSaved();render();status('Invoice captured. Stock and Accounts Payable are unchanged.');
   }catch(err){invoiceFailed(err);}finally{btn.disabled=false;finishInvoice();}
  });
 }
 const inv=info.invoices.find(x=>String(x.id)===String(selectedInvoice));
 const post=overlay.querySelector('#tt-ir-post');
 post?.addEventListener('submit',async e=>{
  e.preventDefault();if(!beginInvoice('post'))return;const btn=post.querySelector('button');btn.disabled=true;status('Finance is posting the captured invoice…');
  try{
   keepInvoiceDraft();await window.TotalToolsWorkProtection?.checkpoint?.('invoice-'+info.po.id);const result=await get('/api/supplier-ledger/invoices',{method:'POST',body:JSON.stringify({captured_invoice_id:inv.capture_id,match_override_reason:new FormData(post).get('match_override_reason')})});
   if(!result.id)throw new Error('Posting confirmation was not received');acknowledged=true;info=await loadInfo(info.po.id);selectedInvoice=result.id;invoiceSaved();render();status('Invoice posted to Accounts Payable. '+(result.invoice_match_status==='matched'?'Delivery evidence matches.':'Check match status before payment.'));
  }catch(err){invoiceFailed(err);}finally{btn.disabled=false;finishInvoice();}
 });
 const voidForm=overlay.querySelector('#tt-ir-void');
 voidForm?.addEventListener('submit',async e=>{
  e.preventDefault();if(!beginInvoice('void'))return;const btn=voidForm.querySelector('button');btn.disabled=true;
  try{keepInvoiceDraft();await window.TotalToolsWorkProtection?.checkpoint?.('invoice-'+info.po.id);await get('/api/supplier-ledger/captured-invoices/'+inv.capture_id+'/void',{method:'POST',body:JSON.stringify({reason:new FormData(voidForm).get('reason')})});selectedInvoice=null;info=await loadInfo(info.po.id);invoiceSaved();render();status('Captured invoice voided. Its delivery quantities are available for matching again.');}
  catch(err){invoiceFailed(err);}finally{btn.disabled=false;finishInvoice();}
 });
}
async function open(orderId){
 const n=Number(orderId||poId());
 if(!Number.isSafeInteger(n)||n<=0){return window.TotalToolsShellUI?.toast?.('Select or open a purchase order before linking its invoice.','error');}
 close();overlay=document.createElement('div');overlay.className='tt-ir';overlay.innerHTML=layout();document.body.appendChild(overlay);
 overlay.querySelectorAll('[data-close]').forEach(x=>x.onclick=close);
 overlay.querySelector('.tt-ir__panel').onkeydown=e=>{if(e.key==='Escape')close()};
 try{await window.TotalToolsWorkProtection?.ready?.();info=await loadInfo(n);const draft=window.TotalToolsWorkProtection?.take('invoice-'+n);if(draft){selectedInvoice=draft.selectedInvoice;retry=draft.retry;captureRetry=draft.captureRetry;capturePayload=draft.capturePayload;allocationOperation=draft.allocationOperation||null;pendingKind=draft.pendingKind||null;dirty=true;unknown=draft.unknown;acknowledged=!!draft.acknowledged;}status('Capture the supplier invoice or select an existing bill, then match received lines.');render();if(draft){for(const field of draft.fields){const form=overlay.querySelector('#'+field.form);const el=[...(form?.querySelectorAll('[name]')||[])].find(el=>el.name===field.name&&(el.dataset.item||'')===field.item);if(el)el.value=field.value;}overlay.querySelector('#tt-ir-capture')?.dispatchEvent(new Event('input',{bubbles:true}));updatePreview();finishInvoice();if(!unknown)status('Resumed invoice entries from your saved draft. Check the current delivery evidence before saving.');}protectInvoice();overlay.querySelector('[data-close][aria-label]')?.focus();}
 catch(e){status(e.message,true);}
}

function keepInvoiceDraft(){if(!info||(!dirty&&!unknown&&!saving)||!overlay)return;const fields=[...overlay.querySelectorAll('form input[name],form select[name],form textarea[name]')].map(el=>({form:el.closest('form').id,name:el.name,item:el.dataset.item||'',value:el.value}));window.TotalToolsWorkProtection?.put('invoice-'+info.po.id,{selectedInvoice,retry,captureRetry,capturePayload,allocationOperation,pendingKind,fields,unknown:unknown||saving,acknowledged});}
function protectInvoice(){if(!overlay)return;const label=document.createElement('p');label.className='tt-ir__hint';label.dataset.draftStatusKey='invoice-'+info.po.id;label.setAttribute('role','status');label.textContent=window.TotalToolsWorkProtection?.status?.(label.dataset.draftStatusKey)||'';overlay.querySelector('.tt-ir__body').prepend(label);window.TotalToolsWorkProtection?.watch(overlay,{dirty:()=>dirty||unknown||saving,saving:()=>saving,keep:keepInvoiceDraft});overlay.addEventListener('input',e=>{if(e.target.name)dirty=true});const button=document.createElement('button');button.type='button';button.className='secondary';button.textContent='Clear unsaved entries';button.onclick=async()=>{if(saving)return;const ok=await window.TotalToolsShellUI?.confirm?.({title:'Clear unsaved invoice entries?',message:unknown?'A submission may already exist. Check the invoice and receipt history before starting again. This clears only the saved draft.':'Clear entered invoice and match quantities? Recorded invoices and links remain unchanged.',confirmLabel:'Clear entries',cancelLabel:'Keep editing'});if(ok){window.TotalToolsWorkProtection?.clear('invoice-'+info.po.id);dirty=false;unknown=false;acknowledged=false;retry=null;captureRetry=null;capturePayload=null;allocationOperation=null;pendingKind=null;render();status('Unsaved entries cleared. Recorded evidence is unchanged.');}};overlay.querySelector('.tt-ir__header').append(button);}
function beginInvoice(kind){if(saving)return false;if(unknown&&pendingKind&&kind!==pendingKind){status('Resolve the original submission before starting another invoice action.',true);return false;}pendingKind=kind;saving=true;dirty=true;overlay.querySelector('.tt-ir__body').inert=true;return true;}
function finishInvoice(){saving=false;if(!overlay)return;overlay.querySelector('.tt-ir__body').inert=false;if(unknown){overlay.querySelectorAll('form input,form textarea').forEach(x=>x.readOnly=true);overlay.querySelectorAll('form select').forEach(x=>x.disabled=true);if(pendingKind){const original={allocate:'tt-ir-match',capture:'tt-ir-capture',post:'tt-ir-post',void:'tt-ir-void'}[pendingKind];overlay.querySelectorAll('form button').forEach(x=>{if(x.closest('form').id!==original)x.disabled=true;});}status(acknowledged?'Submission confirmed, but refreshed evidence is unavailable. Entries are locked; retry reuses the original operation.':'Submission outcome unknown. Entries are locked; retry reuses the original operation. Check invoice and delivery history before clearing this draft.',true);}keepInvoiceDraft();}
function invoiceFailed(error){if(!error.status||error.status>=500)unknown=true;status(unknown?'Submission outcome unknown. Keep this draft and check its original operation before creating another entry.':error.message,true);}
function invoiceSaved(){pendingKind=null;allocationOperation=null;dirty=false;unknown=false;acknowledged=false;window.TotalToolsWorkProtection?.clear('invoice-'+info.po.id);}

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