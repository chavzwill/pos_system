'use strict';
const fs=require('fs');
const path=require('path');
const os=require('os');
const assert=require('assert');

const dbPath=path.join(os.tmpdir(),`pos-predictive-${process.pid}.db`);
try{fs.rmSync(dbPath,{force:true});}catch(_){}
process.env.TURSO_DATABASE_URL=`file:${dbPath.replace(/\\/g,'/')}`;

const {db,ensureReady}=require('../database');
const {lookup,ensureSchema}=require('../lib/predictive-lookup');

function employee(permissions,branchId=1){return{id:9001,default_branch_id:branchId,permissions};}
async function run(){
  await ensureReady();
  await ensureSchema();

  await db.execute({sql:"INSERT INTO suppliers(supplier_number,name,contact_name,email,phone,active) VALUES(?,?,?,?,?,1)",args:['SUP-RUNTIME','Runtime Industrial Supply','A. Buyer','runtime@supplier.test','8765551000']});
  const {rows:[supplier]}=await db.execute({sql:"SELECT id FROM suppliers WHERE supplier_number=?",args:['SUP-RUNTIME']});
  await db.execute({sql:"INSERT INTO customers(customer_number,first_name,last_name,email,phone,active) VALUES(?,?,?,?,?,1)",args:['CUST-RUNTIME','Runtime','Customer','runtime@customer.test','8765552000']});
  const {rows:[customer]}=await db.execute({sql:"SELECT id FROM customers WHERE customer_number=?",args:['CUST-RUNTIME']});
  await db.execute({sql:"INSERT INTO products(sku,barcode,name,description,price,cost,tax_rate,stock_qty,min_stock,active,model_number,supplier_id) VALUES(?,?,?,?,?,?,?,?,?,1,?,?)",args:['RT-EXACT-001','990000001','Runtime Hammer Drill','Cordless workshop drill',25000,16000,15,9,2,'RTHD-20V',supplier.id]});
  const {rows:[product]}=await db.execute({sql:"SELECT id FROM products WHERE sku=?",args:['RT-EXACT-001']});
  await db.execute({sql:"INSERT OR REPLACE INTO branch_inventory(product_id,branch_id,stock_qty,min_stock) VALUES(?,?,?,?)",args:[product.id,1,7,2]});
  await db.execute({sql:"INSERT INTO lookup_aliases(entity_type,entity_id,alias,alias_normalized,status,evidence_source,created_by) VALUES(?,?,?,?,?,?,?)",args:['product',product.id,'site drill','site drill','approved','runtime-test',1]});
  await db.execute({sql:"INSERT INTO lookup_aliases(entity_type,entity_id,alias,alias_normalized,status,evidence_source,created_by) VALUES(?,?,?,?,?,?,?)",args:['product',product.id,'secret drill','secret drill','pending','runtime-test',1]});

  const stockUser=employee({inventory:true});
  const exact=await lookup({domain:'product',query:'RT-EXACT-001',employee:stockUser,branch_id:1,limit:8,include_variations:false});
  assert.equal(exact.exact_match?.entity_id,Number(product.id));
  assert.equal(exact.results[0].match_kind,'exact_identifier');
  assert.equal(exact.results[0].availability.on_hand,7);
  assert.equal(exact.results[0].context.cost,16000);
  const alias=await lookup({domain:'product',query:'site drill',employee:stockUser,branch_id:1,limit:8,include_variations:false});
  assert.equal(alias.results[0]?.entity_id,Number(product.id));
  assert.equal(alias.results[0]?.match_kind,'reviewed_alias');

  const pending=await lookup({domain:'product',query:'secret drill',employee:stockUser,branch_id:1,limit:8,include_variations:false});
  assert.equal(pending.results.length,0);

  const fuzzy=await lookup({domain:'product',query:'runtime dril',employee:stockUser,branch_id:1,limit:8,include_variations:false});
  assert.equal(fuzzy.results[0]?.entity_id,Number(product.id));
  assert.ok(['token_match','fuzzy_match'].includes(fuzzy.results[0]?.match_kind));

  const wildcard=await lookup({domain:'product',query:'%%',employee:stockUser,branch_id:1,limit:20,include_variations:false});
  assert.equal(wildcard.results.length,0);

  const supplierSearch=await lookup({domain:'supplier',query:'SUP-RUNTIME',employee:employee({purchasing:true}),limit:8});
  assert.equal(supplierSearch.exact_match?.entity_id,Number(supplier.id));

  const customerSearch=await lookup({domain:'customer',query:'8765552000',employee:employee({pos:true}),limit:8});
  assert.equal(customerSearch.exact_match?.entity_id,Number(customer.id));
  assert.equal(Object.prototype.hasOwnProperty.call(customerSearch.results[0].context,'account_balance'),false);

  await assert.rejects(()=>lookup({domain:'supplier',query:'Runtime',employee:employee({pos:true}),limit:8}),e=>e&&e.status===403);
  await assert.rejects(()=>lookup({domain:'product',query:'Runtime',employee:employee({inventory:true},1),branch_id:999,limit:8}),e=>e&&e.status===403);
  const limited=await lookup({domain:'product',query:'runtime',employee:stockUser,branch_id:1,limit:999,include_variations:false});
  assert.ok(limited.results.length<=20);

  const short=await lookup({domain:'product',query:'r',employee:stockUser,branch_id:1,limit:8,include_variations:false});
  assert.deepEqual(short.results,[]);

  console.log('Predictive lookup runtime certification passed.');
}
run().then(async()=>{try{await db.close?.();}catch(_){}try{fs.rmSync(dbPath,{force:true});fs.rmSync(dbPath+'-shm',{force:true});fs.rmSync(dbPath+'-wal',{force:true});}catch(_){}process.exit(0);}).catch(async error=>{console.error(error.stack||error);try{await db.close?.();}catch(_){}try{fs.rmSync(dbPath,{force:true});fs.rmSync(dbPath+'-shm',{force:true});fs.rmSync(dbPath+'-wal',{force:true});}catch(_){}process.exit(1);});
