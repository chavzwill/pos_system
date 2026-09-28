'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert');
const dbPath=path.join(os.tmpdir(),`pos-workorder-assessment-${process.pid}.db`);for(const s of ['','-shm','-wal'])try{fs.rmSync(dbPath+s,{force:true})}catch(_){}
process.env.TURSO_DATABASE_URL=`file:${dbPath.replace(/\\/g,'/')}`;
const {db,ensureReady}=require('../database');const {assessmentServiceSnapshot,assessmentAmounts}=require('../lib/work-order-assessment');
async function run(){await ensureReady();
  const result=await db.execute({sql:"INSERT INTO products(sku,name,price,cost,tax_rate,stock_qty,min_stock,active,unit,is_service) VALUES('WO-DIAG','Generator Diagnostic',2500,0,15,0,0,1,'each',1)",args:[]});
  const id=Number(result.lastInsertRowid),snap=await assessmentServiceSnapshot(id);
  assert.deepEqual(snap,{product_id:id,name:'Generator Diagnostic',subtotal:2500,tax_rate:15});
  const amounts=assessmentAmounts({assessment_fee:snap.subtotal,assessment_fee_tax_rate:snap.tax_rate});
  assert.deepEqual(amounts,{subtotal:2500,tax_rate:15,tax:375,total:2875});
  await db.execute({sql:"UPDATE products SET name='Changed Later',price=9999,tax_rate=20 WHERE id=?",args:[id]});
  assert.equal(snap.name,'Generator Diagnostic');assert.equal(snap.subtotal,2500);assert.equal(snap.tax_rate,15);
  await db.execute({sql:'UPDATE products SET active=0 WHERE id=?',args:[id]});
  let inactive=null;try{await assessmentServiceSnapshot(id)}catch(e){inactive=e}assert.equal(inactive?.code,'WORK_ORDER_ASSESSMENT_SERVICE_UNAVAILABLE');
  const merchandise=await db.execute({sql:"INSERT INTO products(sku,name,price,cost,tax_rate,stock_qty,min_stock,active,unit,is_service) VALUES('WO-PART','Not A Service',100,50,15,0,0,1,'each',0)",args:[]});
  let wrong=null;try{await assessmentServiceSnapshot(Number(merchandise.lastInsertRowid))}catch(e){wrong=e}assert.equal(wrong?.code,'WORK_ORDER_ASSESSMENT_SERVICE_UNAVAILABLE');
  console.log('Work Order Assessment runtime certification passed.');
}
run().then(async()=>{try{await db.close?.()}catch(_){}for(const s of ['','-shm','-wal'])try{fs.rmSync(dbPath+s,{force:true})}catch(_){}process.exit(0)}).catch(async e=>{console.error(e.stack||e);try{await db.close?.()}catch(_){}process.exit(1)});