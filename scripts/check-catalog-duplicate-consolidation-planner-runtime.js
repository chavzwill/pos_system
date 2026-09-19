'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert');
const dbPath=path.join(os.tmpdir(),`pos-catalog-consolidation-plan-${process.pid}.db`);
for(const s of ['','-shm','-wal'])try{fs.rmSync(dbPath+s,{force:true})}catch(_){}
process.env.TURSO_DATABASE_URL=`file:${dbPath.replace(/\\/g,'/')}`;
const {db,ensureReady}=require('../database');
const {duplicateCandidateKey,reviewDuplicateCandidate,planDuplicateConsolidation}=require('../lib/catalog-integrity');

async function addProduct(sku,barcode,price){
  const r=await db.execute({sql:`INSERT INTO products(sku,barcode,name,price,cost,tax_rate,stock_qty,min_stock,active,unit) VALUES(?,?,'Cordless Drill',?,5,15,0,0,1,'each')`,args:[sku,barcode,price]});
  return Number(r.lastInsertRowid);
}
async function run(){
  await ensureReady();
  const emp=await db.execute({sql:"INSERT INTO employees(employee_number,first_name,last_name,username,pin,role) VALUES('CP-1','Catalog','Planner','catalog-plan-runtime','5555','admin')",args:[]});
  const actor=Number(emp.lastInsertRowid);
  const a=await addProduct('DRILL-A','111111',100);
  const b=await addProduct('DRILL-B','222222',110);
  const key=duplicateCandidateKey('duplicate_product_name',[a,b]);

  let unconfirmed=false;
  try{await planDuplicateConsolidation(key);}catch(e){unconfirmed=e.code==='CATALOG_DUPLICATE_NOT_CONFIRMED';}
  assert.equal(unconfirmed,true,'planner must refuse an unconfirmed duplicate');

  await reviewDuplicateCandidate({candidateKey:key,decision:'confirmed_duplicate',reason:'Same manufacturer and exact model verified',actorEmployeeId:actor,expectedVersion:0});

  const tx=await db.execute({sql:"INSERT INTO transactions(transaction_number,subtotal,tax_amount,discount_amount,total,payment_method,status) VALUES('CP-TX-1',110,0,0,110,'cash','completed')",args:[]});
  await db.execute({sql:"INSERT INTO transaction_items(transaction_id,product_id,product_name,sku,quantity,unit_price,total) VALUES(?,?,?,?,1,110,110)",args:[Number(tx.lastInsertRowid),b,'Cordless Drill','DRILL-B']});
  await db.execute({sql:'UPDATE products SET stock_qty=1 WHERE id IN (?,?)',args:[a,b]});
  const before=(await db.execute({sql:'SELECT id,sku,barcode,name,price,stock_qty,active FROM products WHERE id IN (?,?) ORDER BY id',args:[a,b]})).rows;

  const plan=await planDuplicateConsolidation(key);
  assert.equal(plan.read_only,true);
  assert.equal(plan.records.length,2);
  assert.equal(plan.suggested_primary.product_id,b,'record with more historical references should be suggested');
  assert.ok(plan.conflicts.some(x=>x.field==='sku'));
  assert.ok(plan.conflicts.some(x=>x.field==='barcode'));
  assert.ok(plan.conflicts.some(x=>x.field==='price'));
  assert.ok(plan.blockers.some(x=>/More than one duplicate record still holds stock/.test(x)));
  const bPlan=plan.records.find(x=>Number(x.product.id)===b);
  assert.ok(Number(bPlan.history.reference_count)>=1);

  const after=(await db.execute({sql:'SELECT id,sku,barcode,name,price,stock_qty,active FROM products WHERE id IN (?,?) ORDER BY id',args:[a,b]})).rows;
  assert.deepEqual(after,before,'planner must not mutate product or stock state');

  const c=await addProduct('DRILL-C','333333',120);
  let stale=false;
  try{await planDuplicateConsolidation(key);}catch(e){stale=e.code==='CATALOG_DUPLICATE_CANDIDATE_STALE';}
  assert.equal(stale,true,'changed duplicate membership must invalidate old plan');
  await db.execute({sql:'DELETE FROM products WHERE id=?',args:[c]});
  console.log('Catalog duplicate consolidation planner runtime certification passed.');
}
run().then(async()=>{try{await db.close?.()}catch(_){}for(const s of ['','-shm','-wal'])try{fs.rmSync(dbPath+s,{force:true})}catch(_){}process.exit(0)}).catch(async e=>{console.error(e.stack||e);try{await db.close?.()}catch(_){}process.exit(1)});
