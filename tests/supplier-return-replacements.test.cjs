'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createClient}=require('@libsql/client');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'supplier-replacement-'));
const db=createClient({url:'file:'+path.join(directory,'test.db')});
require.cache[require.resolve('../database')]={exports:{db}};
const replacement=require('../lib/supplier-return-replacements');
function request(key,body={},employee={id:7,default_branch_id:1,permissions:{reports_financial:true}}){return{params:{id:1},body:{return_item_id:1,replacement_receipt_item_id:2,quantity:1,variance_reason:'Replacement unit cost changed',...body},headers:{'idempotency-key':key},employee};}
test('replacement evidence settles actual receipt once, caps competing settlements, and preserves stock/AP',async()=>{
 await db.batch([
  'CREATE TABLE products(id INTEGER PRIMARY KEY,unit TEXT)',
  "INSERT INTO products VALUES(10,'each')",
  'CREATE TABLE supplier_returns(id INTEGER PRIMARY KEY,po_id INTEGER,supplier_id INTEGER,branch_id INTEGER,status TEXT)',
  'CREATE TABLE supplier_return_items(id INTEGER PRIMARY KEY,return_id INTEGER,product_id INTEGER,quantity REAL,tracked_value REAL,stock_movement_id INTEGER)',
  'CREATE TABLE purchase_orders(id INTEGER PRIMARY KEY,po_number TEXT,supplier_id INTEGER,branch_id INTEGER,status TEXT)',
  'CREATE TABLE purchase_receipts(id INTEGER PRIMARY KEY,po_id INTEGER,supplier_id INTEGER,branch_id INTEGER,receipt_number TEXT)',
  'CREATE TABLE purchase_receipt_items(id INTEGER PRIMARY KEY,receipt_id INTEGER,product_id INTEGER,product_name TEXT,quantity_received REAL,unit_cost REAL,line_cost REAL)',
  'CREATE TABLE supplier_credit_notes(id INTEGER PRIMARY KEY,status TEXT)',
  'CREATE TABLE supplier_credit_items(id INTEGER PRIMARY KEY,credit_note_id INTEGER,return_item_id INTEGER,quantity REAL)',
  'CREATE TABLE supplier_invoices(id INTEGER PRIMARY KEY,total REAL)',
  'CREATE TABLE stock_movements(id INTEGER PRIMARY KEY,quantity_change REAL)',
  'CREATE TABLE supplier_invoice_receipt_allocations(purchase_receipt_item_id INTEGER,quantity_invoiced REAL)',
  'CREATE TABLE captured_supplier_invoices(id INTEGER PRIMARY KEY,status TEXT)',
  'CREATE TABLE captured_supplier_invoice_receipts(captured_invoice_id INTEGER,purchase_receipt_item_id INTEGER,quantity_invoiced REAL)',
  "INSERT INTO supplier_returns VALUES(1,1,1,1,'dispatched')",
  'INSERT INTO supplier_return_items VALUES(1,1,10,4,40,1)',
  "INSERT INTO purchase_orders VALUES(1,'PO1',1,1,'received'),(2,'PO2',1,1,'received'),(3,'PO3',1,2,'received')",
  "INSERT INTO purchase_receipts VALUES(1,1,1,1,'R1'),(2,2,1,1,'R2'),(3,3,1,2,'R3')",
  "INSERT INTO purchase_receipt_items VALUES(1,1,10,'Widget',4,10,40),(2,2,10,'Widget',3,12,36),(3,3,10,'Widget',5,10,50)",
  'INSERT INTO stock_movements VALUES(1,-4),(2,3)',
  'INSERT INTO supplier_invoices VALUES(1,100)'
 ],'write');
 await replacement.ensureSupplierReturnReplacementSchema();
 const first=await replacement.linkReplacement(request('replacement-first'));
 assert.equal(Number(first.original_value),10);assert.equal(Number(first.replacement_value),12);
 const lines=(await db.execute('SELECT a.code,l.debit,l.credit FROM journal_lines l JOIN ledger_accounts a ON a.id=l.ledger_account_id ORDER BY l.id')).rows;
 assert.deepEqual(lines.map(x=>[x.code,Number(x.debit),Number(x.credit)]),[['1250',12,0],['1270',0,10],['5280',0,2]]);
 assert.equal(Number((await db.execute('SELECT SUM(debit-credit) n FROM journal_lines')).rows[0].n),0);
 // Replay precedes source revalidation, but always follows branch/role authorization.
 await db.execute("UPDATE purchase_orders SET status='cancelled' WHERE id=2");
 assert.equal((await replacement.linkReplacement(request('replacement-first'))).replayed,true);
 await assert.rejects(replacement.linkReplacement(request('replacement-first',{quantity:2})),/different replacement/);
 await assert.rejects(replacement.linkReplacement(request('replacement-first',{}, {id:7,default_branch_id:2,permissions:{reports_financial:true}})),/another receiving branch/);
 await assert.rejects(replacement.linkReplacement(request('replacement-first',{}, {id:7,default_branch_id:1,permissions:{purchasing_receive:true}})),/Finance/);
 const noHome={id:7,default_branch_id:null,permissions:{reports_financial:true}};
 await assert.rejects(replacement.linkReplacement(request('replacement-first',{},noHome)),/another receiving branch/);
 await assert.rejects(replacement.linkReplacement(request('replacement-no-home',{},noHome)),/another receiving branch/);
 await assert.rejects(replacement.replacementDocument(request('replacement-no-home',{},noHome)),/another receiving branch/);
 const globalFinance={...noHome,permissions:{reports_financial:true,branches:true}};
 assert.equal((await replacement.linkReplacement(request('replacement-first',{},globalFinance))).replayed,true);
 assert.equal((await replacement.replacementDocument(request('replacement-global',{},globalFinance))).replacements.length,1);
 await db.execute("UPDATE purchase_orders SET status='received' WHERE id=2");
 await assert.rejects(replacement.linkReplacement(request('replacement-precision',{quantity:0.00001})),/four decimal/);
 await assert.rejects(replacement.linkReplacement(request('replacement-reason',{variance_reason:''})),/meaningful Finance/);
 await assert.rejects(replacement.linkReplacement(request('replacement-original',{replacement_receipt_item_id:1})),/separate approved PO/);
 await assert.rejects(replacement.linkReplacement(request('replacement-branch',{replacement_receipt_item_id:3})),/same supplier, branch and product/);
 await db.execute("INSERT INTO supplier_credit_notes VALUES(1,'captured')");await db.execute('INSERT INTO supplier_credit_items VALUES(1,1,1,3)');
 await assert.rejects(replacement.linkReplacement(request('replacement-credit-cap')),/credit quantities exceed/);
 await db.execute("UPDATE supplier_credit_notes SET status='posted' WHERE id=1");
 await assert.rejects(replacement.linkReplacement(request('replacement-posted-cap')),/credit quantities exceed/);
 await db.execute("UPDATE supplier_credit_notes SET status='void' WHERE id=1");
 await db.execute('INSERT INTO supplier_invoice_receipt_allocations VALUES(2,2)');
 await assert.rejects(replacement.linkReplacement(request('replacement-billed-cap')),/uninvoiced and unreserved/);
 await db.execute('DELETE FROM supplier_invoice_receipt_allocations');
 await db.execute("INSERT INTO captured_supplier_invoices VALUES(1,'captured')");await db.execute('INSERT INTO captured_supplier_invoice_receipts VALUES(1,2,2)');
 await assert.rejects(replacement.linkReplacement(request('replacement-capture-cap')),/uninvoiced and unreserved/);
 await db.execute("UPDATE captured_supplier_invoices SET status='void' WHERE id=1");
 await replacement.linkReplacement(request('replacement-second',{quantity:2}));
 await assert.rejects(replacement.linkReplacement(request('replacement-receipt-cap')),/uninvoiced and unreserved/);
 assert.equal((await replacement.listReplacements(db,1)).length,2);
 assert.equal(Number((await db.execute('SELECT COUNT(*) n FROM journal_entries')).rows[0].n),2);
 assert.equal(Number((await db.execute('SELECT COUNT(*) n FROM stock_movements')).rows[0].n),2);
 assert.equal(Number((await db.execute('SELECT total FROM supplier_invoices')).rows[0].total),100);
 // A penny split across three replacement lines must clear exactly once.
 await db.execute("INSERT INTO supplier_returns VALUES(2,1,1,1,'dispatched')");
 await db.execute('INSERT INTO supplier_return_items VALUES(2,2,10,3,0.01,1)');
 await db.execute("INSERT INTO purchase_receipt_items VALUES(4,2,10,'Penny widget',3,0.003333333333,0.01)");
 for(let i=0;i<3;i++){const req=request('replacement-penny-'+i,{return_item_id:2,replacement_receipt_item_id:4,quantity:1,variance_reason:''});req.params.id=2;await replacement.linkReplacement(req);}
 const penny=(await db.execute('SELECT SUM(original_value) original,SUM(replacement_value) replacement FROM supplier_return_replacements WHERE return_item_id=2')).rows[0];
 assert.equal(Number(penny.original),0.01);assert.equal(Number(penny.replacement),0.01);
 await assert.rejects(db.execute('UPDATE supplier_return_replacements SET quantity=99'),/immutable/);
 await assert.rejects(db.execute('DELETE FROM supplier_return_replacements'),/audit history/);
 await db.close();fs.rmSync(directory,{recursive:true,force:true});
});
