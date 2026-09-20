'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert'),express=require('express');
const dbPath=path.join(os.tmpdir(),`pos-catalog-tombstones-${process.pid}.db`);
for(const s of ['','-shm','-wal'])try{fs.rmSync(dbPath+s,{force:true})}catch(_){}
process.env.TURSO_DATABASE_URL=`file:${dbPath.replace(/\\/g,'/')}`;
const {db,ensureReady}=require('../database');
const {duplicateCandidateKey,reviewDuplicateCandidate,consolidateDuplicateProducts,resolveCanonicalProduct,assertProductNotConsolidated}=require('../lib/catalog-integrity');
const productsRouter=require('../routes/products');

async function addProduct({sku,name='Cordless Drill',stock=0}){
  const r=await db.execute({sql:`INSERT INTO products(sku,name,price,cost,tax_rate,stock_qty,min_stock,active,unit) VALUES(?,?,100,60,15,?,0,1,'each')`,args:[sku,name,stock]});
  return Number(r.lastInsertRowid);
}
async function consolidatePair({actor,survivorSku,duplicateSku,name='Cordless Drill'}){
  const survivor=await addProduct({sku:survivorSku,name}),duplicate=await addProduct({sku:duplicateSku,name});
  const key=duplicateCandidateKey('duplicate_product_name',[survivor,duplicate]);
  await reviewDuplicateCandidate({candidateKey:key,decision:'confirmed_duplicate',reason:'Verified same item for tombstone runtime',actorEmployeeId:actor,expectedVersion:0});
  await consolidateDuplicateProducts({candidateKey:key,survivorProductId:survivor,reason:'Consolidate verified duplicate for tombstone runtime',confirmation:'CONSOLIDATE',expectedReviewVersion:1,actorEmployeeId:actor});
  return{survivor,duplicate,key};
}
async function request(base,url,options={}){const r=await fetch(base+url,options);return{status:r.status,body:await r.json().catch(()=>null)};}
async function run(){
  await ensureReady(); console.log('stage: ready');
  const emp=await db.execute({sql:"INSERT INTO employees(employee_number,first_name,last_name,username,pin,role) VALUES('CT-1','Catalog','Tombstone','catalog-tombstone-runtime','9191','admin')",args:[]});
  const actor=Number(emp.lastInsertRowid);
  const {rows:[branch]}=await db.execute({sql:'SELECT id FROM branches WHERE active=1 ORDER BY id LIMIT 1',args:[]});

  const {survivor,duplicate}=await consolidatePair({actor,survivorSku:'TOMB-MASTER',duplicateSku:'TOMB_OLD'}); console.log('stage: consolidated base pair');
  const resolved=await resolveCanonicalProduct(duplicate);
  assert.equal(resolved.is_consolidated,true);
  assert.equal(resolved.canonical_product_id,survivor);
  assert.equal(resolved.canonical_sku,'TOMB-MASTER');
  await assert.rejects(()=>assertProductNotConsolidated(duplicate),e=>e?.code==='CATALOG_PRODUCT_CONSOLIDATED'&&Number(e?.details?.canonical_product_id)===survivor);

  for(const [label,fn] of [
    ['reactivation',()=>db.execute({sql:'UPDATE products SET active=1 WHERE id=?',args:[duplicate]})],
    ['global stock',()=>db.execute({sql:'UPDATE products SET stock_qty=1 WHERE id=?',args:[duplicate]})],
    ['branch stock',()=>db.execute({sql:'INSERT INTO branch_inventory(product_id,branch_id,stock_qty,min_stock) VALUES(?,?,1,0)',args:[duplicate,branch.id]})],
    ['stock movement',()=>db.execute({sql:"INSERT INTO stock_movements(product_id,branch_id,quantity_change,type,reason) VALUES(?,?,1,'adjustment','tombstone test')",args:[duplicate,branch.id]})],
    ['variation create',()=>db.execute({sql:"INSERT INTO product_variations(product_id,name,sku,stock_qty,min_stock,active) VALUES(?,'Old variant','TOMB-VAR-OLD',0,0,1)",args:[duplicate]})],
    ['variation type create',()=>db.execute({sql:"INSERT INTO product_variation_types(product_id,name,attr_values,sort_order) VALUES(?,'Size','[\"M\"]',0)",args:[duplicate]})]
  ]){let blocked=false;try{await fn();}catch(e){blocked=/consolidated product/i.test(String(e.message||''));}assert.equal(blocked,true,label+' must be blocked');}
  console.log('stage: direct guards passed');
  const vSurvivor=await addProduct({sku:'VAR-MASTER',name:'Impact Driver'}),vDuplicate=await addProduct({sku:'VAR_OLD',name:'Impact Driver'});
  await db.execute({sql:"INSERT INTO product_variations(product_id,name,sku,stock_qty,min_stock,active) VALUES(?,'Battery Kit','VAR-OLD-KIT',2,0,1)",args:[vDuplicate]});
  const vKey=duplicateCandidateKey('duplicate_product_name',[vSurvivor,vDuplicate]);
  await reviewDuplicateCandidate({candidateKey:vKey,decision:'confirmed_duplicate',reason:'Verified same impact driver',actorEmployeeId:actor,expectedVersion:0});
  await assert.rejects(()=>consolidateDuplicateProducts({candidateKey:vKey,survivorProductId:vSurvivor,reason:'Attempt while variation stock remains',confirmation:'CONSOLIDATE',expectedReviewVersion:1,actorEmployeeId:actor}),e=>e?.code==='CATALOG_CONSOLIDATION_VARIATION_STOCK_PRESENT');

  console.log('stage: variation stock blocker passed');
  const zSurvivor=await addProduct({sku:'ZERO-MASTER',name:'Jigsaw'}),zDuplicate=await addProduct({sku:'ZERO_OLD',name:'Jigsaw'});
  const zeroVar=await db.execute({sql:"INSERT INTO product_variations(product_id,name,sku,stock_qty,min_stock,active) VALUES(?,'Bare Tool','ZERO-OLD-BARE',0,0,1)",args:[zDuplicate]});
  const zKey=duplicateCandidateKey('duplicate_product_name',[zSurvivor,zDuplicate]);
  await reviewDuplicateCandidate({candidateKey:zKey,decision:'confirmed_duplicate',reason:'Verified same jigsaw',actorEmployeeId:actor,expectedVersion:0});
  await consolidateDuplicateProducts({candidateKey:zKey,survivorProductId:zSurvivor,reason:'Consolidate zero-stock duplicate',confirmation:'CONSOLIDATE',expectedReviewVersion:1,actorEmployeeId:actor});
  let variationUpdateBlocked=false;try{await db.execute({sql:'UPDATE product_variations SET active=0 WHERE id=?',args:[Number(zeroVar.lastInsertRowid)]});}catch(e){variationUpdateBlocked=/immutable/i.test(String(e.message||''));}
  assert.equal(variationUpdateBlocked,true);

  console.log('stage: zero variation tombstone passed');
  const app=express();app.use(express.json());app.use((req,res,next)=>{req.employee={id:actor,permissions:{inventory:true,rentals_manage_items:true}};next();});app.use('/api/products',productsRouter);
  const server=app.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject)});
  const base=`http://127.0.0.1:${server.address().port}`; console.log('stage: http server ready');
  try{
    const put=await request(base,'/api/products/'+duplicate,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({sku:'TOMB_OLD',name:'Changed',active:1})});
    assert.equal(put.status,409);assert.equal(put.body.code,'CATALOG_PRODUCT_CONSOLIDATED');assert.equal(Number(put.body.canonical_product_id),survivor);
    const stock=await request(base,'/api/products/'+duplicate+'/stock',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({adjustment:1,reason:'must fail'})});
    assert.equal(stock.status,409);assert.equal(stock.body.code,'CATALOG_PRODUCT_CONSOLIDATED');
    const variation=await request(base,'/api/products/'+duplicate+'/variations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Blocked',sku:'BLOCKED-VAR'})});
    assert.equal(variation.status,409);assert.equal(variation.body.code,'CATALOG_PRODUCT_CONSOLIDATED');
    const list=await request(base,'/api/products?active=0');
    assert.equal(list.status,200);
    const tomb=list.body.find(x=>Number(x.id)===duplicate);
    assert.equal(Number(tomb.consolidated_into_product_id),survivor);
    assert.equal(tomb.consolidated_into_sku,'TOMB-MASTER');
  }finally{await new Promise(resolve=>server.close(resolve));}

  console.log('Catalog consolidation tombstone runtime certification passed.');
}
run().then(async()=>{try{await db.close?.()}catch(_){}for(const s of ['','-shm','-wal'])try{fs.rmSync(dbPath+s,{force:true})}catch(_){}process.exit(0)}).catch(async e=>{console.error(e.stack||e);try{await db.close?.()}catch(_){}process.exit(1)});
