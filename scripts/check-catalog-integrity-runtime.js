'use strict';
const fs=require('fs');
const path=require('path');
const os=require('os');
const assert=require('assert');
const express=require('express');

const dbPath=path.join(os.tmpdir(),`pos-catalog-integrity-${process.pid}.db`);
for(const s of ['','-shm','-wal'])try{fs.rmSync(dbPath+s,{force:true});}catch(_){}
process.env.TURSO_DATABASE_URL=`file:${dbPath.replace(/\\/g,'/')}`;

const {db,ensureReady}=require('../database');
const {archiveProduct,catalogHealth,inspectProductCleanup}=require('../lib/catalog-integrity');
const categoriesRouter=require('../routes/categories');
const productsRouter=require('../routes/products');

async function addProduct({sku,name,active=1,stock=0,categoryId=null,supplierId=null,online=0}){
  const r=await db.execute({sql:`INSERT INTO products(sku,name,active,stock_qty,min_stock,price,cost,tax_rate,category_id,supplier_id,online_available,is_service,is_rental,is_non_inventory)
    VALUES(?,?,?,?,0,100,50,15,?,?,?,0,0,0)`,args:[sku,name,active,stock,categoryId,supplierId,online]});
  return Number(r.lastInsertRowid);
}
async function run(){
  await ensureReady();
  const {rows:[branch]}=await db.execute({sql:'SELECT id FROM branches WHERE active=1 ORDER BY id LIMIT 1',args:[]});
  const stocked=await addProduct({sku:'CI-STOCK-1',name:'Stocked cleanup item',stock:3});
  await db.execute({sql:'INSERT OR REPLACE INTO branch_inventory(product_id,branch_id,stock_qty,min_stock) VALUES(?,?,3,0)',args:[stocked,branch.id]});
  await assert.rejects(()=>archiveProduct(stocked),e=>e?.code==='CATALOG_PRODUCT_STOCK_PRESENT');

  await db.execute({sql:'UPDATE products SET stock_qty=0 WHERE id=?',args:[stocked]});
  await db.execute({sql:'UPDATE branch_inventory SET stock_qty=0 WHERE product_id=?',args:[stocked]});
  await db.execute({sql:'CREATE TABLE catalog_integrity_runtime_refs(id INTEGER PRIMARY KEY,product_id INTEGER)',args:[]});
  await db.execute({sql:'INSERT INTO catalog_integrity_runtime_refs(product_id) VALUES(?)',args:[stocked]});
  const archived=await archiveProduct(stocked);
  assert.equal(Number(archived.product.active),0);
  assert.ok(archived.historical_references_preserved>=1);
  const {rows:[ref]}=await db.execute({sql:'SELECT COUNT(*) c FROM catalog_integrity_runtime_refs WHERE product_id=?',args:[stocked]});
  assert.equal(Number(ref.c),1);

  const bad=await addProduct({sku:'CI-BAD-1',name:'Bad inactive item',active:0,stock:5});
  await db.execute({sql:'INSERT OR REPLACE INTO branch_inventory(product_id,branch_id,stock_qty,min_stock) VALUES(?,?,2,0)',args:[bad,branch.id]});
  const missing=await addProduct({sku:'CI-MISSING-1',name:'Missing catalog data',active:1,online:1});
  await db.execute({sql:"INSERT INTO categories(name,description) VALUES('Runtime Tools','one'),(' runtime tools ','two')",args:[]});
  const health=await catalogHealth({limit:200});
  const codes=new Set(health.issues.map(x=>x.code));
  for(const code of ['inactive_with_stock','stock_balance_mismatch','missing_category','missing_supplier','online_missing_image','duplicate_category_name'])assert.ok(codes.has(code),code);

  const guarded=await addProduct({sku:'CI-GUARD-1',name:'Guarded retirement item',stock:4});
  await db.execute({sql:'INSERT OR REPLACE INTO branch_inventory(product_id,branch_id,stock_qty,min_stock) VALUES(?,?,4,0)',args:[guarded,branch.id]});

  const app=express();app.use(express.json());
  app.use((req,res,next)=>{req.employee={id:901,permissions:{inventory:true}};next();});
  app.use('/api/categories',categoriesRouter);
  app.use('/api/products',productsRouter);
  const server=app.listen(0,'127.0.0.1');
  await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
  try{
    const base=`http://127.0.0.1:${server.address().port}`;
    const response=await fetch(base+'/api/categories',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'RUNTIME TOOLS'})});
    assert.equal(response.status,409);
    const body=await response.json();
    assert.equal(body.code,'CATEGORY_NAME_EXISTS');

    const blocked=await fetch(base+'/api/products/'+guarded,{method:'DELETE',headers:{'Content-Type':'application/json'},body:'{}'});
    assert.equal(blocked.status,409);
    const blockedBody=await blocked.json();
    assert.equal(blockedBody.code,'CATALOG_PRODUCT_STOCK_PRESENT');
    const {rows:[stillActive]}=await db.execute({sql:'SELECT active FROM products WHERE id=?',args:[guarded]});
    assert.equal(Number(stillActive.active),1);

    const directPutPayload={sku:'CI-GUARD-1',name:'Guarded retirement item',stock_qty:4,min_stock:0,active:0,price:100,cost:50,tax_rate:15,is_service:0,is_rental:0};
    const directPut=await fetch(base+'/api/products/'+guarded,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(directPutPayload)});
    assert.equal(directPut.status,409);
    assert.equal((await directPut.json()).code,'CATALOG_RETIREMENT_ROUTE_REQUIRED');

    await db.execute({sql:'UPDATE products SET stock_qty=0 WHERE id=?',args:[guarded]});
    await db.execute({sql:'UPDATE branch_inventory SET stock_qty=0 WHERE product_id=?',args:[guarded]});
    const retired=await fetch(base+'/api/products/'+guarded,{method:'DELETE',headers:{'Content-Type':'application/json'},body:'{}'});
    assert.equal(retired.status,200);
    const retiredBody=await retired.json();
    assert.equal(Number(retiredBody.product.active),0);
    const {rows:[audit]}=await db.execute({sql:"SELECT actor_employee_id,action,target_type,target_id FROM security_audit_events WHERE action='catalog_product_retired' AND target_id=? ORDER BY id DESC LIMIT 1",args:[guarded]});
    assert.equal(Number(audit.actor_employee_id),901);
    assert.equal(audit.target_type,'product');
  }finally{await new Promise(resolve=>server.close(resolve));}
  console.log('Catalog Integrity runtime certification passed.');
}
run().then(async()=>{try{await db.close?.();}catch(_){}for(const s of ['','-shm','-wal'])try{fs.rmSync(dbPath+s,{force:true});}catch(_){}process.exit(0);}).catch(async e=>{console.error(e.stack||e);try{await db.close?.();}catch(_){}process.exit(1);});
