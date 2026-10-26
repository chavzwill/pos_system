'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'register-'));process.env.TURSO_DATABASE_URL='file:'+path.join(dir,'db');process.env.TURSO_AUTH_TOKEN='';
const {db}=require('../database');let server,base;
before(async()=>{
 await db.batch([
  'CREATE TABLE suppliers(id INTEGER PRIMARY KEY,name TEXT)','CREATE TABLE branches(id INTEGER PRIMARY KEY,name TEXT)',
  'CREATE TABLE purchase_orders(id INTEGER PRIMARY KEY,po_number TEXT,supplier_id INTEGER,branch_id INTEGER,status TEXT,total REAL,created_at TEXT,notes TEXT)',
  'CREATE TABLE purchase_requests(id INTEGER PRIMARY KEY,pr_number TEXT,supplier_id INTEGER,branch_id INTEGER,employee_id INTEGER,status TEXT,created_at TEXT,converted_to_po_id INTEGER)',
  'CREATE TABLE purchase_request_items(id INTEGER PRIMARY KEY,pr_id INTEGER,product_name TEXT,quantity REAL,unit_cost REAL,total REAL)',
  'CREATE TABLE purchase_order_items(id INTEGER PRIMARY KEY,po_id INTEGER,product_name TEXT,quantity_ordered REAL,quantity_received REAL,unit_cost REAL,total REAL)',
  'CREATE TABLE purchase_receipts(id INTEGER PRIMARY KEY,receipt_number TEXT,po_id INTEGER,supplier_id INTEGER,branch_id INTEGER,received_at TEXT,total_cost REAL)',
  'CREATE TABLE supplier_invoices(id INTEGER PRIMARY KEY,invoice_number TEXT,purchase_order_id INTEGER,supplier_id INTEGER,branch_id INTEGER,invoice_date TEXT,status TEXT,total REAL)',
  'CREATE TABLE captured_supplier_invoices(id INTEGER PRIMARY KEY,invoice_number TEXT,purchase_order_id INTEGER,supplier_id INTEGER,branch_id INTEGER,invoice_date TEXT,status TEXT,total REAL,supplier_invoice_id INTEGER)',
  "INSERT INTO suppliers VALUES(1,'Tools & More')","INSERT INTO branches VALUES(1,'Main'),(2,'Other')",
  "INSERT INTO purchase_orders VALUES(1,'PO-001',1,1,'partial',100,'2026-10-26','Replenish'),(2,'PO-SECRET',1,2,'approved',999,'2026-10-25','Private')",
  "INSERT INTO purchase_requests VALUES(1,'PR-001',1,1,7,'converted','2026-10-24',1)",
  "INSERT INTO purchase_request_items VALUES(1,1,'Hammer',2,50,100)",
  "INSERT INTO purchase_order_items VALUES(1,1,'Hammer',2,1,50,100)",
  "INSERT INTO purchase_receipts VALUES(1,'GRN-001',1,1,1,'2026-10-26',50)",
  "INSERT INTO supplier_invoices VALUES(1,'INV-001',1,1,1,'2026-10-26','posted',50)",
  "INSERT INTO captured_supplier_invoices VALUES(1,'INV-CAP',1,1,1,'2026-10-26','captured',50,NULL)"
 ].map(sql=>({sql,args:[]})),'write');
 const app=require('express')();app.use((req,res,next)=>{const role=req.headers['x-role']||'staff';if(role!=='anonymous')req.employee={id:7,default_branch_id:role==='unassigned'?null:1,permissions:role==='denied'?{}:role==='requester'?{pr_create:true}:role==='finance'?{reports_financial:true}:role==='admin'?{purchasing:true,purchase_requests:true,reports_financial:true,branches:true}:{purchasing:true,purchase_requests:true}};next()});app.use('/register',require('../routes/purchasing-register'));server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port+'/register';
});
after(async()=>{if(server)await new Promise(r=>server.close(r));db.close();fs.rmSync(dir,{recursive:true,force:true})});
async function get(p='',role='staff'){const r=await fetch(base+p,{headers:{'x-role':role}});return {status:r.status,body:await r.json()}}
test('register searches real records and keeps invoice authority separate',async()=>{const r=await get('','admin');assert.equal(r.status,200);assert.equal(r.body.total,6);assert.deepEqual(r.body.records.filter(x=>x.type.includes('invoice')).map(x=>x.type).sort(),['captured_invoice','invoice']);assert.equal((await get('?q=GRN-001')).body.total,1);assert.equal((await get('?q=%27%20OR%201%3D1--')).body.total,0);assert.equal((await get('?type=po&status=partial')).body.records[0].number,'PO-001')});
test('permissions and branch scopes cover lists, detail and related links',async()=>{assert.equal((await get('','anonymous')).status,401);assert.equal((await get('','denied')).status,403);const r=await get();assert.equal(r.body.records.some(x=>x.number==='PO-SECRET'),false);assert.equal(r.body.records.some(x=>x.type==='invoice'),false);assert.equal((await get('/po/2')).status,404);assert.equal((await get('/invoice/1')).status,403);assert.equal((await get('?branch_id=2')).status,403);const pr=await get('','requester');assert.deepEqual(pr.body.records.map(x=>x.type),['pr']);assert.equal((await get('','unassigned')).body.total,1);});
test('detail follows the authorized PO chain and includes remaining line quantities',async()=>{const d=await get('/po/1','admin');assert.equal(d.status,200);assert.equal(d.body.lines[0].quantity_ordered-d.body.lines[0].quantity_received,1);assert.deepEqual(new Set(d.body.related.map(x=>x.type)),new Set(['pr','receipt','invoice','captured_invoice']));const s=await get('/po/1');assert.equal(s.body.related.some(x=>x.type==='invoice'),false)});
test('pagination and invalid filters fail predictably; reads do not create tables',async()=>{const a=await get('?limit=2','admin'),b=await get('?limit=2&offset=2','admin');assert.equal(a.body.records.length,2);assert.equal(b.body.records.length,2);assert.equal(new Set([...a.body.records,...b.body.records].map(x=>x.type+':'+x.id)).size,4);assert.equal((await get('?limit=-1')).status,400);assert.equal((await get('?type=madeup')).status,400);assert.equal((await get('?start=bad')).status,400);assert.equal((await get('/po/abc')).status,400);assert.ok(a.body.unavailable.includes('credit'));});

