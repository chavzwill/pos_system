'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert');
const dbPath=path.join(os.tmpdir(),`pos-catalog-duplicate-review-${process.pid}.db`);
for(const s of ['','-shm','-wal'])try{fs.rmSync(dbPath+s,{force:true})}catch(_){}
process.env.TURSO_DATABASE_URL=`file:${dbPath.replace(/\\/g,'/')}`;
const {db,ensureReady}=require('../database');
const {catalogHealth,reviewDuplicateCandidate,duplicateCandidateKey}=require('../lib/catalog-integrity');

async function addProduct(sku,name){
  const r=await db.execute({sql:`INSERT INTO products(sku,name,price,cost,tax_rate,stock_qty,min_stock,active,unit) VALUES(?,?,10,5,15,0,0,1,'each')`,args:[sku,name]});
  return Number(r.lastInsertRowid);
}
async function run(){
  await ensureReady();
  const emp=await db.execute({sql:"INSERT INTO employees(employee_number,first_name,last_name,username,pin,role) VALUES('DR-1','Duplicate','Reviewer','duplicate-review-runtime','4321','admin')",args:[]});
  const actor=Number(emp.lastInsertRowid);
  const a=await addProduct('DUP-A','Cordless Drill');
  const b=await addProduct('DUP-B','Cordless Drill');
  const key=duplicateCandidateKey('duplicate_product_name',[a,b]);

  let health=await catalogHealth({limit:200});
  let candidate=health.issues.find(x=>x.record?.candidate_key===key);
  assert.ok(candidate,'initial duplicate candidate must exist');
  assert.equal(Number(candidate.record.review_version||0),0);
  const before=(await db.execute({sql:'SELECT id,sku,name,active,stock_qty,price FROM products WHERE id IN (?,?) ORDER BY id',args:[a,b]})).rows;

  const notDup=await reviewDuplicateCandidate({candidateKey:key,decision:'not_duplicate',reason:'Different manufacturer model numbers verified',actorEmployeeId:actor,expectedVersion:0});
  assert.equal(notDup.changed,true);assert.equal(Number(notDup.review.version),1);
  health=await catalogHealth({limit:200});
  assert.ok(!health.issues.some(x=>x.record?.candidate_key===key),'exact reviewed candidate must be suppressed');

  const after=(await db.execute({sql:'SELECT id,sku,name,active,stock_qty,price FROM products WHERE id IN (?,?) ORDER BY id',args:[a,b]})).rows;
  assert.deepEqual(after,before,'duplicate review must not mutate products');

  const c=await addProduct('DUP-C','Cordless Drill');
  const changedKey=duplicateCandidateKey('duplicate_product_name',[a,b,c]);
  health=await catalogHealth({limit:200});
  candidate=health.issues.find(x=>x.record?.candidate_key===changedKey);
  assert.ok(candidate,'changed group membership must create a fresh candidate fingerprint');
  assert.notEqual(changedKey,key);

  const confirmed=await reviewDuplicateCandidate({candidateKey:changedKey,decision:'confirmed_duplicate',reason:'Staff verified all three records are the same item',actorEmployeeId:actor,expectedVersion:0});
  assert.equal(Number(confirmed.review.version),1);
  health=await catalogHealth({limit:200});
  candidate=health.issues.find(x=>x.record?.candidate_key===changedKey);
  assert.ok(candidate,'confirmed duplicate must remain visible');
  assert.equal(candidate.severity,'high');
  assert.equal(candidate.title,'Confirmed duplicate products need consolidation');
  assert.equal(candidate.record.review_decision,'confirmed_duplicate');
  assert.equal(Number(candidate.record.review_version),1);

  let stale=false;
  try{await reviewDuplicateCandidate({candidateKey:changedKey,decision:'needs_more_info',reason:'Second reviewer needs supporting invoice evidence',actorEmployeeId:actor,expectedVersion:0});}
  catch(e){stale=e.code==='CATALOG_DUPLICATE_REVIEW_STALE';}
  assert.equal(stale,true,'stale review version must fail closed');

  const updated=await reviewDuplicateCandidate({candidateKey:changedKey,decision:'needs_more_info',reason:'Need supplier evidence before consolidation',actorEmployeeId:actor,expectedVersion:1});
  assert.equal(Number(updated.review.version),2);
  const {rows:[events]}=await db.execute({sql:'SELECT COUNT(*) c FROM catalog_duplicate_review_events WHERE candidate_key=?',args:[changedKey]});
  assert.equal(Number(events.c),2);
  const {rows:[audit]}=await db.execute({sql:"SELECT COUNT(*) c FROM security_audit_events WHERE action='catalog_duplicate_review_changed' AND target_id=?",args:[changedKey]});
  assert.ok(Number(audit.c)>=2,'security audit must capture review changes');

  const {rows:[event]}=await db.execute({sql:'SELECT id FROM catalog_duplicate_review_events WHERE candidate_key=? ORDER BY id LIMIT 1',args:[changedKey]});
  let updateBlocked=false,deleteBlocked=false;
  try{await db.execute({sql:"UPDATE catalog_duplicate_review_events SET reason='tampered' WHERE id=?",args:[event.id]});}catch(e){updateBlocked=/append-only/i.test(String(e.message||''));}
  try{await db.execute({sql:'DELETE FROM catalog_duplicate_review_events WHERE id=?',args:[event.id]});}catch(e){deleteBlocked=/append-only/i.test(String(e.message||''));}
  assert.equal(updateBlocked,true);assert.equal(deleteBlocked,true);

  const finalRows=(await db.execute({sql:'SELECT id,sku,name,active,stock_qty,price FROM products WHERE id IN (?,?,?) ORDER BY id',args:[a,b,c]})).rows;
  assert.equal(finalRows.length,3);
  assert.ok(finalRows.every(x=>Number(x.active)===1&&Number(x.stock_qty)===0),'review must not alter product state or stock');
  console.log('Catalog duplicate review runtime certification passed.');
}
run().then(async()=>{try{await db.close?.()}catch(_){}for(const s of ['','-shm','-wal'])try{fs.rmSync(dbPath+s,{force:true})}catch(_){}process.exit(0)}).catch(async e=>{console.error(e.stack||e);try{await db.close?.()}catch(_){}process.exit(1)});
