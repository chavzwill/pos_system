'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert'),express=require('express');
const dbPath=path.join(os.tmpdir(),`pos-brand-master-${process.pid}.db`);
for(const s of ['','-shm','-wal'])try{fs.rmSync(dbPath+s,{force:true})}catch(_){}
process.env.TURSO_DATABASE_URL=`file:${dbPath.replace(/\\/g,'/')}`;
const {db,ensureReady}=require('../database');
const brandsRouter=require('../routes/brands');
const syncRouter=require('../routes/commerce-sync');
const {catalogHealth}=require('../lib/catalog-integrity');

async function request(base,url,options={}){
  const r=await fetch(base+url,options);return{status:r.status,body:await r.json().catch(()=>null)};
}
async function run(){
  await ensureReady();
  const app=express();app.use(express.json());
  app.use((req,res,next)=>{req.employee={id:902,permissions:{inventory:true,settings:true}};next();});
  app.use('/api/brands',brandsRouter);app.use('/api/commerce-sync',syncRouter);
  const server=app.listen(0,'127.0.0.1');
  await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject)});
  const base=`http://127.0.0.1:${server.address().port}`;
  try{
    const created=await request(base,'/api/brands',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'DeWALT',description:'Power tools'})});
    assert.equal(created.status,201);const brandId=Number(created.body.id);assert.ok(brandId>0);

    const duplicate=await request(base,'/api/brands',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'  dewalt  '})});
    assert.equal(duplicate.status,409);assert.equal(duplicate.body.code,'BRAND_NAME_EXISTS');

    const concurrent=await Promise.all(['Makita',' makita '].map(name=>request(base,'/api/brands',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})})));
    assert.deepEqual(concurrent.map(x=>x.status).sort((a,b)=>a-b),[201,409]);
    const {rows:[makitaCount]}=await db.execute({sql:"SELECT COUNT(*) c FROM brands WHERE lower(trim(name))='makita'",args:[]});
    assert.equal(Number(makitaCount.c),1);

    const {rows:[category]}=await db.execute({sql:"INSERT INTO categories(name,description) VALUES('Drills','Runtime category') RETURNING id",args:[]});
    const product=await db.execute({sql:`INSERT INTO products(sku,name,description,category_id,brand_id,price,cost,tax_rate,stock_qty,min_stock,active,online_available)
      VALUES('BRAND-RUNTIME-1','Runtime Drill','Brand runtime item',?,?,1000,500,15,0,0,1,1)`,args:[category.id,brandId]});
    const productId=Number(product.lastInsertRowid);

    const list=await request(base,'/api/brands?include_inactive=1');
    const listed=list.body.find(x=>Number(x.id)===brandId);assert.equal(Number(listed.product_count),1);

    const blocked=await request(base,'/api/brands/'+brandId,{method:'DELETE',headers:{'Content-Type':'application/json'},body:'{}'});
    assert.equal(blocked.status,409);assert.equal(blocked.body.code,'BRAND_IN_USE');

    const deactivate=await request(base,'/api/brands/'+brandId,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'DeWALT',description:'Power tools',active:0})});
    assert.equal(deactivate.status,409);assert.equal(deactivate.body.code,'BRAND_IN_USE');
    const sync=await request(base,'/api/commerce-sync/catalog');
    assert.equal(sync.status,200);
    assert.ok(sync.body.categories.some(x=>Number(x.id)===Number(category.id)));
    assert.ok(sync.body.brands.some(x=>Number(x.id)===brandId&&x.name==='DeWALT'));
    const synced=sync.body.products.find(x=>Number(x.id)===productId);
    assert.equal(Number(synced.brand_id),brandId);assert.equal(synced.brand_name,'DeWALT');

    await db.execute({sql:`INSERT INTO products(sku,name,price,cost,tax_rate,stock_qty,min_stock,active) VALUES('NO-BRAND-1','No Brand Item',1,1,15,0,0,1)`,args:[]});
    const health=await catalogHealth({limit:200});
    assert.ok(health.issues.some(x=>x.code==='missing_brand'&&x.record.sku==='NO-BRAND-1'));

    const badLogo=new FormData();badLogo.append('image',new Blob(['not-image'],{type:'text/plain'}),'logo.txt');
    const logo=await fetch(base+'/api/brands/'+brandId+'/logo',{method:'POST',body:badLogo});
    assert.equal(logo.status,400);assert.equal((await logo.json()).code,'BRAND_LOGO_REQUIRED');

    const bigLogo=new FormData();bigLogo.append('image',new Blob([Buffer.alloc(5*1024*1024+1)],{type:'image/png'}),'big.png');
    const tooLarge=await fetch(base+'/api/brands/'+brandId+'/logo',{method:'POST',body:bigLogo});
    assert.equal(tooLarge.status,413);assert.equal((await tooLarge.json()).code,'BRAND_LOGO_TOO_LARGE');

    console.log('Brand Master runtime certification passed.');
  }finally{await new Promise(resolve=>server.close(resolve));}
}
run().then(async()=>{try{await db.close?.()}catch(_){}for(const s of ['','-shm','-wal'])try{fs.rmSync(dbPath+s,{force:true})}catch(_){}process.exit(0)}).catch(async e=>{console.error(e.stack||e);try{await db.close?.()}catch(_){}process.exit(1)});
