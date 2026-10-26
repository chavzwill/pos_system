'use strict';
const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tt-return-cents-'));process.env.TURSO_DATABASE_URL='file:'+path.join(dir,'db');process.env.TURSO_AUTH_TOKEN='';
const {db}=require('../database'),{settlementCarryingCents}=require('../lib/supplier-return-settlement');
after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
test('fractional carrying value clears exactly once across posted credits and replacement evidence',async()=>{
 await db.batch(['CREATE TABLE supplier_credit_posting_items(return_item_id INTEGER,quantity REAL,carrying_cents INTEGER)','CREATE TABLE supplier_return_replacements(return_item_id INTEGER,quantity REAL,original_value REAL)'],'write');
 const line={id:1,quantity:3,carrying_cents:1,tracked_value:0.01};
 assert.equal(await settlementCarryingCents(db,line,1),0);
 await db.execute('INSERT INTO supplier_credit_posting_items VALUES(1,1,0)');
 assert.equal(await settlementCarryingCents(db,line,1),1);
 await db.execute('INSERT INTO supplier_return_replacements VALUES(1,1,0.01)');
 assert.equal(await settlementCarryingCents(db,line,1),0);
 await assert.rejects(settlementCarryingCents(db,line,2),/exceeds/);
});
