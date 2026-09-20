'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert');
const dbPath=path.join(os.tmpdir(),`pos-category-correction-${process.pid}.db`);
for(const s of ['','-shm','-wal'])try{fs.rmSync(dbPath+s,{force:true})}catch(_){}
process.env.TURSO_DATABASE_URL=`file:${dbPath.replace(/\\/g,'/')}`;
const {db,ensureReady}=require('../database');
const {ensureSchema,previewReclassification,correctCategoryDetails,reclassifyProducts}=require('../lib/category-correction');
async function run(){
  await ensureReady();await ensureSchema();
  const emp=await db.execute({sql:"INSERT INTO employees(employee_number,first_name,last_name,username,pin,role) VALUES('CR-1','Category','Corrector','category-corrector-runtime','9191','admin')",args:[]});
  const actor=Number(emp.lastInsertRowid);
  const a=await db.execute({sql:"INSERT INTO categories(name,description) VALUES('Power Tool','Needs correction')",args:[]});
  const b=await db.execute({sql:"INSERT INTO categories(name,description) VALUES('Hand Tools','Target')",args:[]});
  const c=await db.execute({sql:"INSERT INTO categories(name,description) VALUES('Garden','Other')",args:[]});
  const source=Number(a.lastInsertRowid),target=Number(b.lastInsertRowid),other=Number(c.lastInsertRowid);
  const p1=await db.execute({sql:"INSERT INTO products(sku,name,price,cost,tax_rate,stock_qty,min_stock,active,unit,category_id) VALUES('CR-1','Drill',100,60,15,0,0,1,'each',?)",args:[source]});
  const p2=await db.execute({sql:"INSERT INTO products(sku,name,price,cost,tax_rate,stock_qty,min_stock,active,unit,category_id) VALUES('CR-2','Saw',100,60,15,0,0,1,'each',?)",args:[source]});
  const id1=Number(p1.lastInsertRowid),id2=Number(p2.lastInsertRowid);
  const corrected=await correctCategoryDetails({categoryId:source,name:'Power Tools',description:'Corrected',reason:'Correct naming mistake',expectedName:'Power Tool',actorEmployeeId:actor});
  assert.equal(corrected.changed,true);assert.equal(corrected.category.name,'Power Tools');
  let stale=null;try{await correctCategoryDetails({categoryId:source,name:'Power Equipment',description:'Wrong stale edit',reason:'Should fail stale',expectedName:'Power Tool',actorEmployeeId:actor})}catch(e){stale=e}
  assert.equal(stale?.code,'CATEGORY_CORRECTION_STALE');
  const preview=await previewReclassification({sourceCategoryId:source,targetCategoryId:target,productIds:[id1]});
  assert.equal(preview.read_only,true);assert.equal(preview.product_count,1);assert.equal(preview.products[0].id,id1);
  const moved=await reclassifyProducts({sourceCategoryId:source,targetCategoryId:target,productIds:[id1],reason:'Move misclassified drill',expectedSourceProductCount:2,actorEmployeeId:actor});
  assert.equal(moved.changed,true);assert.deepEqual(moved.moved_product_ids,[id1]);
  const {rows:[after1]}=await db.execute({sql:'SELECT category_id FROM products WHERE id=?',args:[id1]});
  const {rows:[after2]}=await db.execute({sql:'SELECT category_id FROM products WHERE id=?',args:[id2]});
  assert.equal(Number(after1.category_id),target);assert.equal(Number(after2.category_id),source);
  let wrongSource=null;try{await previewReclassification({sourceCategoryId:source,targetCategoryId:other,productIds:[id1]})}catch(e){wrongSource=e}
  assert.equal(wrongSource?.code,'CATEGORY_RECLASSIFICATION_STALE');
  const {rows:events}=await db.execute({sql:'SELECT action FROM catalog_category_correction_events ORDER BY id',args:[]});
  assert.deepEqual(events.map(x=>x.action),['details_corrected','products_reclassified']);
  const {rows:audits}=await db.execute({sql:"SELECT action FROM security_audit_events WHERE action IN ('catalog_category_corrected','catalog_products_reclassified') ORDER BY id",args:[]});
  assert.deepEqual(audits.map(x=>x.action),['catalog_category_corrected','catalog_products_reclassified']);
  console.log('Category correction runtime certification passed.');
}
run().then(async()=>{try{await db.close?.()}catch(_){}for(const s of ['','-shm','-wal'])try{fs.rmSync(dbPath+s,{force:true})}catch(_){}process.exit(0)}).catch(async e=>{console.error(e.stack||e);try{await db.close?.()}catch(_){}process.exit(1)});