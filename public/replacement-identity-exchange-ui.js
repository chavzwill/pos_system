(()=>{'use strict';
const state={transactionId:null,data:null,loading:false};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function cashier(){return document.getElementById('tt-cashier-controls');}
function replacementSelected(){return cashier()?.querySelector('#tt-cc-resolution')?.value==='replacement';}
function selectedTransactionId(){return Number(cashier()?.querySelector('.tt-cc__tx.is-selected[data-tx]')?.dataset.tx||0);}
function ui(){return window.TotalToolsPremiumUI||{};}
function tell(message,tone='error',persist=tone==='error'){if(ui().notify)ui().notify(message,{tone,persist});else console[tone==='error'?'error':'log'](message);}
async function ask(options){if(ui().confirm)return ui().confirm(options);return window.confirm(options.message||options.title||'Confirm?');}
async function api(url,opts={}){const r=await fetch(url,{credentials:'same-origin',headers:{'Content-Type':'application/json',...(opts.headers||{})},...opts});const data=await r.json().catch(()=>({}));if(!r.ok){const e=new Error(data.error||`Request failed (${r.status})`);e.status=r.status;e.code=data.control||data.code||'';throw e;}return data;}
function ensureStyle(){if(document.getElementById('tt-replacement-identity-style'))return;const s=document.createElement('style');s.id='tt-replacement-identity-style';s.textContent=`.tt-repl-id{grid-column:1/-1;margin-top:10px;padding:12px;border:1px solid color-mix(in srgb,currentColor 15%,transparent);border-radius:12px;background:color-mix(in srgb,currentColor 4%,transparent)}.tt-repl-id__head{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:8px}.tt-repl-id__head strong{font-size:.88rem}.tt-repl-id__head span{font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;opacity:.68}.tt-repl-id__grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.tt-repl-id label{display:grid;gap:5px;font-size:.78rem}.tt-repl-id textarea{min-height:64px;resize:vertical}.tt-repl-id small{display:block;margin-top:7px;opacity:.72;line-height:1.35}.tt-repl-id.is-warning{border-style:dashed}.tt-repl-id__status{margin:8px 0 0;font-size:.75rem;font-weight:650}@media(max-width:720px){.tt-repl-id__grid{grid-template-columns:1fr}}`;document.head.appendChild(s);}
function splitSerials(v){return String(v||'').split(/[\n,]+/).map(x=>x.trim()).filter(Boolean);}
function parseLots(v){const out=[];for(const raw of String(v||'').split(/[\n,]+/)){const part=raw.trim();if(!part)continue;const m=part.match(/^(.+?):\s*(\d+)$/);if(!m)throw new Error(`Lot entry "${part}" must use LOT:quantity format.`);out.push({lot_number:m[1].trim(),quantity:Number(m[2])});}return out;}
function serialHint(rows,key){const vals=(rows||[]).slice(0,16).map(x=>x[key]);return vals.length?vals.join(', '):'None available';}
function lotHint(rows,kind){return (rows||[]).slice(0,12).map(x=>`${x.lot_number}:${kind==='return'?x.remaining_returnable:x.available_quantity}`).join(', ')||'None available';}
function itemPanel(info){
  if(info.tracking_mode==='none')return '';
  if(info.variation_id)return `<div class="tt-repl-id is-warning" data-replacement-identity="${info.id}"><div class="tt-repl-id__head"><strong>Controlled identity exchange</strong><span>${esc(info.tracking_mode)}</span></div><small>This tracked item is variation-linked, but existing inventory identities are not variation-bound. The server will block replacement rather than issue an unverified variation.</small></div>`;
  if(info.tracking_mode==='serial')return `<div class="tt-repl-id" data-replacement-identity="${info.id}" data-mode="serial"><div class="tt-repl-id__head"><strong>Scan returned + replacement serials</strong><span>Serial controlled</span></div><div class="tt-repl-id__grid"><label>Returned serial(s)<textarea data-returned-serials placeholder="One serial per line"></textarea></label><label>Replacement serial(s)<textarea data-issued-serials placeholder="One serial per line"></textarea></label></div><small>Returnable from this sale: ${esc(serialHint(info.returnable_serials,'serial_number'))}<br>Available at original branch: ${esc(serialHint(info.available_replacement_serials,'serial_number'))}</small><div class="tt-repl-id__status">Returned identity will be quarantined. Issued identity will be marked sold and linked to this replacement.</div></div>`;
  return `<div class="tt-repl-id" data-replacement-identity="${info.id}" data-mode="lot"><div class="tt-repl-id__head"><strong>Record returned + replacement lots</strong><span>Lot controlled</span></div><div class="tt-repl-id__grid"><label>Returned lot allocation<textarea data-returned-lots placeholder="LOT-A:2, LOT-B:1"></textarea></label><label>Replacement lot allocation<textarea data-issued-lots placeholder="LOT-C:3"></textarea></label></div><small>Returnable lots (lot:qty): ${esc(lotHint(info.returnable_lots,'return'))}<br>Available branch lots (lot:qty): ${esc(lotHint(info.available_replacement_lots,'issue'))}</small><div class="tt-repl-id__status">Returned quantity stays quarantined; replacement quantity is deducted from the exact issued lot(s).</div></div>`;
}
function renderPanels(){
  const root=cashier();if(!root||!replacementSelected()||!state.data)return;
  root.querySelectorAll('[data-replacement-identity]').forEach(x=>x.remove());
  for(const info of state.data.items||[]){const qty=root.querySelector(`.tt-cc-return-qty[data-item="${CSS.escape(String(info.id))}"]`);if(!qty)continue;const row=qty.closest('.tt-cc__item');if(!row)continue;row.insertAdjacentHTML('beforeend',itemPanel(info));}
}
async function loadIdentityOptions(){
  const id=selectedTransactionId();if(!id||!replacementSelected())return;
  if(state.loading)return;state.loading=true;
  try{state.transactionId=id;state.data=await api(`/api/transactions/${id}/replacement-identities`);renderPanels();}
  catch(e){state.data=null;tell(e.message);}
  finally{state.loading=false;}
}
function selectedItems(){
  const root=cashier();const items=[];
  for(const input of root.querySelectorAll('.tt-cc-return-qty')){
    const quantity=Number(input.value||0);if(quantity<=0)continue;const transaction_item_id=Number(input.dataset.item);const info=(state.data?.items||[]).find(x=>Number(x.id)===transaction_item_id);const item={transaction_item_id,quantity};
    if(info?.tracking_mode==='serial'){
      const panel=root.querySelector(`[data-replacement-identity="${CSS.escape(String(transaction_item_id))}"]`);item.returned_serial_numbers=splitSerials(panel?.querySelector('[data-returned-serials]')?.value);item.replacement_serial_numbers=splitSerials(panel?.querySelector('[data-issued-serials]')?.value);
      if(item.returned_serial_numbers.length!==quantity||item.replacement_serial_numbers.length!==quantity)throw new Error(`${info.product_name} requires exactly ${quantity} returned serial(s) and ${quantity} replacement serial(s).`);
    }else if(info?.tracking_mode==='lot'){
      const panel=root.querySelector(`[data-replacement-identity="${CSS.escape(String(transaction_item_id))}"]`);item.returned_lots=parseLots(panel?.querySelector('[data-returned-lots]')?.value);item.replacement_lots=parseLots(panel?.querySelector('[data-issued-lots]')?.value);
      const rq=item.returned_lots.reduce((s,x)=>s+x.quantity,0),iq=item.replacement_lots.reduce((s,x)=>s+x.quantity,0);if(rq!==quantity||iq!==quantity)throw new Error(`${info.product_name} returned and replacement lot quantities must each total ${quantity}.`);
    }
    items.push(item);
  }
  return items;
}
async function submitReplacement(){
  const root=cashier(),id=selectedTransactionId();if(!id)return tell('Select the original transaction first.');
  if(!state.data||state.transactionId!==id){await loadIdentityOptions();if(!state.data)return;}
  let items;try{items=selectedItems();}catch(e){return tell(e.message);}if(!items.length)return tell('Select at least one replacement quantity.');
  const notes=root.querySelector('#tt-cc-return-notes')?.value?.trim()||'';if(!notes)return tell('Enter a replacement reason or note.');
  const ok=await ask({title:'Issue this controlled replacement?',message:'The returned merchandise will be quarantined and replacement stock will be issued from the original branch. Serial/lot identities are validated and recorded atomically. Continue?',confirmLabel:'Issue replacement',cancelLabel:'Keep reviewing'});if(!ok)return;
  const key=`replacement-${id}-${crypto.randomUUID?.()||Date.now()+'-'+Math.random().toString(16).slice(2)}`;
  try{
    const result=await api(`/api/transactions/${id}/return`,{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify({resolution:'replacement',notes,items})});
    tell(`Replacement ${result.return_number||''} issued with custody and identity evidence.`,'success',false);state.data=null;state.transactionId=null;await window.TotalToolsCashierControls?.refresh?.();
  }catch(e){
    if(!navigator.onLine||e.name==='TypeError')tell('The replacement outcome may be unknown because the connection was interrupted. Refresh transaction evidence before trying again. Do not issue a second replacement.');
    else tell(e.message);
  }
}
function onChange(e){if(e.target?.id==='tt-cc-resolution'){if(e.target.value==='replacement')loadIdentityOptions();else cashier()?.querySelectorAll('[data-replacement-identity]').forEach(x=>x.remove());}}
function onClickCapture(e){
  const button=e.target?.closest?.('#tt-cc-return');if(button&&replacementSelected()){e.preventDefault();e.stopImmediatePropagation();submitReplacement();return;}
  if(e.target?.closest?.('.tt-cc__tx[data-tx]'))setTimeout(()=>{state.data=null;state.transactionId=null;if(replacementSelected())loadIdentityOptions();},80);
}
function observe(){ensureStyle();document.addEventListener('change',onChange,true);document.addEventListener('click',onClickCapture,true);const mo=new MutationObserver(()=>{if(replacementSelected()&&selectedTransactionId()&&(!state.data||state.transactionId!==selectedTransactionId()))loadIdentityOptions();});mo.observe(document.body,{childList:true,subtree:true});}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',observe,{once:true});else observe();
window.TotalToolsReplacementIdentityExchange={refresh:loadIdentityOptions};
})();