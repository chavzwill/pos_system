(()=>{'use strict';
const SEARCH_ID='tt-sales-search';
const API='/api/inventory-traceability/uom/commerce/resolve-barcode';
let busy=false;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function announce(message,kind='ok'){
  const input=document.getElementById(SEARCH_ID);if(!input)return;
  let note=document.getElementById('tt-sales-scan-status');
  if(!note){note=document.createElement('div');note.id='tt-sales-scan-status';note.setAttribute('role','status');note.setAttribute('aria-live','polite');note.style.cssText='font-size:12px;margin-top:6px;color:#52615a';input.parentElement?.appendChild(note)}
  note.textContent=message;note.dataset.kind=kind;
}
async function json(url){const r=await fetch(url,{credentials:'same-origin',headers:{Accept:'application/json'}});const data=await r.json().catch(()=>({}));if(!r.ok){const e=new Error(data.error||`Barcode lookup failed (${r.status})`);e.status=r.status;throw e}return data}
function cartLineFor(product){const sku=String(product?.sku||'').trim(),name=String(product?.name||'').trim();return [...document.querySelectorAll('.tt-sales__line')].find(line=>{const text=line.textContent||'';return (sku&&text.includes(sku))||(name&&text.includes(name))})||null}
async function waitFor(test,timeout=1800){const end=Date.now()+timeout;while(Date.now()<end){const v=test();if(v)return v;await sleep(40)}return null}
async function setCatalogSearch(value){const input=await waitFor(()=>document.getElementById(SEARCH_ID));if(!input)return false;input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));return true}
async function scanPackageBarcode(barcode){
  const resolved=await json(`${API}?barcode=${encodeURIComponent(barcode)}`),product=resolved.product,unit=resolved.unit;
  if(!product||!unit)throw new Error('Barcode resolver returned incomplete product/UOM data.');
  const existing=cartLineFor(product);
  if(existing){
    const select=existing.querySelector('[data-uom]');
    if(select&&String(select.value)!==String(unit.uom_code))throw new Error(`${product.name} is already in the cart as another selling unit. Finish or remove that line before scanning ${unit.uom_name||unit.uom_code}.`);
    const plus=existing.querySelector('[data-plus]');if(plus&&!plus.disabled){plus.click();announce(`Scanned ${product.name} · ${unit.uom_name||unit.uom_code}`);return}
    throw new Error(`No additional ${unit.uom_name||unit.uom_code} can be sold from current stock.`);
  }
  const needle=String(product.sku||product.name||'').trim();if(!needle)throw new Error('Resolved product has no searchable SKU or name.');
  await setCatalogSearch(needle);
  const button=await waitFor(()=>document.querySelector(`[data-product="${CSS.escape(String(product.id))}"]`));if(!button)throw new Error(`Resolved ${product.name} but could not load it into the POS catalog.`);
  button.click();
  const line=await waitFor(()=>cartLineFor(product));if(!line)throw new Error(`Resolved ${product.name} but could not add it to the cart.`);
  const select=line.querySelector('[data-uom]');
  if(String(unit.factor_to_base)!=='1'&&(!select||![...select.options].some(o=>String(o.value)===String(unit.uom_code))))throw new Error(`${unit.uom_name||unit.uom_code} is not available as a sellable unit in this cart.`);
  if(select&&String(select.value)!==String(unit.uom_code)){select.value=unit.uom_code;select.dispatchEvent(new Event('change',{bubbles:true}));await sleep(30)}
  announce(`Scanned ${product.name} · ${unit.uom_name||unit.uom_code}`);
}
async function handleEnter(event){
  const input=event.target;if(!(input instanceof HTMLInputElement)||input.id!==SEARCH_ID||event.key!=='Enter'||event.isComposing)return;
  const barcode=input.value.trim();if(!barcode||busy)return;
  event.preventDefault();event.stopPropagation();busy=true;announce(`Resolving barcode ${barcode}…`);
  try{await scanPackageBarcode(barcode);await setCatalogSearch('');const fresh=await waitFor(()=>document.getElementById(SEARCH_ID));fresh?.focus()}
  catch(error){if(error.status===404){announce('No package barcode match. Search results remain available.','muted')}else{announce(error.message||'Unable to scan this barcode.','error');alert(error.message||'Unable to scan this barcode.')}}
  finally{busy=false}
}
document.addEventListener('keydown',handleEnter,true);
window.TotalToolsPosBarcodeScanner={scan:scanPackageBarcode};
})();
