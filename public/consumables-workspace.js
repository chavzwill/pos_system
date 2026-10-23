(()=>{'use strict';
const state={open:false,tab:'orders',profile:null,orders:[],catalog:[],balances:[],usage:[],lookups:null,selected:null,form:null,submittedKey:null};
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','"':'&quot;',"'":'&#39;'}[c]));
const money=cents=>new Intl.NumberFormat('en-JM',{style:'currency',currency:'JMD'}).format(Number(cents||0)/100);
const fmt=n=>new Intl.NumberFormat('en-JM').format(Number(n||0));
const toast=(s,t='info')=>window.TotalToolsShellUI?.toast?.(s,t)||console.log(s);
const api=async(path,opt={})=>{const r=await fetch('/api/consumables'+path,{credentials:'same-origin',headers:{'Content-Type':'application/json',...(opt.headers||{})},...opt});const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.error||'Request failed');return data};
const root=()=>{let el=document.getElementById('tt-consumables');if(!el){el=document.createElement('div');el.id='tt-consumables';el.className='tt-consumables';document.body.appendChild(el)}return el};
function close(){document.getElementById('tt-consumables')?.remove();state.open=false;state.form=null;state.selected=null}
function opts(rows,value,placeholder='Select…'){return '<option value="">'+esc(placeholder)+'</option>'+rows.map(x=>'<option value="'+x.id+'"'+(String(x.id)===String(value)?' selected':'')+'>'+esc(x.name+(x.sku?' · '+x.sku:''))+'</option>').join('')}
function targetOptions(kind,selected){const lookups=state.lookups||{},rows=kind==='department'?lookups.departments||[]:kind==='rental'?lookups.rental_equipment||[]:lookups.branches||[];return opts(rows,selected,kind==='rental'?'Choose rental equipment':'Choose allocation')}
function lineOptions(value){return opts(state.catalog.filter(x=>x.active!==0),value,'Choose consumable')}
async function load(){
 if(!state.profile)state.profile=await fetch('/api/workspace-profile/me',{credentials:'same-origin'}).then(x=>x.json());
 const [orders,catalog,balances,usage,lookups]=await Promise.all([api('/orders'),api('/catalog'),api('/balances'),api('/usage'),api('/lookups')]);
 Object.assign(state,{orders,catalog,balances,usage,lookups});
 if(state.selected){const found=orders.find(x=>x.id===state.selected.id);if(!found)state.selected=null;}
}
function layout(){
 const pending=state.orders.filter(x=>['draft','submitted','approved','partial'].includes(x.status)).length,amount=state.balances.reduce((a,b)=>a+Number(b.value_cents),0);
 return '<div class="ttc-shade" data-close></div><section class="ttc-panel" role="dialog" aria-modal="true" aria-labelledby="ttc-heading">'
 +'<header class="ttc-header"><div><span class="ttc-kicker">TOTAL TOOLS / OPERATIONS</span><h2 id="ttc-heading">Consumables control</h2><p>Purchase · receive · allocate · track usage. Independent of retail stock.</p></div><button type="button" class="ttc-icon" data-close aria-label="Close consumables workspace">×</button></header>'
 +'<div class="ttc-metrics"><div><span>Open consumable POs</span><strong>'+fmt(pending)+'</strong></div><div><span>Stock value</span><strong>'+money(amount)+'</strong></div><div><span>Types tracked</span><strong>'+fmt(state.catalog.length)+'</strong></div><div><span>Usage entries</span><strong>'+fmt(state.usage.length)+'</strong></div></div>'
 +'<nav class="ttc-tabs" aria-label="Consumables"><button data-tab="orders" aria-pressed="'+(state.tab==='orders')+'">Purchase orders</button><button data-tab="stock" aria-pressed="'+(state.tab==='stock')+'">Balances</button><button data-tab="usage" aria-pressed="'+(state.tab==='usage')+'">Usage ledger</button></nav>'
 +'<div class="ttc-content">'+(state.tab==='orders'?ordersView():state.tab==='stock'?stockView():usageView())+'</div>'
 +(state.form?formView():'')+'</section>';
}
function ordersView(){
 return '<div class="ttc-actions"><h3>Consumables purchasing</h3><div><button data-new="catalog" class="secondary">New consumable</button><button data-new="order">New consumable PO</button></div></div>'
 +(state.orders.length?'<div class="ttc-records">'+state.orders.map(o=>'<button class="ttc-record'+(state.selected?.id===o.id?' active':'')+'" data-order="'+o.id+'"><span><strong>'+esc(o.po_number)+'</strong><small>'+esc(o.supplier_name)+' · '+esc(o.branch_name)+'</small></span><span><b>'+money(o.total_cents)+'</b><small>'+esc(o.status)+'</small></span></button>').join('')+'</div>':'<div class="ttc-empty">No consumable purchase orders yet. Create your first PO separately from saleable inventory.</div>')
 +(state.selected?details(): '');
}
function details(){
 const o=state.selected;
 const controls=[];
 if(o.status==='draft')controls.push('<button data-order-action="submit">Submit for approval</button>');
 if(o.status==='submitted')controls.push('<button data-order-action="approve">Approve PO</button>');
 if(['approved','partial'].includes(o.status))controls.push('<button data-new="receive">Receive consumables</button>');
 controls.push('<button class="secondary" data-copy-order>Copy to new PO</button>');
 return '<article class="ttc-detail"><div class="ttc-actions"><h3>'+esc(o.po_number)+' <span class="ttc-state">'+esc(o.status)+'</span></h3></div>'
 +'<div class="ttc-brief"><p><strong>Reason</strong> '+esc(o.reason)+'</p><p><strong>Requested for</strong> '+esc(o.requested_for)+'</p><p><strong>Default allocation</strong> '+esc(o.allocation_type)+(o.unit_reference?' · '+esc(o.unit_reference):'')+'</p></div>'
 +'<div class="ttc-table-wrap"><table><thead><tr><th>Consumable</th><th>Ordered</th><th>Received</th><th>Unit cost</th><th>Amount</th></tr></thead><tbody>'
 +(o.items||[]).map(l=>'<tr><td>'+esc(l.name)+' <small>'+esc(l.sku)+'</small></td><td>'+fmt(l.quantity_ordered)+'</td><td>'+fmt(l.quantity_received)+'</td><td>'+money(l.unit_cost_cents)+'</td><td>'+money(Number(l.quantity_ordered)*Number(l.unit_cost_cents))+'</td></tr>').join('')+'</tbody></table></div>'
 +'<div class="ttc-actions ttc-foot"><strong>Total '+money(o.total_cents)+'</strong><div>'+controls.join('')+'</div></div></article>';
}
function stockView(){
 return '<div class="ttc-actions"><h3>Independent consumable stock</h3><button data-new="issue">Record usage / issue</button></div>'
 +'<p class="ttc-subtitle">These quantities never increase retail products or branch sellable inventory.</p>'
 +(state.balances.length?'<div class="ttc-table-wrap"><table><thead><tr><th>Branch</th><th>Consumable</th><th>Unit</th><th>On hand</th><th>Stock value</th></tr></thead><tbody>'
 +state.balances.map(x=>'<tr><td>'+esc(x.branch_name)+'</td><td><strong>'+esc(x.name)+'</strong><small>'+esc(x.sku)+'</small></td><td>'+esc(x.uom)+'</td><td>'+fmt(x.qty_on_hand)+'</td><td>'+money(x.value_cents)+'</td></tr>').join('')+'</tbody></table></div>':'<div class="ttc-empty">No consumables received yet.</div>');
}
function usageView(){
 return '<div class="ttc-actions"><h3>Consumption by allocation</h3><button data-new="issue">Record usage / issue</button></div>'
 +'<p class="ttc-subtitle">A permanent usage log tracks costs by receiving branch, department and rental machine reference.</p>'
 +(state.usage.length?'<div class="ttc-table-wrap"><table><thead><tr><th>Date</th><th>Item</th><th>Branch</th><th>Allocated to</th><th>Issued</th><th>Cost</th><th>Reason</th></tr></thead><tbody>'
 +state.usage.map(x=>'<tr><td>'+esc(String(x.created_at||'').slice(0,16))+'</td><td>'+esc(x.name)+'</td><td>'+esc(x.branch_name)+'</td><td>'+esc(x.department_name||x.rental_equipment_name||'Branch')+(x.rental_unit_reference?'<small>'+esc(x.rental_unit_reference)+'</small>':'')+'</td><td>'+fmt(x.quantity)+'</td><td>'+money(x.value_cents)+'</td><td>'+esc(x.purpose)+'</td></tr>').join('')+'</tbody></table></div>':'<div class="ttc-empty">No issues recorded. Received consumables remain available until explicitly issued.</div>');
}
function allocationFields(o={}){
 const kind=o.allocation_type||'branch';
 return '<label>Allocate use to<select name="allocation_type"><option value="branch"'+(kind==='branch'?' selected':'')+'>Branch operations</option><option value="department"'+(kind==='department'?' selected':'')+'>Department</option><option value="rental"'+(kind==='rental'?' selected':'')+'>Rental equipment</option></select></label>'
 +'<label>Allocation target<select name="allocation_id">'+targetOptions(kind,o.allocation_id||'')+'</select></label>'
 +'<label>Rental machine / serial reference<input name="unit_reference" maxlength="120" placeholder="Required for rental equipment" value="'+esc(o.unit_reference||'')+'"></label>';
}
function orderLine(item={},i=0){
 return '<div class="ttc-line" data-line="'+i+'"><label>Consumable<select name="consumable_id" required>'+lineOptions(item.consumable_id||'')+'</select></label>'
 +'<label>Quantity<input name="quantity" required type="number" min="1" max="1000000" step="1" value="'+esc(item.quantity||1)+'"></label>'
 +'<label>Unit cost (JMD)<input name="unit_cost" required inputmode="decimal" pattern="[0-9]+(\\.[0-9]{1,2})?" value="'+esc(item.unit_cost??0)+'"></label>'
 +'<button type="button" class="ttc-icon" data-remove-line="'+i+'" aria-label="Remove line '+(i+1)+'">×</button></div>';
}
function formView(){
 const f=state.form,kind=f.kind;
 const order=kind==='order',receive=kind==='receive',issue=kind==='issue',catalog=kind==='catalog';
 let fields='';
 if(catalog)fields='<label>SKU / unique consumable code<input required name="sku" maxlength="80" value="'+esc(f.sku||'')+'"></label><label>Name<input required name="name" maxlength="160" value="'+esc(f.name||'')+'"></label><label>Unit of measure<input name="uom" maxlength="32" value="'+esc(f.uom||'each')+'"></label>';
 if(order)fields='<div class="ttc-form-grid"><label>Supplier<select required name="supplier_id">'+opts(state.lookups.suppliers,f.supplier_id)+'</select></label>'
 +'<label>Receiving branch<select required name="branch_id">'+opts(state.lookups.branches,f.branch_id)+'</select></label>'
 +'<label>Reason for purchase<textarea name="reason" required maxlength="600">'+esc(f.reason||'')+'</textarea></label>'
 +'<label>Requested for<input name="requested_for" required maxlength="250" value="'+esc(f.requested_for||'')+'"></label>'
 +allocationFields(f)
 +'<label>Expected delivery<input type="date" name="expected_date" value="'+esc(f.expected_date||'')+'"></label>'
 +'<label>Additional instructions<textarea name="notes" maxlength="2500">'+esc(f.notes||'')+'</textarea></label></div>'
 +'<div class="ttc-form-subhead"><strong>Consumables on this order</strong><button type="button" class="secondary" data-add-line>Add another item</button></div>'
 +'<div class="ttc-lines">'+f.items.map(orderLine).join('')+'</div>';
 if(receive){
  const items=state.selected?.items||[];
  fields='<p>Receive approved quantities into the independent consumables balance. This will not modify POS resale stock.</p>'
  +items.filter(x=>Number(x.quantity_received)<Number(x.quantity_ordered)).map(x=>'<label>'+esc(x.name)+' · Remaining '+fmt(Number(x.quantity_ordered)-Number(x.quantity_received))+'<input type="number" name="qty-'+x.id+'" min="0" step="1" max="'+(Number(x.quantity_ordered)-Number(x.quantity_received))+'" value="0"></label>').join('');
 }
 if(issue)fields='<div class="ttc-form-grid"><label>Source branch<select required name="branch_id">'+opts(state.lookups.branches,f.branch_id)+'</select></label>'
 +'<label>Consumable<select required name="consumable_id">'+opts(state.catalog.filter(x=>x.active!==0),f.consumable_id)+'</select></label>'
 +'<label>Issue quantity<input name="quantity" type="number" min="1" step="1" required></label>'
 +allocationFields(f)
 +'<label class="ttc-wide">Why was this used?<textarea name="purpose" required maxlength="800" placeholder="E.g. chainsaw service / workshop repairs"></textarea></label></div>';
 return '<div class="ttc-form-shade" data-cancel></div><section class="ttc-form-panel" role="dialog" aria-modal="true" aria-label="'+(order?'New consumable purchase order':catalog?'New consumable':receive?'Receive consumables':'Record usage')+'">'
 +'<header><div><span class="ttc-kicker">CONSUMABLES / CONTROLLED ACTION</span><h3>'+(order?'Create consumable PO':catalog?'Register consumable':receive?'Receive approved order':'Issue and allocate')+'</h3></div><button type="button" data-cancel class="ttc-icon" aria-label="Close form">×</button></header>'
 +'<form id="ttc-form">'+fields+'<p class="ttc-error" role="alert" id="ttc-error"></p><footer><button type="button" class="secondary" data-cancel>Cancel</button><button type="submit">'+(order?'Save draft PO':catalog?'Create consumable':receive?'Record receipt':'Record usage')+'</button></footer></form></section>';
}
async function selectOrder(id){state.selected=await api('/orders/'+id);render();}
function editAllocation(form){
 const kind=form.querySelector('[name=allocation_type]')?.value||'branch';
 const control=form.querySelector('[name=allocation_id]');
 if(control)control.innerHTML=targetOptions(kind,'');
 const ref=form.querySelector('[name=unit_reference]');
 if(ref){ref.required=kind==='rental';ref.closest('label').hidden=kind!=='rental';}
 const a=control?.closest('label');if(a)a.hidden=kind==='branch';
}
function newForm(kind,from={}){
 if(kind==='order'&&!state.catalog.length)return toast('Register a consumable before creating an order.','error');
 const branch=state.profile?.employee?.default_branch_id||state.lookups?.branches?.[0]?.id||'';
 state.form={...from,kind,branch_id:from.branch_id||branch,items:from.items||[{consumable_id:'',quantity:1,unit_cost:0}]};
 state.submittedKey=null;render();
}
function render(){
 if(!state.open)return;
 root().innerHTML=layout();
 const container=root();
 container.querySelectorAll('[data-close]').forEach(x=>x.onclick=close);
 container.querySelectorAll('[data-tab]').forEach(x=>x.onclick=()=>{state.tab=x.dataset.tab;state.selected=null;render()});
 container.querySelectorAll('[data-order]').forEach(x=>x.onclick=()=>selectOrder(x.dataset.order).catch(e=>toast(e.message,'error')));
 container.querySelectorAll('[data-new]').forEach(x=>x.onclick=()=>newForm(x.dataset.new));
 container.querySelectorAll('[data-cancel]').forEach(x=>x.onclick=()=>{state.form=null;render()});
 container.querySelectorAll('[data-order-action]').forEach(x=>x.onclick=()=>statusChange(x.dataset.orderAction));
 container.querySelector('[data-copy-order]')?.addEventListener('click',()=>{
   const o=state.selected;
   if(!o)return;
   newForm('order',{supplier_id:o.supplier_id,branch_id:o.branch_id,reason:o.reason,requested_for:o.requested_for,allocation_type:o.allocation_type,allocation_id:o.allocation_id,unit_reference:o.unit_reference,notes:o.notes,items:o.items.map(i=>({consumable_id:i.consumable_id,quantity:i.quantity_ordered,unit_cost:(i.unit_cost_cents/100).toFixed(2)}))});
 });
 const form=container.querySelector('#ttc-form');
 if(form){
  form.addEventListener('submit',submitForm);
  form.querySelector('[name=allocation_type]')?.addEventListener('change',()=>editAllocation(form));
  if(form.querySelector('[name=allocation_type]')){
    const k=form.querySelector('[name=allocation_type]').value;
    const ref=form.querySelector('[name=unit_reference]');
    if(ref){ref.required=k==='rental';ref.closest('label').hidden=k!=='rental';}
    const alloc=form.querySelector('[name=allocation_id]');
    if(alloc)alloc.closest('label').hidden=k==='branch';
  }
  form.querySelector('[data-add-line]')?.addEventListener('click',()=>{captureOrderForm(form);state.form.items.push({consumable_id:'',quantity:1,unit_cost:0});render()});
  form.querySelectorAll('[data-remove-line]').forEach(x=>x.addEventListener('click',()=>{captureOrderForm(form);if(state.form.items.length>1)state.form.items.splice(Number(x.dataset.removeLine),1);render()}));
 }
}
function captureOrderForm(form){
 if(!state.form||state.form.kind!=='order')return;
 const fd=new FormData(form);
 for(const k of ['supplier_id','branch_id','reason','requested_for','allocation_type','allocation_id','unit_reference','expected_date','notes'])state.form[k]=fd.get(k)||'';
 state.form.items=[...form.querySelectorAll('[data-line]')].map(x=>({consumable_id:x.querySelector('[name=consumable_id]').value,quantity:x.querySelector('[name=quantity]').value,unit_cost:x.querySelector('[name=unit_cost]').value}));
}
function key(){return 'cpos-'+crypto.randomUUID();}
async function send(path,body){
 if(!state.submittedKey)state.submittedKey=key();
 return api(path,{method:'POST',headers:{'Idempotency-Key':state.submittedKey},body:JSON.stringify(body)});
}
async function statusChange(action){
 if(!state.selected)return;
 state.submittedKey=null;
 try{
  await send('/orders/'+state.selected.id+'/'+action,{});
  state.submittedKey=null;await load();await selectOrder(state.selected.id);toast('Purchase order '+action+' completed.','success');
 }catch(e){toast(e.message,'error');}
}
async function submitForm(ev){
 ev.preventDefault();const form=ev.currentTarget,kind=state.form?.kind,fd=new FormData(form),body=Object.fromEntries(fd);
 if(kind==='order'){captureOrderForm(form);body.items=state.form.items;delete body.consumable_id;delete body.quantity;delete body.unit_cost;}
 if(kind==='receive'){
  body.items=(state.selected?.items||[]).map(x=>({line_id:x.id,quantity:Number(fd.get('qty-'+x.id)||0)})).filter(x=>x.quantity>0);
  for(const k of Object.keys(body))if(k.startsWith('qty-'))delete body[k];
  if(!body.items.length)return form.querySelector('#ttc-error').textContent='Enter a positive received quantity.';
 }
 const path=kind==='order'?'/orders':kind==='catalog'?'/catalog':kind==='issue'?'/issues':'/orders/'+state.selected.id+'/receive';
 const btn=form.querySelector('button[type=submit]');btn.disabled=true;
 try{
  const result=await send(path,body);state.form=null;state.submittedKey=null;await load();
  if(kind==='order'||kind==='receive') {state.tab='orders';await selectOrder(kind==='order'?result.id:result.po_id);}
  else{state.tab=kind==='issue'?'usage':'orders';render();}
  toast('Consumables '+kind+' saved.','success');
 }catch(e){form.querySelector('#ttc-error').textContent=e.message;btn.disabled=false;}
}
async function open(){
 state.open=true;root().innerHTML='<div class="ttc-loading">Loading consumables operations…</div>';
 try{await load();render();return true;}catch(e){root().innerHTML='<div class="ttc-loading">'+esc(e.message)+' <button data-close>Close</button></div>';root().querySelector('[data-close]').onclick=close;return false;}
}
window.TotalToolsConsumablesWorkspace={open,close,refresh:async()=>{await load();render()}};
})();
