'use strict';
const fs=require('fs');
const path=require('path');
const os=require('os');
const assert=require('assert');
const express=require('express');

const dbPath=path.join(os.tmpdir(),`pos-predictive-http-${process.pid}.db`);
try{fs.rmSync(dbPath,{force:true});}catch(_){}
process.env.TURSO_DATABASE_URL=`file:${dbPath.replace(/\\/g,'/')}`;

const {db,ensureReady}=require('../database');
const {PERMISSION_TREE}=require('../lib/permissions');
const predictiveRouter=require('../routes/predictive-lookup');

async function bootstrap(){
  await ensureReady();
  const permissions={};
  for(const mod of PERMISSION_TREE){permissions[mod.key]=true;for(const sub of mod.subs)permissions[sub.key]=true;}
  const {rows:[branch]}=await db.execute({sql:"SELECT id FROM branches WHERE active=1 ORDER BY id LIMIT 1",args:[]});
  await db.execute({sql:"INSERT INTO products(sku,barcode,name,description,price,cost,tax_rate,stock_qty,min_stock,active,model_number) VALUES(?,?,?,?,?,?,?,?,?,1,?)",args:['HTTP-LOOKUP-001','9988776655','HTTP Runtime Impact Driver','Predictive API evidence item',19999,12000,15,5,1,'HTTP-ID-20V']});
  const {rows:[product]}=await db.execute({sql:"SELECT id FROM products WHERE sku='HTTP-LOOKUP-001'",args:[]});
  await db.execute({sql:"INSERT OR REPLACE INTO branch_inventory(product_id,branch_id,stock_qty,min_stock) VALUES(?,?,?,?)",args:[product.id,branch.id,4,1]});
  return{employee:{id:9002,default_branch_id:branch.id,permissions},branchId:branch.id,productId:Number(product.id)};
}
async function request(base,path,options={}){const r=await fetch(base+path,options);return{status:r.status,body:await r.json().catch(()=>null)};}

async function run(){
  const fixture=await bootstrap();
  const app=express();
  app.use((req,res,next)=>{if(req.headers['x-runtime-auth']==='1')req.employee=fixture.employee;next();});
  app.use('/api/predictive-lookup',predictiveRouter);
  const server=app.listen(0,'127.0.0.1');
  await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
  const base=`http://127.0.0.1:${server.address().port}`;
  try{
    const anon=await request(base,'/api/predictive-lookup?domain=product&q=HTTP-LOOKUP-001');
    assert.equal(anon.status,401);
    const exact=await request(base,`/api/predictive-lookup?domain=product&q=HTTP-LOOKUP-001&branch_id=${fixture.branchId}`,{headers:{'X-Runtime-Auth':'1'}});
    assert.equal(exact.status,200);
    assert.equal(exact.body.exact_match?.entity_id,fixture.productId);
    assert.equal(exact.body.results[0].match_kind,'exact_identifier');
    assert.equal(exact.body.results[0].availability.on_hand,4);

    const invalid=await request(base,'/api/predictive-lookup?domain=unknown&q=test',{headers:{'X-Runtime-Auth':'1'}});
    assert.equal(invalid.status,400);
    assert.equal(invalid.body.code,'PREDICTIVE_LOOKUP_DOMAIN_INVALID');

    console.log('Predictive lookup HTTP runtime certification passed.');
  }finally{await new Promise(resolve=>server.close(resolve));}
}
run().then(async()=>{try{await db.close?.();}catch(_){}for(const suffix of ['','-shm','-wal']){try{fs.rmSync(dbPath+suffix,{force:true});}catch(_){}}process.exit(0);}).catch(async error=>{console.error(error.stack||error);try{await db.close?.();}catch(_){}for(const suffix of ['','-shm','-wal']){try{fs.rmSync(dbPath+suffix,{force:true});}catch(_){}}process.exit(1);});
