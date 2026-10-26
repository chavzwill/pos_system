const test=require('node:test');
const assert=require('node:assert/strict');
const {createClient}=require('@libsql/client');
const path=require('node:path').join(require('node:os').tmpdir(),'supplier-credit-'+require('node:crypto').randomUUID()+'.db');
const db=createClient({url:'file:'+path});
require.cache[require.resolve('../database')]={exports:{db}};
const credits=require('../lib/supplier-credit-notes');
test('credit settlement is atomic, preserves cash payments, caps allocations and refunds',async()=>{
 await db.execute('PRAGMA foreign_keys=OFF');
 await db.batch(['CREATE TABLE employees(id INTEGER PRIMARY KEY)','CREATE TABLE suppliers(id INTEGER PRIMARY KEY)','CREATE TABLE branches(id INTEGER PRIMARY KEY)','CREATE TABLE purchase_orders(id INTEGER PRIMARY KEY)'].map(sql=>({sql})), 'write');
 await db.batch(['INSERT INTO employees VALUES(1)','INSERT INTO suppliers VALUES(1)','INSERT INTO branches VALUES(1)','INSERT INTO purchase_orders VALUES(2)'].map(sql=>({sql})), 'write');
 await credits.ensureSupplierCreditSchema();
 await db.execute("INSERT INTO supplier_invoices(id,supplier_id,branch_id,invoice_number,invoice_date,subtotal,total) VALUES(1,1,1,'INV','2026-10-24',100,100)");
 await db.execute("INSERT INTO supplier_payments(id,payment_number,supplier_id,payment_date,amount) VALUES(1,'PAY',1,'2026-10-24',80)");
 await db.execute('INSERT INTO supplier_payment_allocations(payment_id,supplier_invoice_id,amount) VALUES(1,1,80)');
 await db.execute("INSERT INTO supplier_credit_notes(id,return_id,supplier_invoice_id,supplier_id,branch_id,credit_number,credit_date,reason,merchandise_cents,tax_cents,total_cents,carrying_cents,status) VALUES(1,1,1,1,1,'CR','2026-10-24','damaged',5000,0,5000,5000,'posted')");
 let tx=await db.transaction('write');
 await credits.applyCredit(tx,1,1,2000); await credits.postSupplierCreditJournal(tx,1,1); await tx.commit();
 assert.equal((await require('../lib/supplier-ap-balances').invoiceBalance(db,1)).balance_cents,0);
 assert.equal((await credits.getCredit(db,1)).available_cents,3000);
 tx=await db.transaction('write');await assert.rejects(credits.applyCredit(tx,1,1,1),/balance/);await tx.rollback();
 assert.equal(Number((await db.execute('SELECT SUM(amount) n FROM supplier_payment_allocations')).rows[0].n),80);
 assert.equal(Number((await db.execute("SELECT SUM(debit-credit) n FROM journal_lines")).rows[0].n),0);
 const {netSupplierAp}=require('../lib/supplier-ap-balances');
 // The cash payment has a NULL branch, but its allocation belongs to branch 1.
 assert.equal(await netSupplierAp(db,1),-30);
 assert.equal(await netSupplierAp(db,null),-30);
 await db.execute("INSERT INTO supplier_payments(id,payment_number,supplier_id,branch_id,payment_date,amount) VALUES(90,'UNAPPLIED',1,1,'2026-10-24',5)");
 assert.equal(await netSupplierAp(db,1),-35);
 assert.equal(await netSupplierAp(db,2),0);
});

