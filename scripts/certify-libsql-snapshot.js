'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createClient}=require('@libsql/client');
const {snapshotLibsql,verifyBackup}=require('../lib/verified-libsql-snapshot');

async function expectReject(promise,pattern){
 await assert.rejects(promise,pattern);
}
async function main(){
 const work=await fsp.mkdtemp(path.join(os.tmpdir(),'tt-pos-backup-cert-'));
 let source,restored,invalid;
 try{
  const src=path.join(work,'source.db');
  source=createClient({url:'file:'+src});
  await source.execute('PRAGMA foreign_keys=ON');
  await source.execute('CREATE TABLE suppliers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE)');
  await source.execute('CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_id INTEGER NOT NULL REFERENCES suppliers(id), amount INTEGER NOT NULL CHECK(amount>=0))');
  await source.execute('CREATE TABLE "special names" (key TEXT PRIMARY KEY, source TEXT NOT NULL) WITHOUT ROWID');
  await source.execute('CREATE TABLE proof (id INTEGER PRIMARY KEY, payload BLOB NOT NULL)');
  await source.execute('CREATE INDEX orders_supplier_idx ON orders(supplier_id)');
  await source.execute('CREATE VIEW valid_order_totals AS SELECT supplier_id,SUM(amount) AS total FROM orders GROUP BY supplier_id');
  await source.execute('CREATE TRIGGER order_positive AFTER INSERT ON orders WHEN new.amount < 0 BEGIN SELECT RAISE(ABORT, "Negative"); END');
  await source.execute({sql:'INSERT INTO suppliers(name) VALUES(?)',args:['Wholesale A']});
  await source.execute({sql:'INSERT INTO suppliers(name) VALUES(?)',args:['Supplier B']});
  for(let i=1;i<=5;i++)await source.execute({sql:'INSERT INTO orders(supplier_id,amount) VALUES (?,?)',args:[i%2+1,i*15]});
  await source.execute({sql:'INSERT INTO "special names"(key,source) VALUES (?,?)',args:['k1','test data']});
  await source.execute({sql:'INSERT INTO proof(id,payload) VALUES (?,?)',args:[1,new Uint8Array([0,127,128,255])]});
  await source.execute({sql:'INSERT INTO suppliers(name) VALUES (?)',args:['Deleted history']});
  await source.execute({sql:'DELETE FROM suppliers WHERE name=?',args:['Deleted history']});
  const sourceSequences=(await source.execute({sql:'SELECT name,seq FROM sqlite_sequence WHERE name=?',args:['suppliers']})).rows;
  const output=path.join(work,'snapshot.db');
  const info=await snapshotLibsql({source,output,chunkSize:2,sourceKind:'synthetic-test'});
  assert.equal(info.total_rows,9);
  assert.equal(info.table_counts.suppliers,2);
  assert.equal(info.table_counts.orders,5);
  assert.equal(info.scope,'database_only_no_uploads');
  assert.equal((await verifyBackup({path:output})).verified,true);
  const mode=(await fsp.stat(output)).mode&0o777;
  assert.equal(mode&0o077,0,'snapshot file has permissive Unix access');
  restored=createClient({url:'file:'+output});
  const sequences=(await restored.execute('SELECT name,seq FROM sqlite_sequence WHERE name="suppliers"')).rows;
  assert.equal(Number(sequences[0].seq),Number(sourceSequences[0].seq));
  assert.equal((await restored.execute('SELECT total FROM valid_order_totals WHERE supplier_id=2')).rows.length,1);
  assert.equal((await restored.execute('SELECT key FROM "special names"')).rows[0].key,'k1');
  assert.equal((await restored.execute('SELECT length(payload) AS n FROM proof')).rows[0].n,4);
  assert.equal((await restored.execute("SELECT name FROM sqlite_master WHERE name='orders_supplier_idx'")).rows.length,1);
  assert.equal((await restored.execute("SELECT name FROM sqlite_master WHERE name='order_positive'")).rows.length,1);
  await restored.close();restored=null;
  await expectReject(snapshotLibsql({source,output,chunkSize:2}),/overwrite existing backup artifact/);
  let manifest=JSON.parse(await fsp.readFile(output+'.manifest.json','utf8'));
  manifest.sha256='0'.repeat(64);
  await fsp.writeFile(output+'.manifest.json',JSON.stringify(manifest));
  await expectReject(verifyBackup({path:output}),/SHA-256 mismatch/);
  // A midstream source failure cannot publish a half-made SQLite backup.
  const failing={
   transaction:async mode=>{
    assert.equal(mode,'read');
    const t=await source.transaction(mode);
    let executed=0;
    return {
     execute:async query=>{if(++executed===6)throw new Error('simulated source failure');return t.execute(query);},
     commit:()=>t.commit(),
     rollback:()=>t.rollback()
    };
   }
  };
  const broken=path.join(work,'partial.db');
  await expectReject(snapshotLibsql({source:failing,output:broken,chunkSize:2}),/simulated source failure/);
  assert.equal(fs.existsSync(broken),false);
  assert.equal(fs.existsSync(broken+'.manifest.json'),false);
  // FK violations are rejected, even if the source was historically inconsistent.
  const corrupt=path.join(work,'corrupt.db');
  invalid=createClient({url:'file:'+corrupt});
  await invalid.execute('PRAGMA foreign_keys=OFF');
  await invalid.execute('CREATE TABLE parent (id INTEGER PRIMARY KEY)');
  await invalid.execute('CREATE TABLE child (parent_id INTEGER REFERENCES parent(id))');
  await invalid.execute('INSERT INTO child (parent_id) VALUES(123)');
  const impossible=path.join(work,'invalid-snapshot.db');
  await expectReject(snapshotLibsql({source:invalid,output:impossible,chunkSize:2}),/broken foreign-key reference/);
  assert.equal(fs.existsSync(impossible),false);
  assert.equal(fs.existsSync(impossible+'.manifest.json'),false);
  console.log('PASS: read-only consistent snapshot, schema/views/triggers/indexes, PK/FK, BLOB, sequence, pagination, checksum, no-overwrite, fail-closed and manifest');
 }finally{
  if(restored)await Promise.resolve().then(()=>restored.close()).catch(()=>{});
  if(source)await Promise.resolve().then(()=>source.close()).catch(()=>{});
  if(invalid)await Promise.resolve().then(()=>invalid.close()).catch(()=>{});
  await fsp.rm(work,{recursive:true,force:true});
 }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
