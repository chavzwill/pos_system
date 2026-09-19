'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert');
const dbPath=path.join(os.tmpdir(),`pos-consolidation-preview-${process.pid}.db`);
for(const s of ['','-shm','-wal'])try{fs.rmSync(dbPath+s,{force:true})}catch(_){}
process.env.TURSO_DATABASE_URL=`file:${dbPath.replace(/\\/g,'/')}`;
const {db,ensureReady}=require('../database');
const {duplicateCandidateKey,reviewDuplicateCandidate,inspectDuplicateConsolidation}=require('../lib/catalog-integrity');

async function addProduct(sku,name,barcode,price,cost,stock){
  const r=await db.execute({sql:`INSERT INTO products(sku,name,barcode,price,cost,tax_rate,stock_qty,min_stock,active,unit)
    VALUES(?,?,?,?,?,15,?,0,1,'each')`,args:[sku,name,barcode,price,cost,stock]});
  return Number(r.lastInsertRowid);
}
async function run(){
  await ensureReady();
  const emp=await db.execute({sql:"INSERT INTO employees(employee_number,first_name,last_name,username,pin,role) VALUES('CP-1','Preview','Reviewer','consolidation-preview-runtime','4444','admin')",args:[]});
  const actor=Number(emp.lastInsertRowid);
  const {rows:[branch]}=await db.execute({sql:'SELECT id FROM branches WHERE active=1 ORDER BY id LIMIT 1',args:[]});
  const a=await addProduct('MERGE-A','Runtime Duplicate Drill','111111',100,60,2);
  const b=await addProduct('MERGE-B','Runtime Duplicate Drill','222222',110,65,0);
  await db.execute({sql:'INSERT OR REPLACE INTO branch_inventory(product_id,branch_id,stock_qty,min_stock) VALUES(?,?,?,0)',args:[a,branch.id,2]});
  await db.execute({sql:'CREATE TABLE IF NOT EXISTS quote_consolidation_runtime(id INTEGER PRIMARY KEY,product_id INTEGER)',args:[]});
  await db.execute({sql:'INSERT INTO quote_consolidation_runtime(product_id) VALUES(?),(?)',args:[a,b]});
  await db.execute({sql:'CREATE TABLE IF NOT EXISTS product_uom_profiles(product_id INTEGER PRIMARY KEY,base_uom TEXT)',args:[]});
  await db.execute({sql:"INSERT OR REPLACE INTO product_uom_profiles(product_id,base_uom) VALUES(?,'each'),(?,'box')",args:[a,b]});
  const key=duplicateCandidateKey('duplicate_product_name',[a,b]);

  let notConfirmed=false;
  try{await inspectDuplicateConsolidation(key);}catch(e){notConfirmed=e.code==='CATALOG_CONSOLIDATION_NOT_CONFIRMED';}
  assert.equal(notConfirmed,true);

  await reviewDuplicateCandidate({candidateKey:key,decision:'confirmed_duplicate',reason:'Verified same manufacturer model and item',actorEmployeeId:actor,expectedVersion:0});
  const before=(await db.execute({sql:'SELECT id,sku,barcode,price,cost,stock_qty,active FROM products WHERE id IN (?,?) ORDER BY id',args:[a,b]})).rows;
  const preview=await inspectDuplicateConsolidation(key);
  assert.equal(preview.read_only,true);assert.equal(preview.survivor_selected,false);
  assert.equal(preview.products.length,2);
  assert.ok(preview.products.every(p=>Object.hasOwn(p.dependency_domains,'Quotes')));
  const codes=new Set(preview.blockers.map(x=>x.code));
  for(const code of ['physical_stock_present','barcode_conflict','uom_conflict','price_conflict','cost_conflict','history_spread_across_records'])assert.ok(codes.has(code),code);
  assert.ok(preview.products.some(p=>Number(p.dependency_domains.Quotes)>0));
  assert.ok(!JSON.stringify(preview).includes('quote_consolidation_runtime'),'raw table names must not escape preview');
  const after=(await db.execute({sql:'SELECT id,sku,barcode,price,cost,stock_qty,active FROM products WHERE id IN (?,?) ORDER BY id',args:[a,b]})).rows;
  assert.deepEqual(after,before,'preview must not mutate products');

  const c=await addProduct('MERGE-C','Runtime Duplicate Drill','333333',100,60,0);
  let stale=false;
  try{await inspectDuplicateConsolidation(key);}catch(e){stale=e.code==='CATALOG_CONSOLIDATION_CANDIDATE_STALE';}
  assert.equal(stale,true);
  await db.execute({sql:'DELETE FROM products WHERE id=?',args:[c]});
  console.log('Catalog consolidation preview runtime certification passed.');
}
run().then(async()=>{try{await db.close?.()}catch(_){}for(const s of ['','-shm','-wal'])try{fs.rmSync(dbPath+s,{force:true})}catch(_){}process.exit(0)}).catch(async e=>{console.error(e.stack||e);try{await db.close?.()}catch(_){}process.exit(1)});
