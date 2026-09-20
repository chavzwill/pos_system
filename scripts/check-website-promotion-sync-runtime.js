'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert'),express=require('express');
const dbPath=path.join(os.tmpdir(),`pos-website-promo-sync-${process.pid}.db`);
for(const s of ['','-shm','-wal'])try{fs.rmSync(dbPath+s,{force:true})}catch(_){}
process.env.TURSO_DATABASE_URL=`file:${dbPath.replace(/\\/g,'/')}`;
const {db,ensureReady}=require('../database');
const {duplicateCandidateKey,reviewDuplicateCandidate,consolidateDuplicateProducts}=require('../lib/catalog-integrity');
const commerceSync=require('../routes/commerce-sync');
const promotions=require('../routes/promotions');

async function addProduct(sku,name){
  const r=await db.execute({sql:`INSERT INTO products(sku,name,price,cost,tax_rate,stock_qty,min_stock,active,unit,online_available)
    VALUES(?,?,100,60,15,0,0,1,'each',1)`,args:[sku,name]});
  return Number(r.lastInsertRowid);
}
async function request(base,url,options={}){const r=await fetch(base+url,options);return{status:r.status,body:await r.json().catch(()=>null)};}
function isoDay(offsetDays){return new Date(Date.now()+offsetDays*86400000).toISOString().slice(0,10);}

async function run(){
  await ensureReady();
  const emp=await db.execute({sql:"INSERT INTO employees(employee_number,first_name,last_name,username,pin,role) VALUES('PS-1','Promotion','Sync','promotion-sync-runtime','9393','admin')",args:[]});
  const actor=Number(emp.lastInsertRowid);
  const survivor=await addProduct('PROMO-MASTER','Runtime Promo Drill');
  const duplicate=await addProduct('PROMO_OLD','Runtime Promo Drill');

  const live=await db.execute({sql:`INSERT INTO promotions(name,description,type,value,min_purchase,applies_to,start_date,end_date,active)
    VALUES('Runtime Website Deal','Canonical scope continuity','percentage',10,0,'specific',?,?,1)`,args:[isoDay(-1),isoDay(10)]});
  const liveId=Number(live.lastInsertRowid);
  await db.execute({sql:"INSERT INTO promotion_items(promotion_id,item_type,item_id) VALUES(?,'product',?)",args:[liveId,duplicate]});
  await db.execute({sql:"INSERT INTO promotion_items(promotion_id,item_type,item_id) VALUES(?,'product',?)",args:[liveId,survivor]});

  const scheduled=await db.execute({sql:`INSERT INTO promotions(name,type,value,min_purchase,applies_to,start_date,end_date,active)
    VALUES('Future Deal','fixed',500,0,'all',?,?,1)`,args:[isoDay(5),isoDay(20)]});
  const scheduledId=Number(scheduled.lastInsertRowid);
  const inactive=await db.execute({sql:`INSERT INTO promotions(name,type,value,min_purchase,applies_to,active)
    VALUES('Paused Deal','percentage',5,0,'all',0)`,args:[]});
  const inactiveId=Number(inactive.lastInsertRowid);

  const key=duplicateCandidateKey('duplicate_product_name',[survivor,duplicate]);
  await reviewDuplicateCandidate({candidateKey:key,decision:'confirmed_duplicate',reason:'Verified same item for promotion continuity',actorEmployeeId:actor,expectedVersion:0});
  await consolidateDuplicateProducts({candidateKey:key,survivorProductId:survivor,reason:'Consolidate duplicate while preserving campaign scope',confirmation:'CONSOLIDATE',expectedReviewVersion:1,actorEmployeeId:actor});

  const {rows:migrated}=await db.execute({sql:"SELECT item_id FROM promotion_items WHERE promotion_id=? AND item_type='product' ORDER BY item_id",args:[liveId]});
  assert.deepEqual(migrated.map(x=>Number(x.item_id)),[survivor]);

  const app=express();app.use(express.json());
  app.use((req,res,next)=>{req.employee={id:actor,permissions:{inventory:true,promotions:true,pos:true}};next();});
  app.use('/api/commerce-sync',commerceSync);
  app.use('/api/promotions',promotions);
  const server=app.listen(0,'127.0.0.1');
  await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject)});
  const base=`http://127.0.0.1:${server.address().port}`;
  try{
    const canonicalScope=await request(base,'/api/promotions/'+liveId+'/items',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({item_type:'product',item_id:duplicate})});
    assert.equal(canonicalScope.status,200);
    assert.equal(canonicalScope.body.canonicalized,true);
    assert.equal(Number(canonicalScope.body.item_id),survivor);
    const {rows:scopeAfterWrite}=await db.execute({sql:"SELECT item_id FROM promotion_items WHERE promotion_id=? AND item_type='product' ORDER BY item_id",args:[liveId]});
    assert.deepEqual(scopeAfterWrite.map(x=>Number(x.item_id)),[survivor]);

    const applied=await request(base,'/api/promotions/auto-apply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cart_items:[{product_id:survivor,category_id:null,price:100,quantity:1}],subtotal:100})});
    assert.equal(applied.status,200);
    assert.ok(applied.body.some(x=>Number(x.id)===liveId&&Number(x.discount_amount)===10));

    await db.execute({sql:"INSERT INTO promotion_codes(promotion_id,code,usage_limit,times_used,active) VALUES(?,'WEB10',100,7,1)",args:[liveId]});

    const projection=await request(base,'/api/commerce-sync/promotions');
    assert.equal(projection.status,200);
    assert.equal(projection.body.contract_version,'2026-09-20.2');
    assert.equal(projection.body.checkout_authoritative,true);
    const livePromo=projection.body.promotions.find(x=>Number(x.id)===liveId);
    assert.ok(livePromo);assert.equal(livePromo.status,'live');
    assert.equal(livePromo.scopes.length,1);
    assert.equal(livePromo.scopes[0].item_type,'product');
    assert.equal(Number(livePromo.scopes[0].item_id),survivor);
    assert.equal(livePromo.scopes[0].product_sku,'PROMO-MASTER');
    assert.equal(livePromo.codes[0].code,'WEB10');
    assert.equal(livePromo.codes[0].active,true);
    assert.equal(Object.prototype.hasOwnProperty.call(livePromo.codes[0],'times_used'),false);
    assert.equal(Object.prototype.hasOwnProperty.call(livePromo.codes[0],'usage_limit'),false);
    const future=projection.body.promotions.find(x=>Number(x.id)===scheduledId);
    assert.ok(future);assert.equal(future.status,'scheduled');
    assert.ok(!projection.body.promotions.some(x=>Number(x.id)===inactiveId));

    const all=await request(base,'/api/commerce-sync/promotions?include_inactive=1');
    assert.equal(all.status,200);
    const paused=all.body.promotions.find(x=>Number(x.id)===inactiveId);
    assert.ok(paused);assert.equal(paused.status,'inactive');

    console.log('Website Promotion Sync runtime certification passed.');
  }finally{await new Promise(resolve=>server.close(resolve));}
}
run().then(async()=>{try{await db.close?.()}catch(_){}for(const s of ['','-shm','-wal'])try{fs.rmSync(dbPath+s,{force:true})}catch(_){}process.exit(0)}).catch(async e=>{console.error(e.stack||e);try{await db.close?.()}catch(_){}process.exit(1)});
