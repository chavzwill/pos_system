'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert');
const dbPath=path.join(os.tmpdir(),`pos-category-consolidation-${process.pid}.db`);
for(const s of ['','-shm','-wal'])try{fs.rmSync(dbPath+s,{force:true})}catch(_){}
process.env.TURSO_DATABASE_URL=`file:${dbPath.replace(/\\/g,'/')}`;
const {db,ensureReady}=require('../database');
const {categoryCandidateKey,inspectCategoryConsolidation,consolidateDuplicateCategories,resolveCanonicalCategory,catalogHealth}=require('../lib/catalog-integrity');
async function run(){
  await ensureReady();
  const emp=await db.execute({sql:"INSERT INTO employees(employee_number,first_name,last_name,username,pin,role) VALUES('CC-1','Category','Control','category-control-runtime','9292','admin')",args:[]});
  const actor=Number(emp.lastInsertRowid);
  const a=await db.execute({sql:"INSERT INTO categories(name,description) VALUES('Power Tools','Primary')",args:[]});
  const b=await db.execute({sql:"INSERT INTO categories(name,description) VALUES(' power tools ','Duplicate')",args:[]});
  const c1=Number(a.lastInsertRowid),c2=Number(b.lastInsertRowid),key=categoryCandidateKey([c1,c2]);
  const p=await db.execute({sql:"INSERT INTO products(sku,name,price,cost,tax_rate,stock_qty,min_stock,active,unit,category_id) VALUES('CAT-1','Runtime Drill',100,60,15,0,0,1,'each',?)",args:[c2]});
  const productId=Number(p.lastInsertRowid);
  const promo=await db.execute({sql:"INSERT INTO promotions(name,type,value,min_purchase,applies_to,active) VALUES('Category Deal','percentage',10,0,'specific',1)",args:[]});
  const promoId=Number(promo.lastInsertRowid);
  await db.execute({sql:"INSERT INTO promotion_items(promotion_id,item_type,item_id) VALUES(?,'category',?)",args:[promoId,c2]});
  const preview=await inspectCategoryConsolidation(key);
  assert.equal(preview.read_only,true);
  assert.equal(preview.categories.length,2);
  assert.equal(preview.categories.find(x=>x.id===c2).product_count,1);
  assert.equal(preview.categories.find(x=>x.id===c2).promotion_count,1);
  const health=await catalogHealth({limit:200});
  const issue=health.remediation_queue.flatMap(x=>x.issues||[]).find(x=>x.code==='duplicate_category_name'&&x.record?.candidate_key===key);
  assert.ok(issue);assert.equal(issue.record.candidate_key,key);
  const result=await consolidateDuplicateCategories({candidateKey:key,survivorCategoryId:c1,reason:'Unify duplicate category records safely',confirmation:'CONSOLIDATE',actorEmployeeId:actor});
  assert.equal(result.changed,true);
  assert.deepEqual(result.removed_category_ids,[c2]);
  const {rows:[product]}=await db.execute({sql:'SELECT category_id FROM products WHERE id=?',args:[productId]});
  assert.equal(Number(product.category_id),c1);
  const {rows:scopes}=await db.execute({sql:"SELECT item_id FROM promotion_items WHERE promotion_id=? AND item_type='category'",args:[promoId]});
  assert.deepEqual(scopes.map(x=>Number(x.item_id)),[c1]);
  const {rows:[oldCategory]}=await db.execute({sql:'SELECT id FROM categories WHERE id=?',args:[c2]});
  assert.equal(oldCategory,undefined);
  const canonical=await resolveCanonicalCategory(c2);
  assert.equal(canonical.is_consolidated,true);
  assert.equal(canonical.canonical_category_id,c1);
  const retry=await consolidateDuplicateCategories({candidateKey:key,survivorCategoryId:c1,reason:'Unify duplicate category records safely',confirmation:'CONSOLIDATE',actorEmployeeId:actor});
  assert.equal(retry.changed,false);
  let conflict=null;
  try{await consolidateDuplicateCategories({candidateKey:key,survivorCategoryId:c2,reason:'Wrong survivor retry',confirmation:'CONSOLIDATE',actorEmployeeId:actor});}catch(e){conflict=e}
  assert.equal(conflict?.code,'CATALOG_CATEGORY_CONSOLIDATION_ALREADY_COMPLETED');
  const {rows:[audit]}=await db.execute({sql:"SELECT action,target_id FROM security_audit_events WHERE action='catalog_category_consolidated' ORDER BY id DESC LIMIT 1",args:[]});
  assert.equal(audit.action,'catalog_category_consolidated');assert.equal(audit.target_id,key);
  console.log('Category consolidation runtime certification passed.');
}
run().then(async()=>{try{await db.close?.()}catch(_){}for(const s of ['','-shm','-wal'])try{fs.rmSync(dbPath+s,{force:true})}catch(_){}process.exit(0)}).catch(async e=>{console.error(e.stack||e);try{await db.close?.()}catch(_){}process.exit(1)});