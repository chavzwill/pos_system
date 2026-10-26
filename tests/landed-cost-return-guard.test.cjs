'use strict';
const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tt-late-return-'));process.env.TURSO_DATABASE_URL='file:'+path.join(dir,'db');process.env.TURSO_AUTH_TOKEN='';
const {db}=require('../database'),{finalizeLandedCostAllocationItem}=require('../lib/landed-cost-revaluation');
const sql=(sql,args=[])=>({sql,args});
after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
test('late landed cost after a return in the same pool rejects and rolls back immutable layer evidence',async()=>{
 await db.batch([
 'CREATE TABLE inventory_cost_layers(id INTEGER PRIMARY KEY,purchase_receipt_item_id INTEGER,product_id INTEGER,branch_key INTEGER,quantity_original REAL,received_at TEXT,landed_cost_total REAL)',
 'CREATE TABLE landed_cost_allocations(id INTEGER PRIMARY KEY,allocated_at TEXT,allocation_number TEXT)',
 'CREATE TABLE landed_cost_allocation_items(id INTEGER PRIMARY KEY,allocation_id INTEGER,purchase_receipt_item_id INTEGER,allocated_amount REAL,quantity_received REAL,product_id INTEGER)',
 'CREATE TABLE landed_cost_revaluations(allocation_item_id INTEGER)',
 'CREATE TABLE inventory_adjustment_valuations(product_id INTEGER,branch_key INTEGER,quantity_change REAL,created_at TEXT)',
 "INSERT INTO inventory_cost_layers VALUES(1,10,5,1,5,'2026-01-01',0)",
 "INSERT INTO landed_cost_allocations VALUES(1,'2026-01-03','LC1')",
 // Different receipt's outbound movement still affects this moving-average pool.
 "INSERT INTO inventory_adjustment_valuations VALUES(5,1,-2,'2026-01-02')",
 "CREATE TRIGGER layer_update AFTER INSERT ON landed_cost_allocation_items BEGIN UPDATE inventory_cost_layers SET landed_cost_total=landed_cost_total+NEW.allocated_amount WHERE purchase_receipt_item_id=NEW.purchase_receipt_item_id; END"
 ],'write');
 const tx=await db.transaction('write');
 try{await tx.execute(sql('INSERT INTO landed_cost_allocation_items VALUES(1,1,10,20,5,5)'));await assert.rejects(finalizeLandedCostAllocationItem(tx,1),/outbound|adjustment|unsupported/i);}finally{await tx.rollback();}
 assert.equal((await db.execute('SELECT COUNT(*) n FROM landed_cost_allocation_items')).rows[0].n,0);
 assert.equal((await db.execute('SELECT landed_cost_total FROM inventory_cost_layers')).rows[0].landed_cost_total,0);
});
