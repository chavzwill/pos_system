'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pos-consumables-controls-'));
process.env.TURSO_DATABASE_URL='file:'+path.join(directory,'isolated.db');
const {db}=require('../database');
const express=require('express');
const router=require('../routes/consumables');
const execute=(sql,args=[])=>db.execute({sql,args});
let server,base;
async function api(method,url,body,role='staff',key='consumable-operation-key'){
 const response=await fetch(base+url,{method,headers:{'Content-Type':'application/json','X-Test-Role':role,'Idempotency-Key':key},body:body===undefined?undefined:JSON.stringify(body)});
 return{status:response.status,body:await response.json()};
}
before(async()=>{
 await db.batch([
  'CREATE TABLE suppliers(id INTEGER PRIMARY KEY,name TEXT,active INTEGER)',
  'CREATE TABLE branches(id INTEGER PRIMARY KEY,name TEXT,active INTEGER)',
  'CREATE TABLE employees(id INTEGER PRIMARY KEY)',
  'CREATE TABLE customers(id INTEGER PRIMARY KEY)',
  'CREATE TABLE products(id INTEGER PRIMARY KEY,name TEXT,sku TEXT,active INTEGER,is_rental INTEGER)',
  "INSERT INTO suppliers VALUES(1,'Supplier',1)",
  "INSERT INTO branches VALUES(1,'Main',1),(2,'Other',1)",
  'INSERT INTO employees VALUES(1),(2)',
  "INSERT INTO products VALUES(1,'Rental','R1',1,1)"
 ],'write');
 await require('../lib/consumables-schema').ensureConsumablesSchema();
 await execute("INSERT INTO departments(id,code,name) VALUES(1,'WORKSHOP','Workshop')");
 await execute("INSERT INTO consumable_catalog(id,sku,name,uom) VALUES(1,'OIL','Oil','litre'),(2,'RAG','Rag','each')");
 const app=express();app.use(express.json());
 app.use((req,res,next)=>{const role=req.headers['x-test-role'];req.employee={id:role==='approver'?2:1,default_branch_id:role==='unassigned'||role==='cross'?null:role==='other'?2:1,permissions:role==='none'?{}:{purchasing:true,inventory_adjust:true,...(role==='cross'?{branches:true}:{})}};if(role==='key')req.apiKey={};next();});
 app.use(router);
 await new Promise(resolve=>{server=app.listen(0,'127.0.0.1',resolve)});base='http://127.0.0.1:'+server.address().port;
});
after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));db.close();fs.rmSync(directory,{recursive:true,force:true});});
let order;
test('source authorization runs before replay, including self approval, missing branch and role checks',async()=>{
 const body={supplier_id:1,branch_id:1,reason:'Workshop needs',requested_for:'Workshop',items:[{consumable_id:1,quantity:3,unit_cost:'0.01'}]};
 const created=await api('POST','/orders',body);assert.equal(created.status,201,JSON.stringify(created.body));order=created.body.id;
 assert.equal((await api('POST','/orders',body)).body.replayed,true);
 assert.equal((await api('POST','/orders',body,'other')).status,403);
 assert.equal((await api('POST','/orders',body,'approver')).status,409);
 assert.equal((await api('POST','/orders',body,'none')).status,403);
 assert.equal((await api('POST','/orders',body,'key')).status,403);
 for(const endpoint of ['/catalog','/orders','/balances','/usage','/usage-summary','/lookups'])assert.equal((await api('GET',endpoint,undefined,'unassigned')).status,403,endpoint);
 assert.equal((await api('GET','/catalog',undefined,'cross')).status,200);
 assert.equal((await api('POST',`/orders/${order}/submit`,{})).status,200);
 assert.equal((await api('POST',`/orders/${order}/approve`,{},'approver')).status,200);
 assert.equal((await api('POST',`/orders/${order}/approve`,{},'staff')).body.code,'SELF_APPROVAL');
 assert.equal((await api('POST',`/orders/${order}/approve`,{},'other')).status,403);
});
test('receipts preserve immutable movement evidence and issue costing conserves cents',async()=>{
 const line=(await execute('SELECT id FROM consumable_po_lines WHERE po_id=?',[order])).rows[0].id;
 const body={items:[{line_id:line,quantity:3}]};
 const received=await api('POST',`/orders/${order}/receive`,body);assert.equal(received.status,200,JSON.stringify(received.body));
 assert.ok(received.body.receipt[0].movement_id);
 assert.equal((await api('POST',`/orders/${order}/receive`,body)).body.replayed,true);
 assert.equal((await api('POST',`/orders/${order}/receive`,body,'other')).status,403);
 await assert.rejects(execute('UPDATE consumable_movements SET value_cents=0 WHERE id=?',[received.body.receipt[0].movement_id]),/append-only/);
 const issue={branch_id:1,consumable_id:1,quantity:1,allocation_type:'department',allocation_id:1,purpose:'Routine work'};
 for(let i=0;i<3;i++){
  const issued=await api('POST','/issues',issue,'staff','consumable-issue-key-'+i);assert.equal(issued.status,200,JSON.stringify(issued.body));assert.equal(issued.body.cost_cents,1);
 }
 assert.equal((await api('POST','/issues',issue,'other','consumable-issue-key-0')).status,403);
 const balance=(await execute('SELECT * FROM consumable_balances WHERE branch_id=1 AND consumable_id=1')).rows[0];assert.equal(balance.qty_on_hand,0);assert.equal(balance.value_cents,0);
});
test('weighted cost uses exact intermediate arithmetic and rejects unsafe values',()=>{
 const {weightedCost,safeProduct,safeAdd}=router.controls;
 assert.equal(weightedCost(9007199254740991,500000,1000000),4503599627370496);
 assert.equal(weightedCost(1,1,2),1);
 let remainingValue=2,remainingQuantity=3;const allocated=[];
 while(remainingQuantity){const value=weightedCost(remainingValue,1,remainingQuantity);allocated.push(value);remainingValue-=value;remainingQuantity--;}
 assert.deepEqual(allocated,[1,1,0]);assert.equal(remainingValue,0);
 assert.throws(()=>safeProduct(1000000,100000000000,'Value'),/safe/);
 assert.throws(()=>safeAdd(Number.MAX_SAFE_INTEGER,1,'Value'),/safe/);
});
test('summary aggregates entire history with exact money and quantities per catalog item, scope and dates',async()=>{
 const rows=[];
 for(let i=0;i<510;i++)rows.push({sql:"INSERT INTO consumable_movements(consumable_id,branch_id,action,quantity,value_cents,department_id,created_at) VALUES(1,1,'issue',2,3,1,'2026-10-24 12:00:00')",args:[]});
 rows.push({sql:"INSERT INTO consumable_movements(consumable_id,branch_id,action,quantity,value_cents,rental_product_id,rental_unit_reference,created_at) VALUES(2,1,'issue',7,11,1,'UNIT-1','2026-10-24 23:59:59'),(1,2,'issue',999,999,NULL,NULL,'2026-10-24 12:00:00'),(1,1,'issue',100,100,NULL,NULL,'2026-10-25 00:00:00')",args:[]});
 await db.batch(rows,'write');
 const summary=await api('GET','/usage-summary?date_from=2026-10-24&date_to=2026-10-24');assert.equal(summary.status,200,JSON.stringify(summary.body));
 assert.equal(summary.body.totals.cost_cents,1541);assert.equal(summary.body.totals.issue_count,511);
 assert.equal(summary.body.totals.quantity,undefined);
 assert.deepEqual(summary.body.totals.quantities_by_consumable.map(item=>[item.consumable_id,item.quantity]),[[1,1020],[2,7]]);
 const filtered=await api('GET','/usage-summary?date_from=2026-10-24&date_to=2026-10-24&rental_product_id=1&rental_unit_reference=UNIT-1');assert.equal(filtered.body.totals.cost_cents,11);
 assert.equal((await api('GET','/usage-summary?branch_id=2')).status,403);
 assert.equal((await api('GET','/usage-summary?date_from=2026-02-30')).status,400);
 assert.equal((await api('GET','/usage-summary?date_from=2026-10-25&date_to=2026-10-24')).status,400);
 const cross=await api('GET','/usage-summary?branch_id=2',undefined,'cross');assert.equal(cross.body.totals.cost_cents,999);
});