test('capture provenance, role and branch replay checks; Finance post and refund are exactly once',async()=>{
 await db.batch([
  {sql:'CREATE TABLE supplier_returns(id INTEGER PRIMARY KEY,po_id INTEGER,supplier_id INTEGER,branch_id INTEGER,status TEXT)'},
  {sql:'CREATE TABLE supplier_return_items(id INTEGER PRIMARY KEY,return_id INTEGER,receipt_item_id INTEGER,quantity REAL,tracked_quantity REAL,tracked_value REAL,carrying_cents INTEGER)'},
  {sql:'CREATE TABLE supplier_invoice_receipt_allocations(id INTEGER PRIMARY KEY,supplier_invoice_id INTEGER,purchase_receipt_item_id INTEGER,quantity_invoiced REAL,invoice_unit_cost_cents INTEGER,invoice_line_cents INTEGER)'},
  {sql:"INSERT INTO supplier_returns VALUES(2,2,1,1,'approved')"},
  {sql:'INSERT INTO supplier_return_items VALUES(2,2,2,2,0,0,NULL)'},
  {sql:"INSERT INTO supplier_invoices(id,supplier_id,purchase_order_id,branch_id,invoice_number,invoice_date,subtotal,total) VALUES(2,1,2,1,'INV2','2026-10-24',20,20)"},
  {sql:'INSERT INTO supplier_invoice_receipt_allocations VALUES(2,2,2,2,1000,2000)'},
  {sql:"INSERT INTO supplier_payments(id,payment_number,supplier_id,payment_date,amount) VALUES(2,'PAY2',1,'2026-10-24',20)"},
  {sql:'INSERT INTO supplier_payment_allocations(payment_id,supplier_invoice_id,amount) VALUES(2,2,20)'}
 ],'write');
 const app=require('express')();app.use(require('express').json());app.use((req,res,next)=>{const role=req.headers.role;req.employee={id:1,default_branch_id:role==='no-branch'?null:role==='other'?2:1,permissions:role==='receiver'?{purchasing_receive:true}:{reports_financial:true}};next();});app.use('/payment-check',require('../routes/supplier-payment-operation-guard'));app.use(require('../routes/supplier-credit-notes'));
 const server=await new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server))});
 const api=async(path,body,key,role='finance')=>{const r=await fetch('http://127.0.0.1:'+server.address().port+path,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key,role},body:JSON.stringify(body)});return{status:r.status,body:await r.json()};};
 try{
 const payload={return_id:2,supplier_invoice_id:2,credit_number:'CR2',credit_date:'2026-10-24',reason:'Damaged delivery',lines:[{return_item_id:2,quantity:2,unit_credit:10}],tax_amount:0,total:20};
 const captured=await api('/',payload,'capture-credit-test','receiver');assert.equal(captured.status,201,JSON.stringify(captured));const id=captured.body.id;
 assert.equal(captured.body.available_cents,0);
 assert.equal((await api('/',payload,'capture-credit-test','no-branch')).status,403);
 assert.equal((await api('/'+id+'/post',{},'post-credit-test','no-branch')).status,403);
 assert.equal((await api('/payment-check/payments',{supplier_id:1,amount:1,payment_date:'2026-10-24'},'payment-no-branch-test','no-branch')).status,403);
 for(const url of ['/', '/'+id]){const denied=await fetch('http://127.0.0.1:'+server.address().port+url,{headers:{role:'no-branch'}});assert.equal(denied.status,403);}
 assert.equal((await api('/',payload,'capture-credit-test','other')).status,403);
 assert.equal((await api('/',{...payload,total:19},'capture-credit-test')).status,409);
 assert.equal((await api('/',{...payload,credit_number:'CR3'},'capture-credit-over')).status,409);
 assert.equal((await api('/'+id+'/post',{},'post-credit-test','receiver')).status,403);
 assert.equal((await api('/'+id+'/post',{},'post-credit-test')).status,409);
 await db.execute("UPDATE supplier_returns SET status='dispatched' WHERE id=2");await db.execute('UPDATE supplier_return_items SET tracked_quantity=2,tracked_value=18 WHERE id=2');
 assert.equal((await api('/'+id+'/post',{},'post-credit-test')).status,400);
 const posted=await api('/'+id+'/post',{variance_reason:'Supplier full price versus carrying cost'},'post-credit-test');assert.equal(posted.status,200,JSON.stringify(posted));assert.equal(posted.body.carrying_cents,1800);assert.equal(posted.body.available_cents,2000);
 const refund={amount:20,refund_date:'2026-10-24',payment_method:'bank',reference:'BANK-REF',reason:'Supplier reimbursement'};
 assert.equal((await api('/'+id+'/refunds',refund,'refund-credit-test')).status,201);
 assert.equal((await api('/'+id+'/refunds',refund,'refund-credit-test')).body.replayed,true);
 assert.equal((await api('/'+id+'/refunds',refund,'refund-credit-more')).status,409);
 assert.equal(Number((await db.execute("SELECT COUNT(*) n FROM journal_entries WHERE source_type='supplier_credit_refund'")).rows[0].n),1);
 assert.equal(Number((await db.execute("SELECT COUNT(*) n FROM supplier_credit_refunds")).rows[0].n),1);
 // Independent fractional rounding must not borrow cents from other invoiced receipts.
 await db.batch([
  {sql:"INSERT INTO supplier_returns VALUES(3,2,1,1,'approved')"},
  {sql:'INSERT INTO supplier_return_items VALUES(3,3,3,1,0,0,NULL)'},
  {sql:"INSERT INTO supplier_invoices(id,supplier_id,purchase_order_id,branch_id,invoice_number,invoice_date,subtotal,total) VALUES(3,1,2,1,'FRACTIONAL','2026-10-24',0.02,0.02)"},
  {sql:'INSERT INTO supplier_invoice_receipt_allocations VALUES(3,3,3,1,1,1)'}
 ],'write');
 const fractional={return_id:3,supplier_invoice_id:3,credit_number:'FRACTIONAL-1',credit_date:'2026-10-24',reason:'Partial fractional merchandise',lines:[{return_item_id:3,quantity:0.5,unit_credit:0.01}],tax_amount:0,total:0.01};
 assert.equal((await api('/',fractional,'fractional-credit-one')).status,201);
 const split=await api('/',{...fractional,credit_number:'FRACTIONAL-2'},'fractional-credit-two');assert.equal(split.status,409);assert.match(split.body.error,/original invoice receipt line amount/);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
require('node:test').after(async()=>{db.close();require('node:fs').rmSync(path,{force:true});});
