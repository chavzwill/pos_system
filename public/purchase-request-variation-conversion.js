(()=>{'use strict';
const ROOT_ID='tt-purchasing-workspace';let seq=0,lastKey='';const cache=new Map();
function root(){return document.getElementById(ROOT_ID)}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function notice(message,tone='error'){const ui=window.TotalToolsPremiumUI;if(ui?.notify)return ui.notify(message,{tone,persist:tone==='error'});window.alert(message)}
async function api(url,opts={}){const r=await fetch(url,{credentials:'same-origin',headers:{'Content-Type':'application/json',...(opts.headers||{})},...opts});const data=await r.json().catch(()=>({}));if(!r.ok){const e=new Error(data.error||`Request failed (${r.status})`);e.status=r.status;e.control=data.control;throw e}return data}
async function vars(productId){const key=Number(productId);if(cache.has(key))return cache.get(key);const rows=await api(`/api/products/${encodeURIComponent(productId)}/variations`).catch(()=>[]);const active=(Array.isArray(rows)?rows:[]).filter(v=>Number(v.active)!==0);cache.set(key,active);return active}
function selectedId(){return root()?.querySelector('.tt-purch__row.is-selected[data-id]')?.dataset.id||''}
function isApprovedRequest(){const r=root();return !!r?.querySelector('[data-tab="pr"].is-active')&&/approved/i.test(r.querySelector('.tt-purch__detail .tt-purch__status')?.textContent||'')}
async function enhance(){
  const r=root();if(!r||!isApprovedRequest())return;const id=selectedId(),host=r.querySelector('.tt-purch__convert');if(!id||!host)return;
  const key=`${id}:${r.querySelector('.tt-purch__detail-head h3')?.textContent||''}`;if(lastKey===key&&host.querySelector('[data-pr-variation-authority]'))return;
  const mine=++seq;host.querySelector('[data-pr-variation-authority]')?.remove();
  try{
    const pr=await api(`/api/purchase-requests/${encodeURIComponent(id)}`);if(mine!==seq||selectedId()!==id)return;
    const required=[];
    for(const item of pr.items||[]){if(!item.product_id||item.item_type==='internal'||Number(item.active_variation_count||0)<=0)continue;required.push({item,variations:await vars(item.product_id)});if(mine!==seq||selectedId()!==id)return;}
    const panel=document.createElement('div');panel.dataset.prVariationAuthority='1';panel.className='tt-purch__pr-variation-authority';
    panel.innerHTML=required.length?`<strong>Exact variation authority</strong><span>Choose the exact supplier SKU for every variation-bearing request line before the purchase order is created.</span>${required.map(({item,variations})=>`<label><span>${esc(item.product_name||item.linked_product_name||'Item')}</span><select data-pr-variation="${item.id}" required><option value="">Select exact variation</option>${variations.map(v=>`<option value="${v.id}" ${Number(item.variation_id||0)===Number(v.id)?'selected':''}>${esc(v.name)}${v.sku?` · ${esc(v.sku)}`:''}</option>`).join('')}</select></label>`).join('')}`:`<strong>Variation authority</strong><span>No exact variation selection is required for this request.</span>`;
    host.prepend(panel);lastKey=key;
  }catch(e){console.warn('Unable to prepare PR variation authority',e)}
}
async function convert(button){
  const r=root(),id=selectedId();if(!r||!id)return;const supplier_id=r.querySelector('#tt-purch-supplier')?.value||'';if(!supplier_id)return notice('Select a supplier before creating the purchase order.');
  const required=[...r.querySelectorAll('[data-pr-variation]')];const missing=required.find(x=>!x.value);if(missing){missing.focus();return notice('Select the exact variation for every variation-bearing request line before conversion.');}
  const variations=required.map(x=>({pr_item_id:Number(x.dataset.prVariation),variation_id:Number(x.value)}));const expected_date=r.querySelector('#tt-purch-expected')?.value||null;
  button.disabled=true;const original=button.textContent;button.textContent='Creating controlled PO…';
  try{
    const po=await api(`/api/purchase-requests/${encodeURIComponent(id)}/convert`,{method:'POST',body:JSON.stringify({supplier_id,expected_date,variations})});
    notice(`${po.po_number||'Purchase order'} created with authoritative variation provenance.`,'success');lastKey='';seq++;await window.TotalToolsPurchasingWorkspace?.refresh?.();setTimeout(()=>root()?.querySelector('[data-tab="po"]')?.click(),0);
  }catch(e){button.disabled=false;button.textContent=original;notice(e.message)}
}
document.addEventListener('click',e=>{const b=e.target.closest?.(`#${ROOT_ID} [data-action="convert"]`);if(!b)return;if(!isApprovedRequest())return;e.preventDefault();e.stopImmediatePropagation();void convert(b)},true);
const obs=new MutationObserver(()=>void enhance());obs.observe(document.documentElement,{childList:true,subtree:true});void enhance();
})();