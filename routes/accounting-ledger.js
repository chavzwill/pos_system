const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requireAnyPermission, requirePermission } = require('../lib/permissions');

// General report users may inspect the ledger, but only financial-report
// authority may create accounts, draft journals, post journals or reverse them.
router.use((req,res,next)=>{
  if(req.method==='GET') return requireAnyPermission('reports_financial','reports')(req,res,next);
  return requirePermission('reports_financial')(req,res,next);
});

let ready=false;
async function ensureSchema(){
  if(ready) return;
  await db.batch([
    {sql:`CREATE TABLE IF NOT EXISTS ledger_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      account_type TEXT NOT NULL,
      normal_balance TEXT NOT NULL,
      parent_id INTEGER,
      active INTEGER NOT NULL DEFAULT 1,
      system_account INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`},
    {sql:`CREATE TABLE IF NOT EXISTS journal_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      journal_number TEXT NOT NULL UNIQUE,
      entry_date TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      branch_id INTEGER,
      source_type TEXT,
      source_id TEXT,
      source_reference TEXT,
      created_by_employee_id INTEGER,
      posted_by_employee_id INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      posted_at TEXT,
      reversal_of_id INTEGER
    )`},
    {sql:`CREATE TABLE IF NOT EXISTS journal_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      journal_entry_id INTEGER NOT NULL,
      ledger_account_id INTEGER NOT NULL,
      description TEXT,
      debit REAL NOT NULL DEFAULT 0,
      credit REAL NOT NULL DEFAULT 0,
      branch_id INTEGER,
      source_type TEXT,
      source_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`},
    {sql:`CREATE TABLE IF NOT EXISTS journal_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      journal_entry_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      details TEXT,
      actor_employee_id INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`},
    {sql:'CREATE INDEX IF NOT EXISTS idx_journal_entries_date ON journal_entries(entry_date,status)'},
    {sql:'CREATE INDEX IF NOT EXISTS idx_journal_lines_account ON journal_lines(ledger_account_id,journal_entry_id)'},
    {sql:'CREATE INDEX IF NOT EXISTS idx_journal_source ON journal_entries(source_type,source_id)'}
  ],'write');

  const defaults=[
    ['1000','Cash','asset','debit'],['1010','Bank','asset','debit'],['1100','Accounts Receivable','asset','debit'],['1200','Inventory','asset','debit'],
    ['2000','Accounts Payable','liability','credit'],['2100','Taxes Payable','liability','credit'],
    ['3000','Owner Equity','equity','credit'],
    ['4000','Sales Revenue','revenue','credit'],['4100','Service Revenue','revenue','credit'],['4200','Rental Revenue','revenue','credit'],
    ['5000','Cost of Goods Sold','expense','debit'],['5100','Technician Labour','expense','debit'],['5200','Logistics Expense','expense','debit'],['5300','Bank & Processor Fees','expense','debit']
  ];
  for(const a of defaults){
    await db.execute({sql:`INSERT OR IGNORE INTO ledger_accounts(code,name,account_type,normal_balance,system_account) VALUES(?,?,?,?,1)`,args:a});
  }
  ready=true;
}
router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Accounting ledger schema initialization failed',detail:e.message});}});

function num(v){const n=Number(v);return Number.isFinite(n)?Number(n.toFixed(2)):0;}
function actor(req){return req.employee?.id||req.user?.employee_id||null;}
async function nextJournalNumber(){
  const {rows:[row]}=await db.execute({sql:`SELECT journal_number FROM journal_entries WHERE journal_number LIKE 'JE-%' ORDER BY id DESC LIMIT 1`,args:[]});
  const n=row?.journal_number?Number(String(row.journal_number).replace(/\D/g,''))+1:1;
  return 'JE-'+String(n).padStart(7,'0');
}
async function totals(id){
  const {rows:[r]}=await db.execute({sql:`SELECT COALESCE(SUM(debit),0) debit,COALESCE(SUM(credit),0) credit FROM journal_lines WHERE journal_entry_id=?`,args:[id]});
  return {debit:num(r?.debit),credit:num(r?.credit),difference:num(num(r?.debit)-num(r?.credit))};
}

