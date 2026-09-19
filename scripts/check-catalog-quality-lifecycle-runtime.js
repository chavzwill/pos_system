'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert');
const dbPath=path.join(os.tmpdir(),`pos-catalog-quality-${process.pid}.db`);
for(const s of ['','-shm','-wal'])try{fs.rmSync(dbPath+s,{force:true})}catch(_){}
process.env.TURSO_DATABASE_URL=`file:${dbPath.replace(/\\/g,'/')}`;
const {db,ensureReady}=require('../database');
const {catalogHealth,setProductLifecycle}=require('../lib/catalog-integrity');

async function run(){
  await ensureReady();
  const emp=await db.execute({sql:"INSERT INTO employees(employee_number,first_name,last_name,username,pin,role) VALUES('CQ-1','Catalog','Tester','catalog-quality-runtime','9999','admin')",args:[]});
  const employeeId=Number(emp.lastInsertRowid);
  const old='2024-01-01T00:00:00.000Z';
  const created=await db.execute({sql:`INSERT INTO products(sku,name,price,cost,tax_rate,stock_qty,min_stock,active,unit,barcode,created_at)
    VALUES('','Legacy Uncoded Item',10,5,15,0,0,1,NULL,NULL,?)`,args:[old]});
  const productId=Number(created.lastInsertRowid);

  const health=await catalogHealth({limit:200});
  const codes=new Set(health.issues.filter(i=>Number(i.record?.id)===productId).map(i=>i.code));
  assert.ok(codes.has('missing_sku'));
  assert.ok(codes.has('missing_unit'));
  assert.ok(codes.has('missing_barcode'));
  assert.ok(codes.has('stale_catalog_activity'));
  const before=(await db.execute({sql:'SELECT active,stock_qty FROM products WHERE id=?',args:[productId]})).rows[0];
  const changed=await setProductLifecycle(productId,{status:'obsolete',reason:'Supplier confirmed this model is obsolete',actorEmployeeId:employeeId});
  assert.equal(changed.changed,true);
  assert.equal(changed.product.catalog_status,'obsolete');
  const after=(await db.execute({sql:'SELECT active,stock_qty,catalog_status FROM products WHERE id=?',args:[productId]})).rows[0];
  assert.equal(Number(after.active),Number(before.active));
  assert.equal(Number(after.stock_qty),Number(before.stock_qty));
  assert.equal(after.catalog_status,'obsolete');

  const replay=await setProductLifecycle(productId,{status:'obsolete',reason:'Safe retry of the same lifecycle decision',actorEmployeeId:employeeId});
  assert.equal(replay.changed,false);
  const {rows:[eventCount]}=await db.execute({sql:'SELECT COUNT(*) c FROM catalog_product_lifecycle_events WHERE product_id=?',args:[productId]});
  assert.equal(Number(eventCount.c),1);

  await db.execute({sql:'UPDATE products SET stock_qty=2 WHERE id=?',args:[productId]});
  const health2=await catalogHealth({limit:200});
  assert.ok(health2.issues.some(i=>i.code==='obsolete_with_stock'&&Number(i.record?.id)===productId));
  const event=(await db.execute({sql:'SELECT id FROM catalog_product_lifecycle_events WHERE product_id=?',args:[productId]})).rows[0];
  let updateBlocked=false,deleteBlocked=false;
  try{await db.execute({sql:"UPDATE catalog_product_lifecycle_events SET reason='tampered' WHERE id=?",args:[event.id]});}catch(e){updateBlocked=/append-only/i.test(String(e.message||''));}
  try{await db.execute({sql:'DELETE FROM catalog_product_lifecycle_events WHERE id=?',args:[event.id]});}catch(e){deleteBlocked=/append-only/i.test(String(e.message||''));}
  assert.equal(updateBlocked,true);assert.equal(deleteBlocked,true);

  const recent=await db.execute({sql:`INSERT INTO products(sku,name,price,cost,tax_rate,stock_qty,min_stock,active,unit,barcode,created_at)
    VALUES('RECENT-ACTIVITY-1','Old Product With Recent Sale',10,5,15,0,0,1,'each','1234567890',?)`,args:[old]});
  const recentId=Number(recent.lastInsertRowid);
  const tx=await db.execute({sql:"INSERT INTO transactions(transaction_number,subtotal,tax_amount,discount_amount,total,payment_method,status) VALUES('CQ-TX-1',10,0,0,10,'cash','completed')",args:[]});
  await db.execute({sql:"INSERT INTO transaction_items(transaction_id,product_id,product_name,sku,quantity,unit_price,total) VALUES(?,?,?,?,1,10,10)",args:[Number(tx.lastInsertRowid),recentId,'Old Product With Recent Sale','RECENT-ACTIVITY-1']});
  const health3=await catalogHealth({limit:200});
  assert.ok(!health3.issues.some(i=>i.code==='stale_catalog_activity'&&Number(i.record?.id)===recentId));
  console.log('Catalog Quality runtime certification passed.');
}
run().then(async()=>{try{await db.close?.()}catch(_){}for(const s of ['','-shm','-wal'])try{fs.rmSync(dbPath+s,{force:true})}catch(_){}process.exit(0)}).catch(async e=>{console.error(e.stack||e);try{await db.close?.()}catch(_){}process.exit(1)});
