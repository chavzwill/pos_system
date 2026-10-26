'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pos-invoice-capture-'));
process.env.TURSO_DATABASE_URL='file:'+path.join(dir,'test.db');
const {db}=require('../database');
const express=require('express');
let server,base;
const execute=(sql,args=[])=>db.execute({sql,args});
async function api(method,url,body,role='finance',key){
 const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json','X-Test-Role':role,...(key?{'Idempotency-Key':key}:{})},body:body===undefined?undefined:JSON.stringify(body)});
 return{status:r.status,body:await r.json()};
}
const payload=(number='INV-001')=>({purchase_order_id:1,invoice_number:number,invoice_date:'2026-10-23',subtotal:20,total:20});
const capture=(number,key=('capture-operation-'+number).replace(/[^A-Za-z0-9_.:-]/g,''))=>api('POST','/captured-invoices',payload(number),'receiver',key);
const lines=(receipt=1,qty='2',cost='10.00')=>({lines:[{receipt_item_id:receipt,quantity_invoiced:qty,invoice_unit_cost:cost}]});
before(async()=>{
 await db.batch([
  'CREATE TABLE suppliers(id INTEGER PRIMARY KEY,name TEXT,active INTEGER)',
  'CREATE TABLE branches(id INTEGER PRIMARY KEY,name TEXT)',
  'CREATE TABLE employees(id INTEGER PRIMARY KEY,first_name TEXT,last_name TEXT)',
  'CREATE TABLE purchase_orders(id INTEGER PRIMARY KEY,po_number TEXT,supplier_id INTEGER,branch_id INTEGER,status TEXT,subtotal REAL,total REAL)',
  'CREATE TABLE purchase_order_items(id INTEGER PRIMARY KEY,po_id INTEGER)',
  'CREATE TABLE products(id INTEGER PRIMARY KEY,stock REAL)',
  'CREATE TABLE transaction_items(id INTEGER PRIMARY KEY,unit_cost_at_sale REAL)',
  'CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT)',
  "INSERT INTO suppliers VALUES(1,'Supplier One',1),(2,'Supplier Two',1)",
  "INSERT INTO branches VALUES(1,'Main'),(2,'Other')",
  "INSERT INTO employees VALUES(1,'Test','Finance')",
  "INSERT INTO purchase_orders VALUES(1,'PO-1',1,1,'received',1000,1000),(2,'PO-2',2,2,'received',1000,1000)",
  'INSERT INTO purchase_order_items VALUES(1,1),(2,2)',
  'INSERT INTO products VALUES(1,10)'
 ],'write');
 const app=express();app.use(express.json());
 app.use((req,res,next)=>{const role=req.headers['x-test-role'];const unassigned=['unassigned','unassigned-multi'].includes(role);req.employee={id:1,default_branch_id:unassigned?null:role==='other'?2:1,permissions:role==='receiver'?{purchasing_receive:true}:role==='none'?{}:{reports_financial:true,...(['multi','unassigned-multi'].includes(role)?{multi_branch_access:true}:{})}};if(role==='key')req.apiKey={};next();});
 app.use(require('../routes/supplier-invoice-capture'));
 app.use(require('../routes/supplier-invoice-loss-prevention'));
 app.use(require('../routes/supplier-ledger'));
 app.use('/receipt-links',require('../routes/purchase-receipt-invoice-links'));
 app.use((req,res)=>res.status(404).json({error:'Route not implemented'}));
 const {ensureReceiptInvoiceLinkSchema}=require('../routes/purchase-receipt-invoice-links');await ensureReceiptInvoiceLinkSchema();
 await db.batch([
  "INSERT INTO purchase_receipts(id,receipt_number,po_id,supplier_id,branch_id) VALUES(1,'GR-1',1,1,1),(2,'GR-2',1,1,1),(3,'GR-OTHER',2,2,2)",
  "INSERT INTO purchase_receipt_items(id,receipt_id,po_item_id,product_id,quantity_received,unit_cost,line_cost) VALUES(1,1,1,1,2,10,20),(2,2,1,1,3,10,30),(3,3,2,1,3,10,30)"
 ],'write');
 await new Promise(resolve=>{server=app.listen(0,'127.0.0.1',resolve)});base='http://127.0.0.1:'+server.address().port;
});
after(async()=>{
 if(server)await new Promise(resolve=>server.close(resolve));
 db.close();
 // Windows can retain the native SQLite file handle briefly after close.
 const resolved=path.resolve(dir),temporaryRoot=path.resolve(os.tmpdir())+path.sep;
 assert.ok(resolved.startsWith(temporaryRoot)&&path.basename(resolved).startsWith('pos-invoice-capture-'));
 await fs.promises.rm(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:100});
});
test('capture and match are separate from AP and stock; Finance posts once with delivery evidence',async()=>{
 const saved=await capture('INV-001');assert.equal(saved.status,201,JSON.stringify(saved.body));const id=saved.body.id;
 assert.equal(saved.body.status,'captured');
 assert.equal((await execute('SELECT COUNT(*) n FROM supplier_invoices')).rows[0].n,0);
 assert.equal((await execute('SELECT stock FROM products WHERE id=1')).rows[0].stock,10);
 const linked=await api('POST',`/captured-invoices/${id}/allocate`,lines(),'receiver','allocate-operation-001');assert.equal(linked.status,201,JSON.stringify(linked.body));
 assert.equal((await api('GET','/overview')).body.summary.open_ap,0);
 const refused=await api('POST','/invoices',{captured_invoice_id:id},'receiver');assert.equal(refused.status,403);
 const posted=await api('POST','/invoices',{captured_invoice_id:id});assert.equal(posted.status,201,JSON.stringify(posted.body));
 const retry=await api('POST','/invoices',{captured_invoice_id:id});assert.equal(retry.status,200);assert.equal(retry.body.id,posted.body.id);assert.equal(retry.body.replayed,true);
 assert.equal((await execute('SELECT COUNT(*) n FROM supplier_invoices')).rows[0].n,1);
 assert.equal((await execute('SELECT COUNT(*) n FROM supplier_ledger_events WHERE event_type=\'invoice_posted\'')).rows[0].n,1);
 assert.equal((await execute('SELECT COUNT(*) n FROM supplier_invoice_receipt_allocations')).rows[0].n,1);
 assert.equal((await api('GET','/overview')).body.summary.open_ap,20);
 assert.equal((await execute('SELECT stock FROM products WHERE id=1')).rows[0].stock,10);
 assert.equal((await execute('SELECT match_status FROM supplier_invoice_match_controls WHERE supplier_invoice_id=?',[posted.body.id])).rows[0].match_status,'matched');
});
test('capture replay, identity protection, branches, dates and financial input validation',async()=>{
 const saved=await capture('INV-002');assert.equal(saved.status,201);
 assert.equal((await capture('INV-002')).body.id,saved.body.id);
 assert.equal((await api('POST','/captured-invoices',{...payload('DIFFERENT')},'receiver','capture-operation-INV-002')).status,409);
 assert.equal((await capture('inv 002')).status,409);
 assert.equal((await api('POST','/invoices',{...payload('INV-002'),supplier_id:1,branch_id:1})).status,409);
 assert.equal((await api('GET','/captured-invoices?purchase_order_id=1',undefined,'other')).status,403);
 assert.equal((await api('POST','/captured-invoices',payload('INVALID'),'other','invalid-branch-key')).status,403);
 assert.equal((await api('POST','/captured-invoices',payload('INVALID'),'key','invalid-apikey-key')).status,403);
 for(const patch of [{invoice_date:'2026-02-30'},{subtotal:-1},{subtotal:'NaN'},{subtotal:20.001},{total:21}])assert.equal((await api('POST','/captured-invoices',{...payload('BAD'),...patch},'receiver','invalid-input-key')).status,400);
});
test('pending allocations reserve receipt quantities, support multiple invoices/deliveries, void releases units',async()=>{
 const a=await capture('INV-003'),b=await capture('INV-004');assert.equal(a.status,201);assert.equal(b.status,201);
 const aId=a.body.id,bId=b.body.id;
 assert.equal((await api('POST',`/captured-invoices/${aId}/allocate`,lines(2,'2'),'receiver','allocation-pending-a')).status,201);
 assert.equal((await api('POST',`/captured-invoices/${bId}/allocate`,lines(2,'2'),'receiver','allocation-pending-b')).status,409);
 assert.equal((await api('POST',`/captured-invoices/${bId}/allocate`,lines(3,'1'),'receiver','allocation-wrong-po')).status,409);
 assert.equal((await api('POST',`/captured-invoices/${aId}/void`,{reason:'Wrong invoice received'},'receiver')).status,200);
 assert.equal((await api('POST',`/captured-invoices/${bId}/allocate`,lines(2,'2'),'receiver','allocation-pending-b')).status,201);
 const posted=await api('POST','/invoices',{captured_invoice_id:bId});assert.equal(posted.status,201,JSON.stringify(posted.body));
 assert.equal((await api('POST','/invoices',{captured_invoice_id:aId})).status,409);
});
test('incomplete or cost-different evidence stays blocked from payment after posting',async()=>{
 const saved=await api('POST','/captured-invoices',{...payload('INV-005'),subtotal:10,total:10},'receiver','capture-operation-005');assert.equal(saved.status,201);
 assert.equal((await api('POST',`/captured-invoices/${saved.body.id}/allocate`,lines(2,'1','11.00'),'receiver','allocation-variance-5')).status,201);
 const posted=await api('POST','/invoices',{captured_invoice_id:saved.body.id});assert.equal(posted.status,201,JSON.stringify(posted.body));
 const status=(await execute('SELECT match_status FROM supplier_invoice_match_controls WHERE supplier_invoice_id=?',[posted.body.id])).rows[0].match_status;
 assert.equal(status,'receipt_amount_variance');
 const payment=await api('POST','/payments',{supplier_id:1,amount:20,payment_date:'2026-10-23',allocations:[{invoice_id:posted.body.id,amount:20}]});assert.equal(payment.status,409);
});
test('posting rolls back payable, source link and evidence together, then retries safely',async()=>{
 const saved=await api('POST','/captured-invoices',{...payload('ROLLBACK-1'),subtotal:10,total:10},'receiver','capture-rollback-one');assert.equal(saved.status,201);
 const id=saved.body.id;
 await execute("INSERT INTO purchase_receipts(id,receipt_number,po_id,supplier_id,branch_id) VALUES(4,'GR-4',1,1,1)");
 await execute('INSERT INTO purchase_receipt_items(id,receipt_id,po_item_id,product_id,quantity_received,unit_cost,line_cost) VALUES(4,4,1,1,5,10,50)');
 assert.equal((await api('POST',`/captured-invoices/${id}/allocate`,lines(4,'1'),'receiver','allocation-rollback-1')).status,201);
 const before=Number((await execute('SELECT COUNT(*) n FROM supplier_invoices')).rows[0].n);
 await execute("CREATE TRIGGER test_invoice_post_failure BEFORE INSERT ON supplier_invoice_receipt_allocations BEGIN SELECT RAISE(ABORT,'Simulated evidence failure'); END");
 const failed=await api('POST','/invoices',{captured_invoice_id:id});assert.equal(failed.status,400);
 assert.equal(Number((await execute('SELECT COUNT(*) n FROM supplier_invoices')).rows[0].n),before);
 const source=(await execute('SELECT status,supplier_invoice_id FROM captured_supplier_invoices WHERE id=?',[id])).rows[0];assert.equal(source.status,'captured');assert.equal(source.supplier_invoice_id,null);
 await execute('DROP TRIGGER test_invoice_post_failure');
 const posted=await api('POST','/invoices',{captured_invoice_id:id,total:999999});assert.equal(posted.status,201,JSON.stringify(posted.body));assert.equal(posted.body.total,10);
 assert.equal(Number((await execute('SELECT COUNT(*) n FROM supplier_invoices')).rows[0].n),before+1);
});
test('one captured invoice can cover several deliveries and concurrent posting cannot create a second payable',async()=>{
 const saved=await capture('MULTI-GR');assert.equal(saved.status,201);const id=saved.body.id;
 await execute("INSERT INTO purchase_receipts(id,receipt_number,po_id,supplier_id,branch_id) VALUES(5,'GR-5',1,1,1)");
 await execute('INSERT INTO purchase_receipt_items(id,receipt_id,po_item_id,product_id,quantity_received,unit_cost,line_cost) VALUES(5,5,1,1,2,10,20)');
 const linked=await api('POST',`/captured-invoices/${id}/allocate`,{lines:[...lines(4,'1').lines,...lines(5,'1').lines]},'receiver','allocation-multi-delivery');assert.equal(linked.status,201,JSON.stringify(linked.body));
 const info=await api('GET','/receipt-links/orders/1');assert.equal(info.status,200,JSON.stringify(info.body));assert.equal(info.body.captured_invoices.some(x=>Number(x.id)===Number(id)),true);
 const results=await Promise.all([api('POST','/invoices',{captured_invoice_id:id}),api('POST','/invoices',{captured_invoice_id:id})]);assert.equal(results.some(x=>x.status===201),true,JSON.stringify(results));
 const replay=await api('POST','/invoices',{captured_invoice_id:id});assert.equal(replay.status,200);
 assert.equal(Number((await execute("SELECT COUNT(*) n FROM supplier_invoices WHERE invoice_number='MULTI-GR'")).rows[0].n),1);
 assert.equal(Number((await execute('SELECT COUNT(*) n FROM supplier_invoice_receipt_allocations WHERE supplier_invoice_id=?',[replay.body.id])).rows[0].n),2);
 assert.equal((await api('POST',`/captured-invoices/${id}/void`,{reason:'No longer needed'},'receiver')).status,409);
});
test('capture cannot race a supplier identity already claimed by a posting operation',async()=>{
 await execute("INSERT INTO supplier_invoice_identity_claims(supplier_id,normalized_invoice_number,claim_token) VALUES(1,'INFLIGHT77','test-inflight-token')");
 const result=await capture('IN-FLIGHT-77');assert.equal(result.status,409,JSON.stringify(result.body));
 await execute("DELETE FROM supplier_invoice_identity_claims WHERE claim_token='test-inflight-token'");
});
test('a PO supplier change invalidates its captured invoice receipt matching',async()=>{
 const saved=await capture('PO-CHANGED');assert.equal(saved.status,201);
 await execute('UPDATE purchase_orders SET supplier_id=2 WHERE id=1');
 try{const result=await api('POST',`/captured-invoices/${saved.body.id}/allocate`,lines(4,'1'),'receiver','allocation-po-changed');assert.equal(result.status,409,JSON.stringify(result.body));}
 finally{await execute('UPDATE purchase_orders SET supplier_id=1 WHERE id=1');}
});

