'use strict';
// Removing a route's approval check or its transaction recheck must fail these
// HTTP tests. Every database and document here is an isolated synthetic fixture.
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const repo=path.resolve(__dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'po-approval-'));
let db,server,base,branch,employee;
const execute=(sql,args=[])=>db.execute({sql,args});
before(async()=>{
 const env={PATH:process.env.PATH,HOME:process.env.HOME,POS_TEST_PASSWORD:'Isolated-Approval!2026',TURSO_DATABASE_URL:'',TURSO_AUTH_TOKEN:''};
 cp.execFileSync(process.execPath,[path.join(repo,'scripts/ci-runtime-bootstrap.js')],{cwd:dir,env,stdio:'pipe'});
 process.env.TURSO_DATABASE_URL='file:'+path.join(dir,'pos.db');process.env.TURSO_AUTH_TOKEN='';
 ({db}=require('../database'));
 branch=(await execute('SELECT id FROM branches ORDER BY id LIMIT 1')).rows[0].id;
 employee=(await execute('SELECT id FROM employees ORDER BY id LIMIT 1')).rows[0].id;
 const app=require('express')();app.use(require('express').json());
 app.use((req,res,next)=>{req.employee={id:employee,permissions:{purchasing:true,purchasing_receive:true,purchasing_approve:true,multi_branch_access:true}};next()});
 app.use('/fallback',require('../routes/purchase-orders'));
 app.use('/hardened',require('../routes/purchase-order-hardening'));
 app.use('/canonical',require('../routes/purchase-receipt-traceability'));
 app.use('/guard',require('../routes/purchase-receive-operation-guard'),(req,res)=>res.json({passed:true}));
 app.use((e,req,res,next)=>res.status(e.status||500).json({error:e.message}));
 server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port;
 await fetch(base+'/hardened/0/receipts');
});
after(async()=>{if(server)await new Promise(r=>server.close(r));db?.close();fs.rmSync(dir,{recursive:true,force:true})});
let sequence=0;
async function fixture(status){
 const po=Number((await execute('INSERT INTO purchase_orders(po_number,branch_id,status) VALUES(?,?,?)',['APPROVAL-'+(++sequence),branch,status])).lastInsertRowid);
 const item=Number((await execute('INSERT INTO purchase_order_items(po_id,product_name,quantity_ordered,quantity_received,unit_cost,total) VALUES(?,?,?,?,?,?)',[po,'Unlinked fixture',4,0,10,40])).lastInsertRowid);
 return{po,item};
}
async function receive(route,f){const r=await fetch(`${base}/${route}/${f.po}/receive`,{method:'PATCH',headers:{'Content-Type':'application/json','Idempotency-Key':'approval-fixture-'+f.po},body:JSON.stringify({items:[{item_id:f.item,quantity_received:1}]})});return{status:r.status,body:await r.json()}}
for(const route of ['fallback','hardened','canonical','guard'])test(`${route}: rejects all unapproved and closed statuses before receiving`,async()=>{
 for(const status of ['draft','sent','submitted','rejected','cancelled','received']){
  const f=await fixture(status),stock=(await execute('SELECT COALESCE(SUM(stock_qty),0) n FROM products')).rows[0].n,movements=(await execute('SELECT COUNT(*) n FROM stock_movements')).rows[0].n,r=await receive(route,f);
  assert.ok([400,409].includes(r.status),`${route} ${status}: ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal((await execute('SELECT quantity_received FROM purchase_order_items WHERE id=?',[f.item])).rows[0].quantity_received,0);
  assert.equal((await execute('SELECT status FROM purchase_orders WHERE id=?',[f.po])).rows[0].status,status);
  assert.equal((await execute('SELECT COUNT(*) n FROM purchase_receipts WHERE po_id=?',[f.po])).rows[0].n,0);
  assert.equal((await execute('SELECT COALESCE(SUM(stock_qty),0) n FROM products')).rows[0].n,stock);
  assert.equal((await execute('SELECT COUNT(*) n FROM stock_movements')).rows[0].n,movements);
 }
});
for(const route of ['fallback','hardened','canonical'])test(`${route}: accepts approved orders and subsequent partial deliveries`,async()=>{
 const f=await fixture('approved');
 for(let received=1;received<=2;received++){
  const r=await receive(route,f);assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.status,'partial');
  assert.equal((await execute('SELECT quantity_received FROM purchase_order_items WHERE id=?',[f.item])).rows[0].quantity_received,received);
 }
});
for(const route of ['fallback','hardened','canonical'])test(`${route}: cancellation after validation cannot commit a receipt`,async()=>{
 const f=await fixture('approved'),original=db.transaction.bind(db);let changed=false;
 db.transaction=async(...args)=>{if(!changed){changed=true;await execute("UPDATE purchase_orders SET status='cancelled' WHERE id=?",[f.po])}return original(...args)};
 let r;try{r=await receive(route,f)}finally{db.transaction=original}
 assert.ok(changed);assert.ok([400,409].includes(r.status),JSON.stringify(r));
 assert.equal((await execute('SELECT quantity_received FROM purchase_order_items WHERE id=?',[f.item])).rows[0].quantity_received,0);
 assert.equal((await execute('SELECT status FROM purchase_orders WHERE id=?',[f.po])).rows[0].status,'cancelled');
 assert.equal((await execute('SELECT COUNT(*) n FROM purchase_receipts WHERE po_id=?',[f.po])).rows[0].n,0);
});