router.get('/accounts',async(req,res)=>{
  try{const {rows}=await db.execute({sql:`SELECT * FROM ledger_accounts WHERE active=1 ORDER BY code`,args:[]});res.json(rows);}catch(e){res.status(500).json({error:e.message});}
});

router.post('/accounts',async(req,res)=>{
  try{
    const b=req.body||{};
    if(!b.code||!b.name) return res.status(400).json({error:'code and name are required'});
    if(!['asset','liability','equity','revenue','expense'].includes(b.account_type)) return res.status(400).json({error:'Invalid account_type'});
    const normal=b.normal_balance||(['asset','expense'].includes(b.account_type)?'debit':'credit');
    const r=await db.execute({sql:`INSERT INTO ledger_accounts(code,name,account_type,normal_balance,parent_id) VALUES(?,?,?,?,?)`,args:[String(b.code).trim(),String(b.name).trim(),b.account_type,normal,b.parent_id||null]});
    const {rows:[row]}=await db.execute({sql:'SELECT * FROM ledger_accounts WHERE id=?',args:[Number(r.lastInsertRowid)]});
    res.status(201).json(row);
  }catch(e){res.status(400).json({error:e.message});}
});

router.get('/journals',async(req,res)=>{
  try{
    const {start,end,status,branch_id,limit=150}=req.query;const args=[];let where='1=1';
    if(start){where+=' AND date(je.entry_date)>=date(?)';args.push(start);}if(end){where+=' AND date(je.entry_date)<=date(?)';args.push(end);}if(status){where+=' AND je.status=?';args.push(status);}if(branch_id){where+=' AND je.branch_id=?';args.push(branch_id);}
    args.push(Math.min(Math.max(Number(limit)||150,1),500));
    const {rows}=await db.execute({sql:`SELECT je.*,b.name branch_name,e.first_name||' '||e.last_name created_by_name,
      COALESCE((SELECT SUM(debit) FROM journal_lines jl WHERE jl.journal_entry_id=je.id),0) total_debit,
      COALESCE((SELECT SUM(credit) FROM journal_lines jl WHERE jl.journal_entry_id=je.id),0) total_credit
      FROM journal_entries je LEFT JOIN branches b ON b.id=je.branch_id LEFT JOIN employees e ON e.id=je.created_by_employee_id
      WHERE ${where} ORDER BY je.entry_date DESC,je.id DESC LIMIT ?`,args});
    res.json(rows);
  }catch(e){res.status(500).json({error:e.message});}
});

router.get('/journals/:id',async(req,res)=>{
  try{
    const {rows:[entry]}=await db.execute({sql:'SELECT * FROM journal_entries WHERE id=?',args:[req.params.id]});if(!entry)return res.status(404).json({error:'Journal not found'});
    const {rows:lines}=await db.execute({sql:`SELECT jl.*,la.code account_code,la.name account_name FROM journal_lines jl JOIN ledger_accounts la ON la.id=jl.ledger_account_id WHERE jl.journal_entry_id=? ORDER BY jl.id`,args:[req.params.id]});
    const {rows:events}=await db.execute({sql:`SELECT jev.*,e.first_name||' '||e.last_name actor_name FROM journal_events jev LEFT JOIN employees e ON e.id=jev.actor_employee_id WHERE jev.journal_entry_id=? ORDER BY jev.created_at DESC,jev.id DESC`,args:[req.params.id]});
    res.json({entry,lines,events,totals:await totals(req.params.id)});
  }catch(e){res.status(500).json({error:e.message});}
});

