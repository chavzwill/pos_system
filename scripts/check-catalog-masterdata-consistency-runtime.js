'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert');
const dbPath=path.join(os.tmpdir(),`pos-catalog-masterdata-${process.pid}.db`);
for(const s of ['','-shm','-wal'])try{fs.rmSync(dbPath+s,{force:true})}catch(_){}
process.env.TURSO_DATABASE_URL=`file:${dbPath.replace(/\\/g,'/')}`;
const {db,ensureReady}=require('../database');
const {ensureUomSchema}=require('../lib/unit-of-measure');
const {catalogHealth}=require('../lib/catalog-integrity');

async function addProduct({sku,name,price=10,stock=0,unit='each',categoryId=null,brandId=null,supplierId=null,barcode=null}){
  const r=await db.execute({sql:`INSERT INTO products(sku,barcode,name,price,cost,tax_rate,stock_qty,min_stock,active,unit,category_id,brand_id,supplier_id)
    VALUES(?,?,?,?,5,15,?,0,1,?,?,?,?)`,args:[sku,barcode,name,price,stock,unit,categoryId,brandId,supplierId]});
  return Number(r.lastInsertRowid);
}
async function run(){
  await ensureReady();
  const dirtyName=await addProduct({sku:'NAME-1',name:'  Cordless   Drill  '});
  const dirtySku=await addProduct({sku:' SKU-SPACE-1 ',name:'Clean Product'});
  const noPrice=await addProduct({sku:'NOPRICE-1',name:'Stocked No Price',price:0,stock:2});
  const implicitUom=await addProduct({sku:'IMPLICIT-UOM-1',name:'Implicit Unit',unit:'box'});
  await ensureUomSchema();
  const mismatch=await addProduct({sku:'UOM-MISMATCH-1',name:'UOM Mismatch',unit:'each'});
  await db.execute({sql:"INSERT INTO product_uom_profiles(product_id,base_uom,dimension,base_precision) VALUES(?,?,?,0)",args:[mismatch,'kg','mass']});

  const brokenSold=await addProduct({sku:'',name:'Sold Broken Master',unit:null,categoryId:null});
  const tx=await db.execute({sql:"INSERT INTO transactions(transaction_number,subtotal,tax_amount,discount_amount,total,payment_method,status) VALUES('CMD-TX-1',10,0,0,10,'cash','completed')",args:[]});
  await db.execute({sql:"INSERT INTO transaction_items(transaction_id,product_id,product_name,sku,quantity,unit_price,total) VALUES(?,?,?,?,1,10,10)",args:[Number(tx.lastInsertRowid),brokenSold,'Sold Broken Master','']});

  const health=await catalogHealth({limit:200});
  const codesFor=id=>new Set(health.issues.filter(i=>Number(i.record?.id)===id).map(i=>i.code));
  assert.ok(codesFor(dirtyName).has('inconsistent_product_name'));
  assert.ok(codesFor(dirtySku).has('sku_whitespace'));
  assert.ok(codesFor(noPrice).has('stock_without_sell_price'));
  assert.ok(codesFor(mismatch).has('uom_profile_mismatch'));
  assert.ok(!codesFor(implicitUom).has('uom_profile_mismatch'),'no explicit UOM profile must not fabricate a mismatch');
  assert.ok(codesFor(brokenSold).has('sold_with_broken_master_data'));

  const grouped=health.remediation_queue.find(x=>Number(x.record?.id)===brokenSold);
  assert.ok(grouped&&grouped.codes.includes('sold_with_broken_master_data'),'new issue must flow into remediation queue');
  console.log('Catalog master-data consistency runtime certification passed.');
}
run().then(async()=>{try{await db.close?.()}catch(_){}for(const s of ['','-shm','-wal'])try{fs.rmSync(dbPath+s,{force:true})}catch(_){}process.exit(0)}).catch(async e=>{console.error(e.stack||e);try{await db.close?.()}catch(_){}process.exit(1)});