test('unassigned staff cannot read, capture, allocate, void or post branch invoice evidence',async()=>{
 const saved=await capture('BRANCH-GUARD');assert.equal(saved.status,201);
 const id=saved.body.id;
 const attempts=[
  ['GET','/captured-invoices?purchase_order_id=1'],
  ['GET','/receipt-links/orders/1'],
  ['POST','/captured-invoices',payload('UNASSIGNED-BLOCK')],
  ['POST','/captured-invoices/'+id+'/allocate',lines(4,'1')],
  ['POST','/captured-invoices/'+id+'/void',{reason:'Unassigned attempt'}],
  ['POST','/invoices',{captured_invoice_id:id}],
 ];
 for(const [method,url,body] of attempts){
  const result=await api(method,url,body,'unassigned','unassigned-branch-operation');
  assert.equal(result.status,403,method+' '+url+' '+JSON.stringify(result.body));
 }
 assert.equal((await execute('SELECT status FROM captured_supplier_invoices WHERE id=?',[id])).rows[0].status,'captured');
 assert.equal((await execute("SELECT COUNT(*) n FROM supplier_invoices WHERE invoice_number='BRANCH-GUARD'")).rows[0].n,0);
});
test('explicit multi-branch staff and Finance-only staff can read authorized reconciliation',async()=>{
 for(const role of ['finance','receiver','multi','unassigned-multi']){
  for(const url of ['/captured-invoices?purchase_order_id=1','/receipt-links/orders/1']){
   const result=await api('GET',url,undefined,role);
   assert.equal(result.status,200,role+' '+url+' '+JSON.stringify(result.body));
  }
 }
 assert.equal((await api('GET','/receipt-links/orders/2',undefined,'multi')).status,200);
 assert.equal((await api('GET','/receipt-links/orders/1',undefined,'other')).status,403);
 assert.equal((await api('GET','/receipt-links/orders/1',undefined,'none')).status,403);
 assert.equal((await api('GET','/receipt-links/orders/1',undefined,'key')).status,403);
});
test('pending and posted evidence share one receipt allocation count for Finance review',async()=>{
 await execute("INSERT INTO purchase_receipts(id,receipt_number,po_id,supplier_id,branch_id) VALUES(6,'GR-SHARED',1,1,1)");
 await execute('INSERT INTO purchase_receipt_items(id,receipt_id,po_item_id,product_id,quantity_received,unit_cost,line_cost) VALUES(6,6,1,1,2,10,20)');
 const saved=await capture('SHARED-ALLOCATION');assert.equal(saved.status,201);
 assert.equal((await api('POST','/captured-invoices/'+saved.body.id+'/allocate',lines(6,'1'),'receiver','shared-pending-allocation')).status,201);
 let review=await api('GET','/receipt-links/orders/1');
 assert.equal(review.body.receipt_items.find(x=>Number(x.receipt_item_id)===6).remaining_qty,1);
 const posted=await api('POST','/invoices',{captured_invoice_id:saved.body.id});assert.equal(posted.status,201);
 review=await api('GET','/receipt-links/orders/1');
 assert.equal(review.body.receipt_items.find(x=>Number(x.receipt_item_id)===6).remaining_qty,1);
 const second=await capture('SHARED-SECOND');assert.equal(second.status,201);
 assert.equal((await api('POST','/captured-invoices/'+second.body.id+'/allocate',lines(6,'2'),'receiver','shared-overallocation')).status,409);
 assert.equal((await execute("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='purchase_receipt_invoice_evidence'")).rows[0].n,0);
});

