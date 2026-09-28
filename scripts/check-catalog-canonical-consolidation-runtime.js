'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert');
const dbPath=path.join(os.tmpdir(),`pos-canonical-consolidation-${process.pid}.db`);
for(const s of ['','-shm','-wal'])try{fs.rmSync(dbPath+s,{force:true})}catch(_){}
process.env.TURSO_DATABASE_URL=`file:${dbPath.replace(/\\/g,'/')}`;
const {db,ensureReady}=require('../database');
const {duplicateCandidateKey,reviewDuplicateCandidate,consolidateDuplicateProducts}=require('../lib/catalog-integrity');

async function addProduct({sku,name='Cordless Drill',barcode=null,model=null,stock=0,unit='each'}){
  const r=await db.execute({sql:`INSERT INTO products(sku,name,barcode,model_number,price,cost,tax_rate,stock_qty,min_stock,active,unit)
    VALUES(?,?,?,?,100,60,15,?,0,1,?)`,args:[sku,name,barcode,model,stock,unit]});
  return Number(r.lastInsertRowid);
}
async function run(){
  await ensureReady();
  const emp=await db.execute({sql:"INSERT INTO employees(employee_number,first_name,last_name,username,pin,role) VALUES('CC-1','Catalog','Consolidator','catalog-consolidation-runtime','7777','admin')",args:[]});
  const actor=Number(emp.lastInsertRowid);
  const {rows:[branch]}=await db.execute({sql:'SELECT id FROM branches WHERE active=1 ORDER BY id LIMIT 1',args:[]});

  const survivor=await addProduct({sku:'DRILL-MASTER',barcode:'111111',model:'MASTER-20V',stock:3});
  const duplicate=await addProduct({sku:'DRILL_OLD',barcode:'222222',model:'OLD-20V',stock:0});
  await db.execute({sql:'INSERT OR REPLACE INTO branch_inventory(product_id,branch_id,stock_qty,min_stock) VALUES(?,?,3,0)',args:[survivor,branch.id]});
  const tx=await db.execute({sql:"INSERT INTO transactions(transaction_number,subtotal,tax_amount,discount_amount,total,payment_method,status) VALUES('CC-TX-1',100,0,0,100,'cash','completed')",args:[]});
  await db.execute({sql:"INSERT INTO transaction_items(transaction_id,product_id,product_name,sku,quantity,unit_price,total) VALUES(?,?,?,?,1,100,100)",args:[Number(tx.lastInsertRowid),duplicate,'Cordless Drill','DRILL_OLD']});

  const key=duplicateCandidateKey('duplicate_product_name',[survivor,duplicate]);
  const review=await reviewDuplicateCandidate({candidateKey:key,decision:'confirmed_duplicate',reason:'Same manufacturer and exact model verified',actorEmployeeId:actor,expectedVersion:0});
  assert.equal(Number(review.review.version),1);
  const beforeSurvivor=(await db.execute({sql:'SELECT active,stock_qty FROM products WHERE id=?',args:[survivor]})).rows[0];
  const result=await consolidateDuplicateProducts({
    candidateKey:key,
    survivorProductId:survivor,
    reason:'Retire duplicate catalog record after verified review',
    confirmation:'CONSOLIDATE',
    expectedReviewVersion:1,
    actorEmployeeId:actor
  });
  assert.equal(result.changed,true);
  assert.deepEqual(result.retired_product_ids,[duplicate]);

  const {rows:[survivorRow]}=await db.execute({sql:'SELECT active,stock_qty FROM products WHERE id=?',args:[survivor]});
  const {rows:[duplicateRow]}=await db.execute({sql:'SELECT active,stock_qty FROM products WHERE id=?',args:[duplicate]});
  assert.equal(Number(survivorRow.active),1);
  assert.equal(Number(survivorRow.stock_qty),Number(beforeSurvivor.stock_qty));
  assert.equal(Number(duplicateRow.active),0);
  assert.equal(Number(duplicateRow.stock_qty),0);

  const {rows:[history]}=await db.execute({sql:'SELECT product_id FROM transaction_items WHERE transaction_id=?',args:[Number(tx.lastInsertRowid)]});
  assert.equal(Number(history.product_id),duplicate,'historical sale must remain linked to original product');

  const {rows:mappings}=await db.execute({sql:'SELECT * FROM catalog_product_consolidations WHERE candidate_key=?',args:[key]});
  assert.equal(mappings.length,1);
  assert.equal(Number(mappings[0].survivor_product_id),survivor);
  assert.equal(Number(mappings[0].duplicate_product_id),duplicate);

  const {rows:aliases}=await db.execute({sql:"SELECT alias,status,evidence_source FROM lookup_aliases WHERE entity_type='product' AND entity_id=? ORDER BY alias",args:[survivor]});
  const aliasValues=new Set(aliases.map(x=>x.alias));
  for(const expected of ['DRILL_OLD','222222','OLD-20V','Cordless Drill'])assert.ok(aliasValues.has(expected),expected);
  assert.ok(aliases.every(x=>x.status==='approved'&&x.evidence_source==='catalog_consolidation'));

  const {rows:[audit]}=await db.execute({sql:"SELECT action,target_id FROM security_audit_events WHERE action='catalog_duplicate_consolidated' AND target_id=? ORDER BY id DESC LIMIT 1",args:[key]});
  assert.equal(audit.action,'catalog_duplicate_consolidated');
  const retry=await consolidateDuplicateProducts({candidateKey:key,survivorProductId:survivor,reason:'Safe exact retry after completed consolidation',confirmation:'CONSOLIDATE',expectedReviewVersion:1,actorEmployeeId:actor});
  assert.equal(retry.changed,false);
  const {rows:[mappingCount]}=await db.execute({sql:'SELECT COUNT(*) c FROM catalog_product_consolidations WHERE candidate_key=?',args:[key]});
  assert.equal(Number(mappingCount.c),1);

  let updateBlocked=false,deleteBlocked=false;
  try{await db.execute({sql:"UPDATE catalog_product_consolidations SET reason='tamper' WHERE candidate_key=?",args:[key]});}catch(e){updateBlocked=/append-only/i.test(String(e.message||''));}
  try{await db.execute({sql:'DELETE FROM catalog_product_consolidations WHERE candidate_key=?',args:[key]});}catch(e){deleteBlocked=/append-only/i.test(String(e.message||''));}
  assert.equal(updateBlocked,true);assert.equal(deleteBlocked,true);

  const stockSurvivor=await addProduct({sku:'STOCK-A',name:'Impact Driver',stock:0});
  const stockDuplicate=await addProduct({sku:'STOCK_B',name:'Impact Driver',stock:2});
  await db.execute({sql:'INSERT OR REPLACE INTO branch_inventory(product_id,branch_id,stock_qty,min_stock) VALUES(?,?,2,0)',args:[stockDuplicate,branch.id]});
  const stockKey=duplicateCandidateKey('duplicate_product_name',[stockSurvivor,stockDuplicate]);
  await reviewDuplicateCandidate({candidateKey:stockKey,decision:'confirmed_duplicate',reason:'Same impact driver confirmed',actorEmployeeId:actor,expectedVersion:0});
  await assert.rejects(
    ()=>consolidateDuplicateProducts({candidateKey:stockKey,survivorProductId:stockSurvivor,reason:'Attempt with remaining duplicate stock',confirmation:'CONSOLIDATE',expectedReviewVersion:1,actorEmployeeId:actor}),
    e=>e?.code==='CATALOG_CONSOLIDATION_STOCK_PRESENT'
  );

  const staleA=await addProduct({sku:'STALE-A',name:'Angle Grinder'});
  const staleB=await addProduct({sku:'STALE_B',name:'Angle Grinder'});
  const staleKey=duplicateCandidateKey('duplicate_product_name',[staleA,staleB]);
  await reviewDuplicateCandidate({candidateKey:staleKey,decision:'confirmed_duplicate',reason:'Same grinder confirmed',actorEmployeeId:actor,expectedVersion:0});
  await assert.rejects(
    ()=>consolidateDuplicateProducts({candidateKey:staleKey,survivorProductId:staleA,reason:'Stale review attempt',confirmation:'CONSOLIDATE',expectedReviewVersion:2,actorEmployeeId:actor}),
    e=>e?.code==='CATALOG_CONSOLIDATION_REVIEW_STALE'
  );

  await assert.rejects(
    ()=>consolidateDuplicateProducts({candidateKey:staleKey,survivorProductId:999999,reason:'Wrong survivor attempt',confirmation:'CONSOLIDATE',expectedReviewVersion:1,actorEmployeeId:actor}),
    e=>e?.code==='CATALOG_CONSOLIDATION_SURVIVOR_INVALID'
  );

  const raceA=await addProduct({sku:'RACE-A',name:'Reciprocating Saw'});
  const raceB=await addProduct({sku:'RACE_B',name:'Reciprocating Saw'});
  const raceKey=duplicateCandidateKey('duplicate_product_name',[raceA,raceB]);
  await reviewDuplicateCandidate({candidateKey:raceKey,decision:'confirmed_duplicate',reason:'Same saw confirmed for concurrency test',actorEmployeeId:actor,expectedVersion:0});
  const race=await Promise.allSettled([
    consolidateDuplicateProducts({candidateKey:raceKey,survivorProductId:raceA,reason:'Concurrent choice A',confirmation:'CONSOLIDATE',expectedReviewVersion:1,actorEmployeeId:actor}),
    consolidateDuplicateProducts({candidateKey:raceKey,survivorProductId:raceB,reason:'Concurrent choice B',confirmation:'CONSOLIDATE',expectedReviewVersion:1,actorEmployeeId:actor})
  ]);
  assert.equal(race.filter(x=>x.status==='fulfilled').length,1,'exactly one competing survivor may win');
  assert.equal(race.filter(x=>x.status==='rejected').length,1,'competing survivor must fail closed');
  const {rows:raceMappings}=await db.execute({sql:'SELECT survivor_product_id,duplicate_product_id FROM catalog_product_consolidations WHERE candidate_key=?',args:[raceKey]});
  assert.equal(raceMappings.length,1);
  const winner=Number(raceMappings[0].survivor_product_id),loser=Number(raceMappings[0].duplicate_product_id);
  assert.ok([raceA,raceB].includes(winner));assert.ok([raceA,raceB].includes(loser));assert.notEqual(winner,loser);
  const {rows:raceProducts}=await db.execute({sql:'SELECT id,active FROM products WHERE id IN (?,?) ORDER BY id',args:[raceA,raceB]});
  assert.equal(raceProducts.filter(x=>Number(x.active)===1).length,1,'one canonical product remains active');
  assert.equal(raceProducts.filter(x=>Number(x.active)===0).length,1,'one duplicate is retired');

  console.log('Catalog canonical consolidation runtime certification passed.');
}
run().then(async()=>{try{await db.close?.()}catch(_){}for(const s of ['','-shm','-wal'])try{fs.rmSync(dbPath+s,{force:true})}catch(_){}process.exit(0)}).catch(async e=>{console.error(e.stack||e);try{await db.close?.()}catch(_){}process.exit(1)});
