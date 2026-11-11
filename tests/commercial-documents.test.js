'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const docs=require('../public/commercial-documents.js');
const brand={store_name:'River & Oak Trading',store_address:'12 Market Road',store_phone:'876-555-0100',store_email:'sales@example.test',company_logo_url:'/uploads/branding/example.png',brand_primary_color:'#165A4D',currency:'JMD'};
const line={product_name:'Cordless drill',sku:'DRL-123',quantity:2,unit_price:18000,total:36000};
test('quotation uses the same company logo, accurate saved totals, quote validity and safe text',()=>{
 const q={quote_number:'QUO-01042',status:'sent',customer_name:'ACME & Sons',created_at:'2026-11-11',valid_until:'2026-11-29',subtotal:36000,tax_amount:5400,discount_amount:900,total:40500,notes:'<script>alert(1)</script>',items:[line]};
 const html=docs.render('quote',q,brand);
 assert.match(html,/QUOTATION/);
 assert.match(html,/QUO-01042/);
 assert.match(html,/River &amp; Oak Trading/);
 assert.match(html,/uploads\/branding\/example.png/);
 assert.match(html,/40500|40,500\.00/);
 assert.match(html,/JMD 40,500\.00/);
 assert.match(html,/Valid until/i);
 assert.match(html,/Discount/);
 assert.ok(!html.includes('<script>alert(1)</script>'));
 assert.match(html,/&lt;script&gt;alert/);
 assert.match(html,/commercial-documents\.css/);
});
test('purchase order shows original supplier currency not local converted amounts in item totals',()=>{
 const po={po_number:'PO-00721',status:'approved',supplier_name:'Global Fasteners Ltd',branch_name:'Kingston',created_at:'2026-11-11',expected_date:'2026-11-20',currency:'USD',base_currency:'JMD',fx_rate_to_base:160,currency_subtotal:150,currency_tax_amount:0,currency_total:150,subtotal:24000,tax_amount:0,total:24000,approval_purpose:'For commercial stock',requested_for:'Main branch',items:[{product_name:'Hex bolts',quantity_ordered:10,supplier_unit_cost:15,supplier_line_total:150,unit_cost:2400,total:24000}]};
 const html=docs.render('po',po,brand);
 assert.match(html,/PURCHASE ORDER/);assert.match(html,/SUPPLIER/);
 assert.match(html,/Global Fasteners Ltd/);assert.match(html,/USD 150\.00/);
 assert.match(html,/Recorded base value JMD 24,000\.00/);
 assert.doesNotMatch(html,/JMD 24,000\.00<\/strong><\/div>/);
 assert.doesNotMatch(html,/For commercial stock/);
 assert.doesNotMatch(html,/Main branch/);
 assert.doesNotMatch(html,/internal approval/i);
});
test('buyer-facing purchase orders never reveal internal approval notes, and document terms are branded',()=>{
 const po={po_number:'PO-9',status:'approved',subtotal:12,total:12,approval_purpose:'SECRET APPROVAL REASON',requested_for:'PRIVATE DEPARTMENT',notes:'INTERNAL NOTES ONLY',supplier_notes:'Deliver to loading bay',items:[]};
 const html=docs.render('po',po,{...brand,purchase_order_terms:'Delivery subject to inspection.'});
 assert.doesNotMatch(html,/SECRET APPROVAL REASON|PRIVATE DEPARTMENT|INTERNAL NOTES ONLY/);
 assert.match(html,/Deliver to loading bay/);
 assert.match(html,/Delivery subject to inspection/);
});
test('custom branding respects document font, quote terms and supplier contact details',()=>{
 const q={quote_number:'Q-88',status:'sent',subtotal:150,total:150,items:[]};
 const html=docs.render('quote',q,{...brand,brand_font:'manrope',quote_terms:'Prices valid for 14 days.'});
 assert.match(html,/--doc-font:Manrope,Inter,Arial,sans-serif/);
 assert.match(html,/Prices valid for 14 days/);
});
test('unapproved orders remain explicitly labeled and never implied approved',()=>{
 const html=docs.render('po',{po_number:'PO-1',status:'draft',total:0,subtotal:0,items:[]},brand);
 assert.match(html,/DRAFT/);
 assert.match(html,/has not been approved/);
});
test('completed invoices include payment evidence and authoritative tax/discount and customer identity',()=>{
 const invoice={transaction_number:'INV-1341',status:'completed',created_at:'2026-11-11',customer_name:'Jane Client',payment_method:'card',subtotal:30000,tax_amount:4500,discount_amount:500,total:34000,items:[{...line,unit_price:15000,total:30000}]};
 const html=docs.render('invoice',invoice,brand);
 assert.match(html,/SALES INVOICE/);assert.match(html,/Jane Client/);
 assert.match(html,/JMD 34,000\.00/);assert.match(html,/JMD 4,500\.00/);
 assert.match(html,/Discount/);assert.match(html,/Payment/);
});
test('never print held, voided, unsupported or incomplete documents as invoices',()=>{
 assert.throws(()=>docs.render('invoice',{transaction_number:'HOLD-7',total:200,status:'hold'},brand),/Only completed/);
 assert.throws(()=>docs.render('invoice',{transaction_number:'INV-7',total:200,status:'voided'},brand),/Only completed/);
 assert.throws(()=>docs.render('invoice',{transaction_number:'INV-7',status:'completed'},brand),/saved document total/);
 assert.throws(()=>docs.render('arbitrary',{},brand),/Unsupported/);
});
test('reject hostile company logos and CSS values',()=>{
 const html=docs.render('quote',{quote_number:'Q-123',total:0}, {...brand,company_logo_url:'javascript:alert(1)',brand_primary_color:'red;position:absolute'});
 assert.doesNotMatch(html,/javascript:alert/);
 assert.match(html,/--doc-accent:#0B7A3E/);
});
test('actual commercial workspace actions load the document library',()=>{
 const shell=fs.readFileSync(path.join(__dirname,'../public/app-shell.html'),'utf8');
 const po=fs.readFileSync(path.join(__dirname,'../public/purchasing-workspace.js'),'utf8');
 const quote=fs.readFileSync(path.join(__dirname,'../public/quotations-workspace.js'),'utf8');
 const sale=fs.readFileSync(path.join(__dirname,'../public/sales-workspace.js'),'utf8');
 assert.match(shell,/commercial-documents\.js/);
 assert.match(po,/data-print-commercial-po/);
 assert.match(po,/POSDocuments\?\.open\('po',state\.selected\)/);
 assert.match(quote,/POSDocuments\?\.open\('quote',quotePrintEvidence\(\)\)/);
 assert.match(sale,/POSDocuments\?\.open\('invoice',invoicePrintEvidence\(tx,usage\)\)/);
 assert.match(quote,/function quotePrintEvidence/);
 assert.match(sale,/function invoicePrintEvidence/);
});