router.post('/journals',async(req,res)=>{
  try{
    const b=req.body||{};const lines=Array.isArray(b.lines)?b.lines:[];
    if(!b.entry_date||!b.description||lines.length<2) return res.status(400).json({error:'entry_date, description and at least two journal lines are required'});
    let debit=0,credit=0;
    for(const l of lines){
      const d=num(l.debit),c=num(l.credit);if(!l.ledger_account_id) return res.status(400).json({error:'Every line requires ledger_account_id'});if(d<0||c<0||((d>0)===(c>0))) return res.status(400).json({error:'Each line must contain either a positive debit or positive credit'});debit+=d;credit+=c;
    }
    debit=num(debit);credit=num(credit);if(Math.abs(debit-credit)>0.001) return res.status(409).json({error:'Journal entry is not balanced',debit,credit,difference:num(debit-credit)});
    const tx=await db.transaction('write');let committed=false;
    try{
      const journalNumber=await nextJournalNumber();
      const r=await tx.execute({sql:`INSERT INTO journal_entries(journal_number,entry_date,description,branch_id,source_type,source_id,source_reference,created_by_employee_id) VALUES(?,?,?,?,?,?,?,?)`,args:[journalNumber,b.entry_date,String(b.description).trim(),b.branch_id||null,b.source_type||null,b.source_id==null?null:String(b.source_id),b.source_reference||null,actor(req)]});
      const id=Number(r.lastInsertRowid);
      for(const l of lines) await tx.execute({sql:`INSERT INTO journal_lines(journal_entry_id,ledger_account_id,description,debit,credit,branch_id,source_type,source_id) VALUES(?,?,?,?,?,?,?,?)`,args:[id,l.ledger_account_id,l.description||null,num(l.debit),num(l.credit),l.branch_id||b.branch_id||null,l.source_type||b.source_type||null,l.source_id==null?(b.source_id==null?null:String(b.source_id)):String(l.source_id)]});
      await tx.execute({sql:`INSERT INTO journal_events(journal_entry_id,event_type,details,actor_employee_id) VALUES(?,?,?,?)`,args:[id,'created',`Balanced draft created: debit ${debit.toFixed(2)}, credit ${credit.toFixed(2)}`,actor(req)]});
      await tx.commit();committed=true;
      res.status(201).json({id,journal_number:journalNumber,status:'draft',debit,credit});
    }catch(e){if(!committed)await tx.rollback();throw e;}
  }catch(e){res.status(400).json({error:e.message});}
});

router.post('/journals/:id/post',async(req,res)=>{
  try{
    const {rows:[entry]}=await db.execute({sql:'SELECT * FROM journal_entries WHERE id=?',args:[req.params.id]});if(!entry)return res.status(404).json({error:'Journal not found'});if(entry.status!=='draft')return res.status(409).json({error:'Only draft journals can be posted'});
    const t=await totals(entry.id);if(t.debit<=0||Math.abs(t.difference)>0.001)return res.status(409).json({error:'Journal cannot be posted unless it is balanced and non-zero',totals:t});
    await db.execute({sql:`UPDATE journal_entries SET status='posted',posted_at=CURRENT_TIMESTAMP,posted_by_employee_id=? WHERE id=? AND status='draft'`,args:[actor(req),entry.id]});
    await db.execute({sql:`INSERT INTO journal_events(journal_entry_id,event_type,details,actor_employee_id) VALUES(?,?,?,?)`,args:[entry.id,'posted',`Posted balanced journal ${entry.journal_number}`,actor(req)]});
    res.json({success:true,status:'posted',totals:t});
  }catch(e){res.status(400).json({error:e.message});}
});