test('branch guard rejects malformed assignments and nonboolean multi-branch claims',()=>{
 const {assertPurchaseInvoiceBranch:guard}=require('../lib/purchase-invoice-branch-access');
 const req=(branch,permissions={})=>({employee:{id:1,default_branch_id:branch,permissions}});
 for(const branch of [null,undefined,'',0,-1,'invalid',1.5]){
  assert.throws(()=>guard(req(branch),{branch_id:1}),e=>e.status===403);
 }
 for(const claim of ['false','true',1,{}]){
  assert.throws(()=>guard(req(null,{multi_branch_access:claim}),{branch_id:1}),e=>e.status===403);
 }
 for(const permissions of [{multi_branch_access:true},{branches:true},{branches_add:true},{security:true},{security_manage:true}]){
  assert.doesNotThrow(()=>guard(req(null,permissions),{branch_id:2}));
 }
 for(const branch_id of [null,0,'',-1,'invalid']){
  assert.throws(()=>guard(req(1,{multi_branch_access:true}),{branch_id}),e=>e.status===403);
 }
 assert.throws(()=>guard({...req(1),apiKey:{}},{branch_id:1}),e=>e.status===403);
 assert.throws(()=>guard({},{branch_id:1}),e=>e.status===403);
});
test('posted allocation and replay reject unassigned staff before evidence or operation lookup',async()=>{
 const invoice=(await execute("SELECT id FROM supplier_invoices WHERE invoice_number='INV-001'")).rows[0];
 const url='/receipt-links/orders/1/invoices/'+invoice.id+'/allocate';
 const before=Number((await execute('SELECT COUNT(*) n FROM supplier_invoice_receipt_allocations')).rows[0].n);
 for(const op of ['posted-new-branch-key','posted-replay-branch-key']){
  await execute('INSERT OR IGNORE INTO supplier_invoice_receipt_operations(operation_key,fingerprint,result_json) VALUES(?,?,?)',['receipt-invoice:'+invoice.id+':'+op,'fixture-fingerprint','{"fixture":"private branch result"}']);
  const denied=await api('POST',url,lines(1,'1'),'unassigned',op);
  assert.equal(denied.status,403,JSON.stringify(denied.body));
  assert.equal(denied.body.code,'BRANCH_FORBIDDEN');
 }
 assert.equal(Number((await execute('SELECT COUNT(*) n FROM supplier_invoice_receipt_allocations')).rows[0].n),before);
 const replay=await api('POST','/invoices',{captured_invoice_id:1},'unassigned');
 assert.equal(replay.status,403,JSON.stringify(replay.body));
});