test('supplier returns, credits and payment records retain their PO trail',async()=>{
 await db.batch([
 'CREATE TABLE supplier_returns(id INTEGER PRIMARY KEY,return_number TEXT,po_id INTEGER,supplier_id INTEGER,branch_id INTEGER,status TEXT,created_at TEXT)',
 'CREATE TABLE supplier_credit_notes(id INTEGER PRIMARY KEY,credit_number TEXT,supplier_invoice_id INTEGER,supplier_id INTEGER,branch_id INTEGER,status TEXT,credit_date TEXT,total_cents INTEGER)',
 'CREATE TABLE supplier_payments(id INTEGER PRIMARY KEY,payment_number TEXT,supplier_id INTEGER,branch_id INTEGER,payment_date TEXT,amount REAL)',
 'CREATE TABLE supplier_payment_allocations(id INTEGER PRIMARY KEY,payment_id INTEGER,supplier_invoice_id INTEGER,amount REAL)',
 "INSERT INTO supplier_returns VALUES(1,'RET-001',1,1,1,'dispatched','2026-10-26')",
 "INSERT INTO supplier_credit_notes VALUES(1,'CN-001',1,1,1,'posted','2026-10-26',2500)",
 "INSERT INTO supplier_payments VALUES(1,'PAY-001',1,1,'2026-10-26',25)",
 'INSERT INTO supplier_payment_allocations VALUES(1,1,1,25)'
 ].map(sql=>({sql,args:[]})),'write');
 const credit=await get('/credit/1','admin');assert.equal(credit.body.record.amount,25);assert.equal(credit.body.record.po_id,1);
 const po=await get('/po/1','admin');assert.ok(po.body.related.some(x=>x.number==='PAY-001'));assert.ok(po.body.related.some(x=>x.number==='RET-001'));
 const payment=await get('/payment/1','admin');assert.equal(payment.body.related[0].number,'INV-001');assert.equal((await get('/payment/1')).status,403);
 const before=(await db.execute({sql:"SELECT COUNT(*) n FROM sqlite_master WHERE type='table'",args:[]})).rows[0].n;
 await get('','admin');await get('/po/1','admin');
 assert.equal((await db.execute({sql:"SELECT COUNT(*) n FROM sqlite_master WHERE type='table'",args:[]})).rows[0].n,before);
});
test('request totals preserve GCT and source currency; invoice links use receipt evidence',async()=>{
 await db.batch([
 'ALTER TABLE purchase_requests ADD COLUMN currency TEXT','ALTER TABLE purchase_requests ADD COLUMN tax_amount REAL',
 "UPDATE purchase_requests SET currency='USD',tax_amount=15 WHERE id=1",
 'CREATE TABLE purchase_receipt_items(id INTEGER PRIMARY KEY,receipt_id INTEGER,product_name TEXT,sku TEXT)',
 'CREATE TABLE supplier_invoice_receipt_allocations(id INTEGER PRIMARY KEY,supplier_invoice_id INTEGER,purchase_receipt_item_id INTEGER,quantity_invoiced REAL,invoice_unit_cost_cents INTEGER,invoice_line_cents INTEGER)',
 "INSERT INTO purchase_receipt_items VALUES(1,1,'Hammer','H1')",'INSERT INTO supplier_invoice_receipt_allocations VALUES(1,1,1,1,5000,5000)'
 ].map(sql=>({sql,args:[]})),'write');
 const pr=(await get('/pr/1','admin')).body.record;assert.equal(pr.amount,115);assert.equal(pr.currency,'USD');
 const invoice=(await get('/invoice/1','admin')).body;assert.equal(invoice.lines[0].quantity,1);assert.equal(invoice.lines[0].unit_cost,50);assert.equal(invoice.related.find(x=>x.type==='receipt').relationship,'Matched receipt evidence');
});