test('receipt overflow rolls back PO quantity and movement evidence',async()=>{
 const body={supplier_id:1,branch_id:1,reason:'Additional stock',requested_for:'Workshop',items:[{consumable_id:2,quantity:1,unit_cost:'1.00'}]};
 const created=await api('POST','/orders',body,'staff','overflow-po-operation');const oid=created.body.id;
 await api('POST',`/orders/${oid}/submit`,{});
 await api('POST',`/orders/${oid}/approve`,{},'approver');
 const line=(await execute('SELECT id FROM consumable_po_lines WHERE po_id=?',[oid])).rows[0].id;
 await execute('INSERT INTO consumable_balances(consumable_id,branch_id,qty_on_hand,value_cents) VALUES(2,1,1,?)',[Number.MAX_SAFE_INTEGER]);
 const received=await api('POST',`/orders/${oid}/receive`,{items:[{line_id:line,quantity:1}]});
 assert.equal(received.status,409);assert.equal(received.body.code,'UNSAFE_CONSUMABLE_VALUE');
 assert.equal((await execute('SELECT quantity_received FROM consumable_po_lines WHERE id=?',[line])).rows[0].quantity_received,0);
 assert.equal((await execute('SELECT COUNT(*) n FROM consumable_movements WHERE po_id=?',[oid])).rows[0].n,0);
});

 test('actual receipt cost requires explanation and changes weighted stock value without changing approved PO',async()=>{
 const body={supplier_id:1,branch_id:1,reason:'Cost variance test',requested_for:'Workshop',items:[{consumable_id:1,quantity:4,unit_cost:'2.00'}]};
 const created=await api('POST','/orders',body,'staff','actual-cost-po-operation');const oid=created.body.id;assert.equal(created.status,201);
 await api('POST',`/orders/${oid}/submit`,{});await api('POST',`/orders/${oid}/approve`,{},'approver');
 const line=(await execute('SELECT id FROM consumable_po_lines WHERE po_id=?',[oid])).rows[0].id;
 const missingReason=await api('POST',`/orders/${oid}/receive`,{items:[{line_id:line,quantity:2,unit_cost:'3.00'}]},'staff','actual-cost-receipt-1');
 assert.equal(missingReason.status,400);assert.equal(missingReason.body.code,'COST_CHANGE_REASON_REQUIRED');
 assert.equal((await execute('SELECT quantity_received FROM consumable_po_lines WHERE id=?',[line])).rows[0].quantity_received,0);
 assert.equal((await execute('SELECT COUNT(*) n FROM consumable_movements WHERE po_id=?',[oid])).rows[0].n,0);
 const received=await api('POST',`/orders/${oid}/receive`,{items:[{line_id:line,quantity:2,unit_cost:'3.00',cost_change_reason:'Supplier delivery surcharge confirmed'}]},'staff','actual-cost-receipt-1');
 assert.equal(received.status,200,JSON.stringify(received.body));assert.equal(received.body.receipt[0].actual_unit_cost_cents,300);assert.equal(received.body.receipt[0].original_unit_cost_cents,200);assert.equal(received.body.receipt[0].value_cents,600);
 const second=await api('POST',`/orders/${oid}/receive`,{items:[{line_id:line,quantity:2}]},'staff','actual-cost-receipt-2');assert.equal(second.status,200);assert.equal(second.body.receipt[0].actual_unit_cost_cents,200);
 const po=(await execute('SELECT total_cents FROM consumable_purchase_orders WHERE id=?',[oid])).rows[0];assert.equal(po.total_cents,800);
 assert.equal((await execute('SELECT unit_cost_cents FROM consumable_po_lines WHERE id=?',[line])).rows[0].unit_cost_cents,200);
 const movement=(await execute('SELECT value_cents,purpose FROM consumable_movements WHERE id=?',[received.body.receipt[0].movement_id])).rows[0];assert.equal(movement.value_cents,600);assert.match(movement.purpose,/Supplier delivery surcharge confirmed/);
 const balance=(await execute('SELECT qty_on_hand,value_cents FROM consumable_balances WHERE branch_id=1 AND consumable_id=1')).rows[0];assert.equal(balance.qty_on_hand,4);assert.equal(balance.value_cents,1000);
 const issue=await api('POST','/issues',{branch_id:1,consumable_id:1,quantity:1,purpose:'Actual cost weighted issue'},'staff','actual-cost-issue-operation');assert.equal(issue.status,200);assert.equal(issue.body.cost_cents,250);
 });
