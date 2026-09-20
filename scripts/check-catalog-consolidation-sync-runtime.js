'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert'),express=require('express');
const dbPath=path.join(os.tmpdir(),`pos-catalog-sync-${process.pid}.db`);
for(const s of ['','-shm','-wal'])try{fs.rmSync(dbPath+s,{force:true})}catch(_){}
process.env.TURSO_DATABASE_URL=`file:${dbPath.replace(/\\/g,'/')}`;
const {db,ensureReady}=require('../database');
const {duplicateCandidateKey,reviewDuplicateCandidate,consolidateDuplicateProducts}=require('../lib/catalog-integrity');
const commerceSync=require('../routes/commerce-sync');

async function addProduct({sku,name,online=1}){
  const r=await db.execute({sql:`INSERT INTO products(sku,name,price,cost,tax_rate,stock_qty,min_stock,active,unit,online_available)
    VALUES(?,?,100,60,15,0,0,1,'each',?)`,args:[sku,name,online]});
  return Number(r.lastInsertRowid);
}
async function request(base,url){const r=await fetch(base+url);return{status:r.status,body:await r.json().catch(()=>null)};}
async function run(){
  await ensureReady();
  const emp=await db.execute({sql:"INSERT INTO employees(employee_number,first_name,last_name,username,pin,role) VALUES('CS-1','Catalog','Sync','catalog-sync-runtime','9292','admin')",args:[]});
  const actor=Number(emp.lastInsertRowid);
  const {rows:[branch]}=await db.execute({sql:'SELECT id FROM branches WHERE active=1 ORDER BY id LIMIT 1',args:[]});
  const survivor=await addProduct({sku:'SYNC-MASTER',name:'Runtime Circular Saw'});
  const duplicate=await addProduct({sku:'SYNC_OLD',name:'Runtime Circular Saw'});
  const key=duplicateCandidateKey('duplicate_product_name',[survivor,duplicate]);
  await reviewDuplicateCandidate({candidateKey:key,decision:'confirmed_duplicate',reason:'Verified same website catalog item',actorEmployeeId:actor,expectedVersion:0});
  await consolidateDuplicateProducts({candidateKey:key,survivorProductId:survivor,reason:'Canonicalize duplicate for website sync runtime',confirmation:'CONSOLIDATE',expectedReviewVersion:1,actorEmployeeId:actor});
  await db.execute({sql:'UPDATE products SET stock_qty=4 WHERE id=?',args:[survivor]});
  await db.execute({sql:'INSERT INTO branch_inventory(product_id,branch_id,stock_qty,min_stock) VALUES(?,?,4,1)',args:[survivor,branch.id]});
  const app=express();
  app.use((req,res,next)=>{req.employee={id:actor,permissions:{inventory:true}};next();});
  app.use('/api/commerce-sync',commerceSync);
  const server=app.listen(0,'127.0.0.1');
  await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject)});
  const base=`http://127.0.0.1:${server.address().port}`;
  try{
    const catalog=await request(base,'/api/commerce-sync/catalog');
    assert.equal(catalog.status,200);
    assert.equal(catalog.body.contract_version,'2026-09-20.1');
    assert.ok(catalog.body.products.some(p=>Number(p.id)===survivor));
    assert.ok(!catalog.body.products.some(p=>Number(p.id)===duplicate));
    const mapping=catalog.body.product_consolidations.find(x=>Number(x.duplicate_product_id)===duplicate);
    assert.ok(mapping);
    assert.equal(Number(mapping.survivor_product_id),survivor);
    assert.equal(mapping.duplicate_sku,'SYNC_OLD');
    assert.equal(mapping.survivor_sku,'SYNC-MASTER');
    assert.ok(mapping.consolidated_at);
    assert.equal(Object.prototype.hasOwnProperty.call(mapping,'reason'),false);
    assert.equal(Object.prototype.hasOwnProperty.call(mapping,'consolidated_by'),false);

    const inactive=await request(base,'/api/commerce-sync/catalog?include_inactive=1');
    assert.equal(inactive.status,200);
    const tomb=inactive.body.products.find(p=>Number(p.id)===duplicate);
    assert.ok(tomb);
    assert.equal(tomb.active,false);
    assert.equal(Number(tomb.stock_qty),0);
    assert.equal(Number(tomb.consolidated_into_product_id),survivor);
    assert.equal(tomb.consolidated_into_sku,'SYNC-MASTER');

    const oldAvailability=await request(base,'/api/commerce-sync/availability/SYNC_OLD');
    assert.equal(oldAvailability.status,200);
    assert.equal(oldAvailability.body.canonicalized,true);
    assert.equal(oldAvailability.body.requested_sku,'SYNC_OLD');
    assert.equal(Number(oldAvailability.body.canonical_product_id),survivor);
    assert.equal(oldAvailability.body.canonical_sku,'SYNC-MASTER');
    assert.equal(Number(oldAvailability.body.product.id),survivor);
    assert.equal(Number(oldAvailability.body.availability[0].stock_qty),4);

    const canonicalAvailability=await request(base,'/api/commerce-sync/availability/SYNC-MASTER');
    assert.equal(canonicalAvailability.status,200);
    assert.equal(canonicalAvailability.body.canonicalized,false);
    assert.equal(Number(canonicalAvailability.body.canonical_product_id),survivor);
    assert.equal(canonicalAvailability.body.requested_sku,'SYNC-MASTER');

    console.log('Catalog consolidation sync runtime certification passed.');
  }finally{await new Promise(resolve=>server.close(resolve));}
}
run().then(async()=>{try{await db.close?.()}catch(_){}for(const s of ['','-shm','-wal'])try{fs.rmSync(dbPath+s,{force:true})}catch(_){}process.exit(0)}).catch(async e=>{console.error(e.stack||e);try{await db.close?.()}catch(_){}process.exit(1)});
