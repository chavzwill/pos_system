const { db } = require('../database');

let ready=false;
async function ensureLedger(){
  if(ready)return;
  await db.batch([
    {sql:`CREATE TABLE IF NOT EXISTS ledger_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT,code TEXT NOT NULL UNIQUE,name TEXT NOT NULL,account_type TEXT NOT NULL,normal_balance TEXT NOT NULL,parent_id INTEGER,active INTEGER NOT NULL DEFAULT 1,system_account INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`},
    {sql:`CREATE TABLE IF NOT EXISTS journal_entries (id INTEGER PRIMARY KEY AUTOINCREMENT,journal_number TEXT NOT NULL UNIQUE,entry_date TEXT NOT NULL,description TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'draft',branch_id INTEGER,source_type TEXT,source_id TEXT,source_reference TEXT,created_by_employee_id INTEGER,posted_by_employee_id INTEGER,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,posted_at TEXT,reversal_of_id INTEGER)`},
    {sql:`CREATE TABLE IF NOT EXISTS journal_lines (id INTEGER PRIMARY KEY AUTOINCREMENT,journal_entry_id INTEGER NOT NULL,ledger_account_id INTEGER NOT NULL,description TEXT,debit REAL NOT NULL DEFAULT 0,credit REAL NOT NULL DEFAULT 0,branch_id INTEGER,source_type TEXT,source_id TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`},
    {sql:`CREATE TABLE IF NOT EXISTS journal_events (id INTEGER PRIMARY KEY AUTOINCREMENT,journal_entry_id INTEGER NOT NULL,event_type TEXT NOT NULL,details TEXT,actor_employee_id INTEGER,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`}
  ],'write');
  const defaults=[['1000','Cash','asset','debit'],['1010','Bank','asset','debit'],['1100','Accounts Receivable','asset','debit'],['1200','Inventory','asset','debit'],['2000','Accounts Payable','liability','credit'],['2100','Taxes Payable','liability','credit'],['3000','Owner Equity','equity','credit'],['4000','Sales Revenue','revenue','credit'],['4100','Service Revenue','revenue','credit'],['4200','Rental Revenue','revenue','credit'],['5000','Cost of Goods Sold','expense','debit'],['5100','Technician Labour','expense','debit'],['5200','Logistics Expense','expense','debit'],['5300','Bank & Processor Fees','expense','debit']];
  for(const a of defaults)await db.execute({sql:`INSERT OR IGNORE INTO ledger_accounts(code,name,account_type,normal_balance,system_account) VALUES(?,?,?,?,1)`,args:a});
  ready=true;
}
function n(v){const x=Number(v);return Number.isFinite(x)?Number(x.toFixed(2)):0;}
async function accountId(code,executor=db){const {rows:[r]}=await executor.execute({sql:'SELECT id FROM ledger_accounts WHERE code=? AND active=1',args:[code]});if(!r)throw new Error(`Ledger account ${code} not configured`);return r.id;}
async function postSourceJournal({sourceType,sourceId,sourceReference,entryDate,description,branchId,actorId,lines,executor=db}){
  await ensureLedger();
  const {rows:[existing]}=await executor.execute({sql:`SELECT id,journal_number,status FROM journal_entries WHERE source_type=? AND source_id=? AND status='posted' LIMIT 1`,args:[sourceType,String(sourceId)]});
  if(existing)return {id:existing.id,journal_number:existing.journal_number,status:existing.status,existing:true};
  let debit=0,credit=0;const resolved=[];
  for(const line of lines){const d=n(line.debit),c=n(line.credit);if((d>0)===(c>0))throw new Error('Automatic journal line must have exactly one positive side');debit=n(debit+d);credit=n(credit+c);resolved.push({...line,debit:d,credit:c,ledger_account_id:await accountId(line.code,executor)});}
  if(debit<=0||Math.abs(n(debit-credit))>0.001)throw new Error('Automatic journal is not balanced');
  const journalNumber=`AUTO-${String(sourceType).toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,8)}-${sourceId}`;
  const r=await executor.execute({sql:`INSERT INTO journal_entries(journal_number,entry_date,description,status,branch_id,source_type,source_id,source_reference,created_by_employee_id,posted_by_employee_id,posted_at) VALUES(?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,args:[journalNumber,entryDate,description,'posted',branchId||null,sourceType,String(sourceId),sourceReference||null,actorId||null,actorId||null]});
  const id=Number(r.lastInsertRowid);
  for(const l of resolved)await executor.execute({sql:`INSERT INTO journal_lines(journal_entry_id,ledger_account_id,description,debit,credit,branch_id,source_type,source_id) VALUES(?,?,?,?,?,?,?,?)`,args:[id,l.ledger_account_id,l.description||description,l.debit,l.credit,branchId||null,sourceType,String(sourceId)]});
  await executor.execute({sql:`INSERT INTO journal_events(journal_entry_id,event_type,details,actor_employee_id) VALUES(?,?,?,?)`,args:[id,'auto_posted',`Automatically posted from verified ${sourceType} source. Debit ${debit.toFixed(2)}, credit ${credit.toFixed(2)}`,actorId||null]});
  return {id,journal_number:journalNumber,status:'posted',existing:false};
}
module.exports={ensureLedger,postSourceJournal};
