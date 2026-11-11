(function initCommercialDocuments(factory){
  const api=factory();
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  if(typeof window!=='undefined')window.POSDocuments=api;
})(function(){
'use strict';
const kinds={po:'PURCHASE ORDER',quote:'QUOTATION',invoice:'SALES INVOICE'};
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[char]));
const hasNumber=value=>value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value));
const amount=value=>Number(value).toLocaleString('en-JM',{minimumFractionDigits:2,maximumFractionDigits:2});
const num=value=>Number(value).toLocaleString('en-JM',{maximumFractionDigits:6});
const money=(value,code)=>hasNumber(value)?esc(code)+' '+amount(value):'—';
const text=value=>esc(String(value??'').trim().slice(0,1500));
const currency=value=>/^[A-Z]{3}$/.test(String(value||'').toUpperCase())?String(value).toUpperCase():'JMD';
const cssColor=value=>/^#[a-f\d]{6}$/i.test(String(value||''))?String(value):'#0B7A3E';
function date(value){
 if(value===null||value===undefined||String(value).trim()==='')return '—';
 const matched=/^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
 if(!matched)return text(value);
 const d=new Date(Number(matched[1]),Number(matched[2])-1,Number(matched[3]));
 if(Number.isNaN(d.getTime())||d.getMonth()!==Number(matched[2])-1)return text(value);
 return text(d.toLocaleDateString('en-JM',{day:'2-digit',month:'short',year:'numeric'}));
}
function safeLogo(value){
 const src=String(value||'').trim();
 if((src.startsWith('/')&&!src.startsWith('//')&&!src.includes('\\'))||/^https:\/\/[\w.-]+(?:\/|$)/i.test(src))return src;
 return '';
}
function cell(label,value){return '<div class="doc-fact"><span>'+esc(label)+'</span><strong>'+text(value||'—')+'</strong></div>'}
function party(title,partyName,details=[]){
 const detailRows=details.filter(Boolean).map(item=>'<span>'+text(item)+'</span>').join('');
 return '<section class="doc-party"><span class="doc-label">'+esc(title)+'</span><strong>'+text(partyName||'—')+'</strong>'+detailRows+'</section>';
}
function normalized(kind,data={},brand={}){
 if(!kinds[kind])throw new TypeError('Unsupported business document');
 if(!data||typeof data!=='object')throw new TypeError('Document data is required');
 const record=String(kind==='po'?data.po_number:kind==='quote'?data.quote_number:data.transaction_number||'').trim();
 if(!record)throw new TypeError('The saved document number is required');
 const base=currency(brand.currency||'JMD');
 const code=kind==='po'?currency(data.currency||data.base_currency||base):base;
 const foreign=kind==='po'&&data.currency&&data.base_currency&&code!==currency(data.base_currency);
 const lineItems=Array.isArray(data.items)?data.items:[];
 const total=foreign?data.currency_total:data.total;
 if(!hasNumber(total))throw new TypeError('A saved document total is required');
 if(kind==='invoice'&&!['completed','paid'].includes(String(data.status||'').toLowerCase()))throw new TypeError('Only completed transactions can be printed as sales invoices');
 const subtotal=foreign?data.currency_subtotal:data.subtotal;
 const tax=foreign?data.currency_tax_amount:data.tax_amount;
 const discount=kind==='po'?0:data.discount_amount;
 const status=String(data.status||'').toUpperCase().replace(/_/g,' ');
 const issuer=brand.store_name||'Your Business';
 const location=parts=>parts.filter(Boolean).join(', ');
 const details=kind==='po'?[location([data.branch_address,data.branch_city,data.branch_state])||brand.store_address,data.branch_phone||brand.store_phone,brand.store_email]:[brand.store_address,brand.store_phone,brand.store_email];
 const contact=kind==='po'
   ?party('SUPPLIER',data.supplier_name||'Supplier not assigned',[data.supplier_contact,location([data.supplier_address,data.supplier_city,data.supplier_state]),data.supplier_phone,data.supplier_email])
   :party('PREPARED FOR',data.customer_name||'Walk-in customer',[location([data.customer_address,data.customer_city,data.customer_state]),data.customer_email,data.customer_phone]);
 const ourselves=party(kind==='po'?'PURCHASER / DELIVERY TO':kind==='quote'?'PREPARED BY':'ISSUED BY',issuer,details);
 const quantityKey=kind==='po'?'quantity_ordered':'quantity';
 const mappedLines=lineItems.map((row,index)=>{
   const isComment=row.line_type==='comment';
   const qty=isComment?null:(row[quantityKey]??row.qty??row.quantity??0);
   const unitPrice=kind==='po'?(foreign?row.supplier_unit_cost:row.unit_cost):row.unit_price;
   const lineTotal=kind==='po'?(foreign?row.supplier_line_total:row.total):(row.line_total??row.total);
   const name=row.product_name||row.description||row.name||row.line_type||'Line item';
   return {no:index+1,name,sku:row.sku||'',detail:row.variation_name||row.uom_code||(row.product_name&&row.description?row.description:''),qty,unitPrice:isComment?null:unitPrice,lineTotal:isComment?null:lineTotal,comment:isComment};
 });
 const facts=kind==='po'?
  [['Order number',record],['Issued',date(data.created_at)],['Expected',date(data.expected_date)],['Branch',data.branch_name||'—']]:
  kind==='quote'?[['Quote number',record],['Issued',date(data.created_at)],['Valid until',date(data.valid_until)],['Branch',data.branch_name||'—']]:
  [['Invoice number',record],['Issued',date(data.created_at)],['Branch',data.branch_name||'—'],['Payment',String(data.payment_method||'See payment record').replace(/_/g,' ')]];
 const notes=kind==='po'?[data.supplier_notes||data.delivery_instructions]:kind==='invoice'?[data.customer_note]:[data.customer_note||data.notes];
 const terms=kind==='po'?brand.purchase_order_terms:kind==='quote'?brand.quote_terms:brand.invoice_terms;
 const extras=kind==='po'&&foreign
  ?'Original supplier currency: '+code+' · Recorded base value '+money(data.total,currency(data.base_currency))+' · FX '+String(data.fx_rate_to_base||'—'):'';
 const font=brand.brand_font==='manrope'?'Manrope,Inter,Arial,sans-serif':brand.brand_font==='system'?'system-ui,Arial,sans-serif':'Inter,Manrope,Arial,sans-serif';
 const taxLabel=hasNumber(data.tax_rate)?'Tax ('+Number(data.tax_rate).toLocaleString('en-JM',{maximumFractionDigits:2})+'%)':'Tax / GCT';
 return {kind,record,code,issuer,details,contact,ourselves,mappedLines,facts,status,
   subtotal,tax,discount,total,notes:notes.filter(Boolean),terms:String(terms||'').trim().slice(0,2500),extras,taxLabel,logo:safeLogo(brand.company_logo_url),
   accent:cssColor(brand.brand_primary_color),font,footnote:brand.receipt_footer||'This document reflects the transaction information recorded at the time of printing.'};
}
function render(kind,data,brand={}){
 const doc=normalized(kind,data,brand);
 const logo=doc.logo?'<img class="doc-logo" src="'+esc(doc.logo)+'" alt="'+text(doc.issuer)+' logo">':
   '<div class="doc-logotype" aria-hidden="true">'+text(doc.issuer.split(/\s+/).slice(0,2).map(s=>s[0]||'').join('').toUpperCase())+'</div>';
 const rows=doc.mappedLines.map(line=>
  '<tr><td class="doc-index">'+String(line.no).padStart(2,'0')+'</td><td class="doc-product"><strong>'+text(line.name)+'</strong>'+
  (line.sku?'<small>SKU '+text(line.sku)+'</small>':'')+
  (line.detail?'<small>'+text(line.detail)+'</small>':'')+'</td><td class="doc-qty">'+(line.comment?'—':text(num(line.qty)))+
  '</td><td class="doc-money">'+money(line.unitPrice,doc.code)+'</td><td class="doc-money doc-line-total">'+money(line.lineTotal,doc.code)+'</td></tr>'
 ).join('');
 const summary=[
  ['Subtotal',doc.subtotal],...(hasNumber(doc.discount)&&Number(doc.discount)>0?[['Discount',-Number(doc.discount)]]:[]),
  [doc.taxLabel,doc.tax]
 ].map(([label,value])=>'<div class="doc-summary-row"><span>'+text(label)+'</span><strong>'+money(value,doc.code)+'</strong></div>').join('');
 const noteBlock=doc.notes.length?'<section class="doc-notes"><span class="doc-label">DOCUMENT NOTES</span>'+
   doc.notes.map(n=>'<p>'+text(n)+'</p>').join('')+'</section>':'';
 const termsBlock=doc.terms?'<section class="doc-terms"><span class="doc-label">TERMS & CONDITIONS</span><p>'+text(doc.terms)+'</p></section>':'';
 const label=kinds[kind];const tagline=kind==='po'?'Official purchasing document':kind==='quote'?'Prepared exclusively for the recipient':'Sales transaction record';
 const status=doc.status?'<span class="doc-status">'+text(doc.status)+'</span>':'';
 const caution=kind==='po'&&['DRAFT','PENDING','SUBMITTED'].includes(doc.status)?'<div class="doc-caution">This order has not been approved for receiving or fulfillment.</div>':'';
 return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+
  text(label+' · '+doc.record)+'</title><link rel="stylesheet" href="/commercial-documents.css?v=20261111-a"></head>'+
  '<body style="--doc-accent:'+doc.accent+';--doc-font:'+doc.font+'"><div class="doc-tools" role="toolbar" aria-label="Document actions">'+
  '<span>Preview · '+text(label)+'</span><div><button id="doc-close" type="button">Close</button><button id="doc-print" type="button">Print / Save PDF</button></div></div>'+
  '<main class="doc-paper"><div class="doc-topline"></div><div class="doc-inner">'+
  '<header class="doc-header"><div class="doc-brand">'+logo+'<div><strong>'+text(doc.issuer)+'</strong><span>BUSINESS OPERATIONS</span></div></div>'+
  '<div class="doc-heading"><span class="doc-label">BUSINESS DOCUMENT</span><h1>'+text(label)+'</h1><p>'+text(tagline)+'</p></div></header>'+
  '<div class="doc-heading-rule"></div><div class="doc-reference"><div><span>DOCUMENT REFERENCE</span><strong>'+text(doc.record)+'</strong></div>'+status+'</div>'+
  '<section class="doc-facts">'+doc.facts.map(([l,v])=>cell(l,v)).join('')+'</section>'+
  '<div class="doc-parties">'+doc.ourselves+doc.contact+'</div>'+
  '<section class="doc-lines"><div class="doc-sectionhead"><h2>Itemized details</h2><span>'+doc.mappedLines.length+' line'+(doc.mappedLines.length===1?'':'s')+'</span></div>'+
  '<div class="doc-table-wrap"><table><thead><tr><th class="doc-index">#</th><th>DESCRIPTION</th><th class="doc-qty">QTY</th>'+
  '<th class="doc-money">UNIT PRICE</th><th class="doc-money">LINE TOTAL</th></tr></thead>'+
  '<tbody>'+rows+'</tbody></table></div></section>'+
  '<div class="doc-bottom"><div class="doc-notes-column">'+noteBlock+termsBlock+(doc.extras?'<p class="doc-fx">'+text(doc.extras)+'</p>':'')+caution+'</div>'+
  '<section class="doc-summary" aria-label="Financial summary">'+summary+
  '<div class="doc-grandtotal"><span>GRAND TOTAL</span><strong>'+money(doc.total,doc.code)+'</strong></div>'+
  '<small>All amounts shown in '+esc(doc.code)+'</small></section></div>'+
  '<footer class="doc-footer"><div><span>'+text(doc.issuer)+'</span><small>'+text(doc.footnote)+'</small></div><span>'+text(doc.record)+'</span></footer>'+
  '</div></main></body></html>';
}
function open(kind,data,brand){
 if(typeof window==='undefined'||!window.open)return null;
 const settings=brand||window.PosBranding?.settings||{};
 let html;
 try{html=render(kind,data,settings);}catch(error){window.TotalToolsShellUI?.toast?.(error.message,'error');return null;}
 const win=window.open('','_blank','width=1050,height=850');
 if(!win){window.TotalToolsShellUI?.toast?.('Allow pop-ups to preview and print the document.','error');return null;}
 try{win.opener=null;}catch(_){}
 win.document.open();win.document.write(html);win.document.close();
 const print=win.document.getElementById('doc-print'),close=win.document.getElementById('doc-close');
 print?.addEventListener('click',()=>{win.focus();win.print()});
 close?.addEventListener('click',()=>win.close());
 return win;
}
return {render,open,normalize:normalized};
});