router.post('/journals/:id/reverse',async(req,res)=>{
  try{
    const {rows:[entry]}=await db.execute({sql:`SELECT * FROM journal_entries WHERE id=? AND status='posted'`,args:[req.params.id]});if(!entry)return res.status(404).json({error:'Posted journal not found'});
    const {rows:[already]}=await db.execute({sql:'SELECT id FROM journal_entries WHERE reversal_of_id=? LIMIT 1',args:[entry.id]});if(already)return res.status(409).json({error:'Journal already has a reversal'});
    const {rows:lines}=await db.execute({sql:'SELECT * FROM journal_lines WHERE journal_entry_id=? ORDER BY id',args:[entry.id]});
    const tx=await db.transaction('write');let committed=false;
    try{
      const journalNumber=await nextJournalNumber();const date=req.body?.entry_date||new Date().toISOString().slice(0,10);
      const r=await tx.execute({sql:`INSERT INTO journal_entries(journal_number,entry_date,description,status,branch_id,source_type,source_id,source_reference,created_by_employee_id,posted_by_employee_id,posted_at,reversal_of_id) VALUES(?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,?)`,args:[journalNumber,date,`Reversal of ${entry.journal_number}: ${entry.description}`,'posted',entry.branch_id,'journal_reversal',String(entry.id),entry.journal_number,actor(req),actor(req),entry.id]});
      const id=Number(r.lastInsertRowid);for(const l of lines)await tx.execute({sql:`INSERT INTO journal_lines(journal_entry_id,ledger_account_id,description,debit,credit,branch_id,source_type,source_id) VALUES(?,?,?,?,?,?,?,?)`,args:[id,l.ledger_account_id,l.description,l.credit,l.debit,l.branch_id,'journal_reversal',String(entry.id)]});
      await tx.execute({sql:`INSERT INTO journal_events(journal_entry_id,event_type,details,actor_employee_id) VALUES(?,?,?,?)`,args:[id,'posted',`Posted reversal of ${entry.journal_number}`,actor(req)]});
      await tx.execute({sql:`INSERT INTO journal_events(journal_entry_id,event_type,details,actor_employee_id) VALUES(?,?,?,?)`,args:[entry.id,'reversed',`Reversed by ${journalNumber}`,actor(req)]});
      await tx.commit();committed=true;res.status(201).json({id,journal_number:journalNumber,status:'posted',reversal_of_id:entry.id});
    }catch(e){if(!committed)await tx.rollback();throw e;}
  }catch(e){res.status(400).json({error:e.message});}
});

router.get('/trial-balance/report',async(req,res)=>{
  try{
    const end=String(req.query.end||new Date().toISOString().slice(0,10));const branchId=req.query.branch_id?Number(req.query.branch_id):null;const args=[end];let branch='';if(branchId){branch=' AND COALESCE(jl.branch_id,je.branch_id)=?';args.push(branchId);}
    const {rows}=await db.execute({sql:`SELECT la.id,la.code,la.name,la.account_type,la.normal_balance,
      COALESCE(SUM(jl.debit),0) debit,COALESCE(SUM(jl.credit),0) credit,
      COALESCE(SUM(jl.debit-jl.credit),0) debit_balance
      FROM ledger_accounts la LEFT JOIN journal_lines jl ON jl.ledger_account_id=la.id LEFT JOIN journal_entries je ON je.id=jl.journal_entry_id AND je.status='posted' AND date(je.entry_date)<=date(?)
      WHERE la.active=1${branch} GROUP BY la.id ORDER BY la.code`,args});
    const clean=rows.map(r=>({...r,debit:num(r.debit),credit:num(r.credit),balance:r.normal_balance==='credit'?num(r.credit-r.debit):num(r.debit-r.credit)}));
    const totalDebit=num(clean.reduce((s,r)=>s+num(r.debit),0)),totalCredit=num(clean.reduce((s,r)=>s+num(r.credit),0));
    res.json({end,branch_id:branchId,rows:clean,totals:{debit:totalDebit,credit:totalCredit,difference:num(totalDebit-totalCredit)},basis:'Trial balance contains posted journal entries only. Draft operational records do not affect ledger balances until a balanced journal is posted.'});
  }catch(e){res.status(500).json({error:e.message});}
});

router.get('/accounts/:id/ledger',async(req,res)=>{
  try{
    const {start,end,branch_id}=req.query;const args=[req.params.id];let where=`jl.ledger_account_id=? AND je.status='posted'`;if(start){where+=' AND date(je.entry_date)>=date(?)';args.push(start);}if(end){where+=' AND date(je.entry_date)<=date(?)';args.push(end);}if(branch_id){where+=' AND COALESCE(jl.branch_id,je.branch_id)=?';args.push(branch_id);}
    const {rows}=await db.execute({sql:`SELECT je.journal_number,je.entry_date,je.description journal_description,je.source_type journal_source_type,je.source_id journal_source_id,je.source_reference,jl.description,jl.debit,jl.credit,COALESCE(jl.branch_id,je.branch_id) branch_id,b.name branch_name FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_entry_id LEFT JOIN branches b ON b.id=COALESCE(jl.branch_id,je.branch_id) WHERE ${where} ORDER BY je.entry_date,je.id,jl.id`,args});
    res.json(rows);
  }catch(e){res.status(500).json({error:e.message});}
});

module.exports=router;
