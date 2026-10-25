'use strict';
const {db}=require('../database');
const {ensureLedger,postSourceJournal}=require('./accounting-posting');
const {invoiceBalance}=require('./supplier-ap-balances');
const sql=(sql,args=[])=>({sql,args});
let ready;
async function ensureSupplierCreditSchema(){
 if(ready)return ready;
 ready=(async()=>{
 await require('./supplier-ledger-base-schema').ensureSupplierLedgerBase();
 await require('./consumable-corrections').ensureCorrectionTables();
 await ensureLedger();
 await db.batch([
 sql(`CREATE TABLE IF NOT EXISTS supplier_credit_notes(id INTEGER PRIMARY KEY AUTOINCREMENT,return_id INTEGER NOT NULL,supplier_invoice_id INTEGER NOT NULL,supplier_id INTEGER NOT NULL,branch_id INTEGER NOT NULL,credit_number TEXT NOT NULL,credit_date TEXT NOT NULL,reason TEXT NOT NULL,merchandise_cents INTEGER NOT NULL CHECK(merchandise_cents>=0),tax_cents INTEGER NOT NULL CHECK(tax_cents>=0),tax_treatment TEXT,total_cents INTEGER NOT NULL CHECK(total_cents>0),carrying_cents INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'captured' CHECK(status IN ('captured','posted','void')),variance_reason TEXT,captured_by_employee_id INTEGER,posted_by_employee_id INTEGER,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,posted_at TEXT,UNIQUE(supplier_id,credit_number))`),
 sql(`CREATE TABLE IF NOT EXISTS supplier_credit_items(id INTEGER PRIMARY KEY AUTOINCREMENT,credit_note_id INTEGER NOT NULL,return_item_id INTEGER NOT NULL,quantity REAL NOT NULL CHECK(quantity>0),unit_credit_cents INTEGER NOT NULL CHECK(unit_credit_cents>=0),line_cents INTEGER NOT NULL CHECK(line_cents>=0),carrying_cents INTEGER NOT NULL DEFAULT 0,UNIQUE(credit_note_id,return_item_id))`),
 sql(`CREATE TABLE IF NOT EXISTS supplier_credit_posting_items(id INTEGER PRIMARY KEY AUTOINCREMENT,credit_note_id INTEGER NOT NULL,return_item_id INTEGER NOT NULL,quantity REAL NOT NULL,carrying_cents INTEGER NOT NULL,UNIQUE(credit_note_id,return_item_id))`),
 sql(`CREATE TABLE IF NOT EXISTS supplier_credit_applications(id INTEGER PRIMARY KEY AUTOINCREMENT,credit_note_id INTEGER NOT NULL,supplier_invoice_id INTEGER NOT NULL,amount_cents INTEGER NOT NULL CHECK(amount_cents>0),actor_employee_id INTEGER,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`),
 sql(`CREATE TABLE IF NOT EXISTS supplier_credit_refunds(id INTEGER PRIMARY KEY AUTOINCREMENT,credit_note_id INTEGER NOT NULL,amount_cents INTEGER NOT NULL CHECK(amount_cents>0),refund_date TEXT NOT NULL,payment_method TEXT NOT NULL,reference TEXT NOT NULL,reason TEXT NOT NULL,actor_employee_id INTEGER,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`),
 sql(`CREATE TABLE IF NOT EXISTS supplier_credit_events(id INTEGER PRIMARY KEY AUTOINCREMENT,credit_note_id INTEGER NOT NULL,event_type TEXT NOT NULL,details TEXT,actor_employee_id INTEGER,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`),
 sql(`CREATE TABLE IF NOT EXISTS supplier_credit_operations(operation_key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result_json TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`),
 sql(`INSERT OR IGNORE INTO ledger_accounts(code,name,account_type,normal_balance,system_account) VALUES('1270','Supplier Return Clearing','asset','debit',1)`),
 sql(`INSERT OR IGNORE INTO ledger_accounts(code,name,account_type,normal_balance,system_account) VALUES('5280','Supplier Return Variance','expense','debit',1)`),
 ...['supplier_credit_items','supplier_credit_posting_items','supplier_credit_applications','supplier_credit_refunds','supplier_credit_events','supplier_credit_operations'].flatMap(table=>['UPDATE','DELETE'].map(op=>sql(`CREATE TRIGGER IF NOT EXISTS ${table}_no_${op.toLowerCase()} BEFORE ${op} ON ${table} BEGIN SELECT RAISE(ABORT,'Supplier credit evidence is immutable'); END`))),
 sql(`CREATE TRIGGER IF NOT EXISTS supplier_credit_notes_immutable BEFORE UPDATE ON supplier_credit_notes WHEN OLD.status!='captured' OR NEW.return_id!=OLD.return_id OR NEW.supplier_invoice_id!=OLD.supplier_invoice_id OR NEW.supplier_id!=OLD.supplier_id OR NEW.branch_id!=OLD.branch_id OR NEW.credit_number!=OLD.credit_number OR NEW.credit_date!=OLD.credit_date OR NEW.reason!=OLD.reason OR NEW.merchandise_cents!=OLD.merchandise_cents OR NEW.tax_cents!=OLD.tax_cents OR NEW.total_cents!=OLD.total_cents OR (NEW.carrying_cents!=OLD.carrying_cents AND NEW.status!='posted') OR COALESCE(NEW.tax_treatment,'')!=COALESCE(OLD.tax_treatment,'') BEGIN SELECT RAISE(ABORT,'Supplier credit document is immutable'); END`),
 sql(`CREATE TRIGGER IF NOT EXISTS supplier_credit_notes_no_delete BEFORE DELETE ON supplier_credit_notes BEGIN SELECT RAISE(ABORT,'Supplier credit documents cannot be deleted'); END`)
 ],'write');
 })().catch(e=>{ready=null;throw e});return ready;
}
async function getCredit(executor,id){const {rows:[r]}=await executor.execute(sql(`SELECT c.*,COALESCE((SELECT SUM(amount_cents) FROM supplier_credit_applications WHERE credit_note_id=c.id),0) applied_cents,COALESCE((SELECT SUM(amount_cents) FROM supplier_credit_refunds WHERE credit_note_id=c.id),0) refunded_cents FROM supplier_credit_notes c WHERE c.id=?`,[id]));return r?{...r,available_cents:r.status==='posted'?Number(r.total_cents)-Number(r.applied_cents)-Number(r.refunded_cents):0}:null;}
async function event(executor,id,type,details,actor){await executor.execute(sql('INSERT INTO supplier_credit_events(credit_note_id,event_type,details,actor_employee_id) VALUES(?,?,?,?)',[id,type,JSON.stringify(details),actor||null]));}
async function applyCredit(executor,creditId,invoiceId,cents,actor){
 const c=await getCredit(executor,creditId),i=await invoiceBalance(executor,invoiceId);
 if(!c||c.status!=='posted'||!i||i.status!=='posted'||Number(c.supplier_id)!==Number(i.supplier_id)||Number(c.branch_id)!==Number(i.branch_id))throw new Error('Credit application requires a posted invoice for the same supplier and branch');
 if(!Number.isSafeInteger(cents)||cents<=0||cents>c.available_cents||cents>i.balance_cents)throw new Error('Credit application exceeds available credit or invoice balance');
 await executor.execute(sql('INSERT INTO supplier_credit_applications(credit_note_id,supplier_invoice_id,amount_cents,actor_employee_id) VALUES(?,?,?,?)',[creditId,invoiceId,cents,actor||null]));await event(executor,creditId,'applied',{invoice_id:invoiceId,amount_cents:cents},actor);
}
async function postSupplierCreditJournal(executor,creditOrId,actorId){
 const c=typeof creditOrId==='object'?creditOrId:await getCredit(executor,creditOrId);
 if(!c||c.status!=='posted')throw new Error('Only posted supplier credits can enter the ledger');
 if(Number(c.total_cents)!==Number(c.merchandise_cents)+Number(c.tax_cents)||Number(c.total_cents)<=0||Number(c.carrying_cents)<0)throw new Error('Supplier credit component evidence is invalid');
 if(Number(c.tax_cents)>0&&!['recoverable','expense'].includes(c.tax_treatment))throw new Error('Supplier credit tax reversal requires original tax classification');
 const variance=Number(c.merchandise_cents)-Number(c.carrying_cents);
 if(variance&&!String(c.variance_reason||'').trim())throw new Error('Finance variance reason is required');
 const lines=[{code:'2000',debit:c.total_cents/100,credit:0}];
 if(c.carrying_cents)lines.push({code:'1270',debit:0,credit:c.carrying_cents/100});
 if(c.tax_cents)lines.push({code:c.tax_treatment==='recoverable'?'1400':'5450',debit:0,credit:c.tax_cents/100});
 if(variance)lines.push({code:'5280',debit:variance<0?-variance/100:0,credit:variance>0?variance/100:0});
 return postSourceJournal({executor,sourceType:'supplier_credit_note',sourceId:c.id,sourceReference:c.credit_number,entryDate:c.credit_date,description:`Supplier credit ${c.credit_number}`,branchId:c.branch_id,actorId,lines});
}
async function postSupplierRefundJournal(executor,refundOrId,actorId){
 const r=typeof refundOrId==='object'?refundOrId:(await executor.execute(sql('SELECT * FROM supplier_credit_refunds WHERE id=?',[refundOrId]))).rows[0];
 const c=await getCredit(executor,r.credit_note_id);
 return postSourceJournal({executor,sourceType:'supplier_credit_refund',sourceId:r.id,sourceReference:r.reference,entryDate:r.refund_date,description:`Supplier credit refund ${c.credit_number}`,branchId:c.branch_id,actorId,lines:[{code:r.payment_method==='cash'?'1000':'1010',debit:r.amount_cents/100,credit:0},{code:'2000',debit:0,credit:r.amount_cents/100}]});
}
module.exports={ensureSupplierCreditSchema,getCredit,applyCredit,event,postSupplierCreditJournal,postSupplierRefundJournal};
