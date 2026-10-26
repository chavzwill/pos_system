'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const filename=require('node:path').join(require('node:os').tmpdir(),'consumable-recovery-'+require('node:crypto').randomUUID()+'.db');
const db=require('@libsql/client').createClient({url:'file:'+filename});
require.cache[require.resolve('../database')]={exports:{db}};
const core=require('../lib/consumable-corrections');
const statement=(sql,args=[])=>({sql,args});
let server,url;
async function api(path,body,key,role='receiver',actor=1){const result=await fetch(url+path,{method:body==null?'GET':'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key||'',role,actor:String(actor)},...(body==null?{}:{body:JSON.stringify(body)})});return{status:result.status,body:await result.json()};}
async function ok(path,body,key,role,actor){const r=await api(path,body,key,role,actor);assert.ok(r.status>=200&&r.status<300,JSON.stringify(r));return r.body;}
test.before(async()=>{
 await db.batch([`CREATE TABLE employees(id INTEGER PRIMARY KEY)`,`CREATE TABLE suppliers(id INTEGER PRIMARY KEY,name TEXT,active INTEGER)`,`CREATE TABLE branches(id INTEGER PRIMARY KEY,name TEXT,active INTEGER)`,`CREATE TABLE products(id INTEGER PRIMARY KEY,stock_qty INTEGER,name TEXT)`,`CREATE TABLE purchase_orders(id INTEGER PRIMARY KEY)`,`CREATE TABLE customers(id INTEGER PRIMARY KEY)`,`INSERT INTO employees VALUES(1),(2),(3)`,`INSERT INTO suppliers VALUES(1,'Supplier',1)`,`INSERT INTO branches VALUES(1,'One',1),(2,'Two',1)`,`INSERT INTO products VALUES(1,77,'Retail')`].map(s=>statement(s)),'write');
 await require('../lib/consumable-recovery').ensureConsumableRecoverySchema();
 await db.batch([`INSERT INTO consumable_catalog(id,sku,name) VALUES(1,'OIL','Oil')`,`INSERT INTO consumable_purchase_orders(id,po_number,supplier_id,branch_id,reason,requested_for,status) VALUES(1,'CPO-1',1,1,'Work','Workshop','received')`,`INSERT INTO consumable_po_lines(id,po_id,consumable_id,quantity_ordered,quantity_received,unit_cost_cents) VALUES(1,1,1,10,10,100)`,`INSERT INTO consumable_movements(id,consumable_id,branch_id,action,quantity,value_cents,po_id,po_line_id,purpose) VALUES(1,1,1,'receive',10,1000,1,1,'Original receipt'),(2,1,1,'issue',3,100,NULL,NULL,'Maintenance')`,`INSERT INTO consumable_balances VALUES(1,1,7,700,CURRENT_TIMESTAMP)`,`INSERT INTO supplier_invoices(id,supplier_id,branch_id,invoice_number,invoice_date,subtotal,tax_amount,tax_treatment,total) VALUES(1,1,1,'INV-1','2026-10-25',10,1.5,'recoverable',11.5)`].map(s=>statement(s)),'write');
 const app=require('express')();app.use(require('express').json());app.use((req,res,next)=>{const r=req.headers.role;req.employee={id:Number(req.headers.actor||1),default_branch_id:r==='other'?2:r==='unassigned'?null:1,permissions:r==='issuer'?{inventory_adjust:true}:r==='finance'?{reports_financial:true}:r==='denied'?{}:{purchasing:true,purchasing_create:true,purchasing_receive:true,purchasing_approve:true}};next();});app.use('/base',require('../routes/consumables'));app.use('/recovery',require('../routes/consumable-recovery'));app.use(require('../routes/consumable-corrections'));server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});url='http://127.0.0.1:'+server.address().port;
});
test.after(async()=>{if(server)await new Promise(r=>server.close(r));db.close();for(const f of [filename,filename+'-wal',filename+'-shm'])try{fs.unlinkSync(f);}catch{}});
test('unused supply returns preserve cumulative issue cents and immutable history, with source-authorized replay',async()=>{
 const path='/recovery/issues/2/return',body={quantity:1,reason:'Unused sealed supplies'};
 const first=await ok(path,body,'issue-return-first','issuer');assert.equal(first.value_cents,33);
 assert.equal((await ok(path,body,'issue-return-first','issuer')).replayed,true);
 assert.equal((await api(path,body,'issue-return-first','other')).status,403);
 assert.equal((await api(path,body,'issue-return-first','denied')).status,403);
 assert.equal((await api(path,body,'issue-return-first','issuer',2)).status,409);
 const outcomes=await Promise.all([api(path,{quantity:2,reason:'Remaining supplies'},'issue-return-race-a','issuer'),api(path,{quantity:2,reason:'Remaining supplies'},'issue-return-race-b','issuer')]);
 assert.equal(outcomes.filter(x=>x.status===200).length,1,JSON.stringify(outcomes));assert.equal(outcomes.filter(x=>x.status===409).length,1,JSON.stringify(outcomes));
 const rows=(await db.execute('SELECT * FROM consumable_issue_returns')).rows;assert.equal(rows.length,2);assert.equal(rows.reduce((n,r)=>n+Number(r.value_cents),0),100);
 const b=(await db.execute('SELECT * FROM consumable_balances')).rows[0];assert.equal(Number(b.qty_on_hand),10);assert.equal(Number(b.value_cents),800);
 assert.equal(Number((await db.execute('SELECT value_cents FROM consumable_movements WHERE id=2')).rows[0].value_cents),100);
 assert.equal(Number((await db.execute('SELECT stock_qty FROM products')).rows[0].stock_qty),77);
 const lines=(await db.execute("SELECT a.code,SUM(ROUND(l.debit*100)) debit,SUM(ROUND(l.credit*100)) credit FROM journal_lines l JOIN ledger_accounts a ON a.id=l.ledger_account_id JOIN journal_entries j ON j.id=l.journal_entry_id WHERE j.source_type='consumable_issue_return' GROUP BY a.code")).rows;
 assert.deepEqual(lines.map(x=>[x.code,Number(x.debit),Number(x.credit)]),[['1280',100,0],['5460',0,100]]);
 await assert.rejects(db.execute('UPDATE consumable_issue_returns SET quantity=2'),/immutable/);await assert.rejects(db.execute('DELETE FROM consumable_issue_returns'),/immutable/);
});
test('additive closure evidence releases requested receipt reservations without changing deployed CHECK schemas',async()=>{
 const payload={reason:'Damaged supplies',items:[{receipt_movement_id:1,quantity:10}]};const r=await ok('/returns',payload,'return-reserve-all');
 assert.equal((await api('/returns',payload,'return-reserve-too')).status,409);
 assert.equal((await api('/recovery/returns/'+r.id+'/reject',{reason:'Review rejected'},'return-reject-self')).status,403);
 await ok('/recovery/returns/'+r.id+'/reject',{reason:'Review rejected'},'return-reject-other','receiver',2);
 assert.equal((await core.getReturn(db,r.id)).status,'rejected');
 assert.equal((await db.execute('SELECT status FROM consumable_returns WHERE id='+r.id)).rows[0].status,'requested');
 const next=await ok('/returns',payload,'return-reserve-new');await ok('/returns/'+next.id+'/approve',{},'return-approve-new','receiver',2);await ok('/returns/'+next.id+'/dispatch',{},'return-dispatch-new');
 assert.equal((await api('/recovery/returns/'+next.id+'/cancel',{reason:'Too late'},'return-cancel-late','receiver',2)).status,409);
 await assert.rejects(db.execute('UPDATE consumable_document_closures SET reason=\'edited\''),/immutable/);
});
test('void captured credits releases all quantity, carrying, merchandise, tax and invoice reservations',async()=>{
 await ok('/invoice-links',{supplier_invoice_id:1,items:[{receipt_movement_id:1,quantity:10,invoice_line_cents:1000}]},'invoice-match-recovery','finance');
 const r=(await db.execute("SELECT * FROM consumable_returns WHERE status='dispatched'")).rows[0],item=(await db.execute('SELECT * FROM consumable_return_items WHERE return_id='+r.id)).rows[0];
 const body={return_id:r.id,supplier_invoice_id:1,credit_number:'VOID-ORIGINAL',credit_date:'2026-10-25',reason:'Incorrect supplier document',items:[{return_item_id:item.id,quantity:10,line_cents:1000}],tax_cents:150,tax_treatment:'recoverable'};
 const c=await ok('/credits',body,'credit-capture-first');
 await ok('/recovery/credits/'+c.id+'/void',{reason:'Supplier replaced document'},'credit-void-first');
 assert.equal((await api('/credits/'+c.id+'/post',{},'credit-post-voided','finance')).status,409);
 const replacement=await ok('/credits',{...body,credit_number:'VOID-REPLACEMENT'},'credit-capture-again');assert.equal(Number(replacement.carrying_cents),800);
 assert.equal((await db.execute('SELECT status FROM consumable_credit_notes WHERE id='+c.id)).rows[0].status,'captured');assert.equal((await core.getCredit(db,c.id)).status,'voided');
 await ok('/credits/'+replacement.id+'/post',{variance_reason:'Original receipt carrying cost changed'},'credit-post-replace','finance');
 assert.equal((await api('/recovery/credits/'+replacement.id+'/void',{reason:'Too late'},'credit-void-posted','finance')).status,409);
});
test('order closure rejects self approval and every received order, with permissions checked on replay',async()=>{
 await db.batch(["INSERT INTO consumable_purchase_orders(id,po_number,supplier_id,branch_id,requested_by,reason,requested_for,status) VALUES(2,'CPO-2',1,1,1,'Work','Workshop','submitted'),(3,'CPO-3',1,1,1,'Work','Workshop','approved'),(4,'CPO-4',1,1,1,'Work','Workshop','approved')","INSERT INTO consumable_po_lines(po_id,consumable_id,quantity_ordered,quantity_received,unit_cost_cents) VALUES(4,1,2,1,10)"].map(sql=>statement(sql)),'write');
 const reject='/recovery/orders/2/reject',body={reason:'Budget not approved'};assert.equal((await api(reject,body,'order-reject-self')).status,403);await ok(reject,body,'order-reject-valid','receiver',2);
 assert.equal((await ok(reject,body,'order-reject-valid','receiver',2)).replayed,true);assert.equal((await api(reject,body,'order-reject-valid','other',2)).status,403);assert.equal((await api(reject,body,'order-reject-valid','receiver',1)).status,403);
 assert.equal((await api('/recovery/orders/3/cancel',body,'order-cancel-self')).status,403);await ok('/recovery/orders/3/cancel',body,'order-cancel-valid','receiver',2);
 assert.equal((await api('/recovery/orders/4/cancel',body,'order-cancel-recv','receiver',2)).status,409);assert.equal((await api('/recovery/orders/1/cancel',body,'order-cancel-full','receiver',2)).status,409);
});

test('voiding earlier partial credits preserves exact remaining carrying cents across replacements',async()=>{
 for(const [caseNo,quantity,value,voidIndexes] of [[1,2,101,[0]],[2,3,100,[0,2]],[3,10,1,[0,1,2,3,5,6,7,8,9]]]){
  const source=100+caseNo;
  await db.batch([
   statement('INSERT INTO consumable_purchase_orders(id,po_number,supplier_id,branch_id,reason,requested_for,status) VALUES(?,?,1,1,?,?,?)',[source,'CPO-ROUND-'+caseNo,'Rounding fixture','Workshop','received']),
   statement("INSERT INTO consumable_movements(id,consumable_id,branch_id,action,quantity,value_cents,po_id,purpose) VALUES(?,1,1,'receive',?,?,?,'Original rounding receipt')",[source,quantity,value,source]),
   statement("INSERT INTO supplier_invoices(id,supplier_id,branch_id,invoice_number,invoice_date,subtotal,tax_amount,tax_treatment,total) VALUES(?,1,1,?,'2026-10-25',?,?,'recoverable',?)",[source,'INV-ROUND-'+caseNo,value/100,quantity/100,(value+quantity)/100]),
   statement('INSERT INTO consumable_invoice_receipt_allocations(supplier_invoice_id,receipt_movement_id,quantity_invoiced,invoice_line_cents,actor_employee_id) VALUES(?,?,?,?,1)',[source,source,quantity,value])
  ],'write');
  const rid=Number((await db.execute(statement("INSERT INTO consumable_returns(supplier_id,branch_id,reason,status,requested_by,approved_by,dispatched_by) VALUES(1,1,'Rounding fixture','dispatched',1,2,1)"))).lastInsertRowid);
  const itemId=Number((await db.execute(statement('INSERT INTO consumable_return_items(return_id,receipt_movement_id,quantity,carrying_cents) VALUES(?,?,?,?)',[rid,source,quantity,value]))).lastInsertRowid);
  // Positive tax-only supplier credits permit exercising even sub-cent carrying splits.
  const capture=async(q,suffix)=>ok('/credits',{return_id:rid,supplier_invoice_id:source,credit_number:'ROUND-'+caseNo+'-'+suffix,credit_date:'2026-10-25',reason:'Supplier tax-only partial credit',tax_cents:q,tax_treatment:'recoverable',items:[{return_item_id:itemId,quantity:q,line_cents:0}]},'round-capture-'+caseNo+'-'+suffix);
  const captures=[];for(let i=0;i<quantity;i++)captures.push(await capture(1,'original-'+i));
  for(const index of voidIndexes)await ok('/recovery/credits/'+captures[index].id+'/void',{reason:'Replace earlier incorrect split'},'round-void-'+caseNo+'-'+index);
  for(let i=0;i<voidIndexes.length;i++){
   const replacement=await capture(1,'replacement-'+i);assert.ok(Number(replacement.carrying_cents)>=0);
   const active=(await db.execute(statement("SELECT SUM(ci.quantity) quantity,SUM(ci.carrying_cents) carrying FROM consumable_credit_items ci WHERE ci.return_item_id=? AND NOT EXISTS(SELECT 1 FROM consumable_document_closures c WHERE c.entity_type='credit' AND c.entity_id=ci.credit_note_id)",[itemId]))).rows[0];
   assert.ok(Number(active.carrying)<=value,'Never clear more than the original carrying pool');
   if(i===voidIndexes.length-1){assert.equal(Number(active.quantity),quantity);assert.equal(Number(active.carrying),value,'case '+caseNo);}
  }
 }
});
