const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requireAnyPermission } = require('../lib/permissions');

router.use(requireAnyPermission('reports_financial','drawers_manage','reports'));

let ready = false;
async function ensureSchema(){
  if(ready) return;
  await db.batch([
    {sql:`CREATE TABLE IF NOT EXISTS settlement_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER,
      name TEXT NOT NULL,
      account_type TEXT NOT NULL DEFAULT 'bank',
      provider TEXT,
      last_four TEXT,
      currency TEXT NOT NULL DEFAULT 'JMD',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`},
    {sql:`CREATE TABLE IF NOT EXISTS settlement_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      settlement_account_id INTEGER NOT NULL,
      branch_id INTEGER,
      settlement_date TEXT NOT NULL,
      reference TEXT,
      gross_amount REAL NOT NULL DEFAULT 0,
      fees REAL NOT NULL DEFAULT 0,
      net_amount REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open',
      notes TEXT,
      created_by_employee_id INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reconciled_at TEXT,
      UNIQUE(settlement_account_id, reference)
    )`},
    {sql:`CREATE TABLE IF NOT EXISTS settlement_matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      settlement_batch_id INTEGER NOT NULL,
      source_type TEXT NOT NULL,
      source_id INTEGER NOT NULL,
      source_amount REAL NOT NULL,
      matched_amount REAL NOT NULL,
      created_by_employee_id INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(settlement_batch_id, source_type, source_id)
    )`},
    {sql:`CREATE TABLE IF NOT EXISTS settlement_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      settlement_batch_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      details TEXT,
      actor_employee_id INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`},
    {sql:'CREATE INDEX IF NOT EXISTS idx_settlement_batches_date ON settlement_batches(settlement_date,status)'},
    {sql:'CREATE INDEX IF NOT EXISTS idx_settlement_matches_batch ON settlement_matches(settlement_batch_id)'}
  ],'write');
  ready=true;
}
router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Settlement schema initialization failed',detail:e.message});}});

function num(v){const n=Number(v);return Number.isFinite(n)?n:0;}
function actor(req){return req.employee?.id || req.user?.employee_id || null;}

router.get('/accounts', async(req,res)=>{
  try{
    const {rows}=await db.execute({sql:`SELECT sa.*,b.name branch_name FROM settlement_accounts sa LEFT JOIN branches b ON b.id=sa.branch_id WHERE sa.active=1 ORDER BY b.name,sa.name`,args:[]});
    res.json(rows);
  }catch(e){res.status(500).json({error:e.message});}
});

router.post('/accounts', async(req,res)=>{
  try{
    const b=req.body||{};
    if(!b.name||!String(b.name).trim()) return res.status(400).json({error:'Account name is required'});
    if(!['bank','card_processor','mobile_money','other'].includes(b.account_type||'bank')) return res.status(400).json({error:'Invalid account type'});
    const r=await db.execute({sql:`INSERT INTO settlement_accounts(branch_id,name,account_type,provider,last_four,currency) VALUES(?,?,?,?,?,?)`,args:[b.branch_id||null,String(b.name).trim(),b.account_type||'bank',b.provider||null,b.last_four||null,b.currency||'JMD']});
    const {rows:[row]}=await db.execute({sql:'SELECT * FROM settlement_accounts WHERE id=?',args:[Number(r.lastInsertRowid)]});
    res.status(201).json(row);
  }catch(e){res.status(400).json({error:e.message});}
});

router.get('/command-center', async(req,res)=>{
  try{
    const start=String(req.query.start||new Date(Date.now()-29*86400000).toISOString().slice(0,10));
    const end=String(req.query.end||new Date().toISOString().slice(0,10));
    const branchId=req.query.branch_id?Number(req.query.branch_id):null;
    const args=[start,end]; let branch=''; if(branchId){branch=' AND sb.branch_id=?';args.push(branchId);}
    const {rows:batches}=await db.execute({sql:`SELECT sb.*,sa.name account_name,sa.account_type,sa.provider,b.name branch_name,
      COALESCE((SELECT SUM(sm.matched_amount) FROM settlement_matches sm WHERE sm.settlement_batch_id=sb.id),0) matched_amount
      FROM settlement_batches sb JOIN settlement_accounts sa ON sa.id=sb.settlement_account_id LEFT JOIN branches b ON b.id=sb.branch_id
      WHERE date(sb.settlement_date) BETWEEN date(?) AND date(?)${branch}
      ORDER BY sb.settlement_date DESC,sb.id DESC`,args});
    const summary={batches:batches.length,open:batches.filter(x=>x.status==='open').length,reconciled:batches.filter(x=>x.status==='reconciled').length,gross:batches.reduce((s,x)=>s+num(x.gross_amount),0),fees:batches.reduce((s,x)=>s+num(x.fees),0),net:batches.reduce((s,x)=>s+num(x.net_amount),0),matched:batches.reduce((s,x)=>s+num(x.matched_amount),0)};
    summary.unmatched=Number((summary.net-summary.matched).toFixed(2));

    const txArgs=[start,end]; let txBranch=''; if(branchId){txBranch=' AND t.branch_id=?';txArgs.push(branchId);}
    const {rows:source}=await db.execute({sql:`SELECT t.id,t.transaction_number,t.created_at,t.branch_id,b.name branch_name,
      COALESCE(SUM(CASE WHEN LOWER(tp.payment_method) IN ('card','credit_card','debit_card','direct_deposit','bank_transfer') THEN tp.amount ELSE 0 END),0) electronic_amount
      FROM transactions t LEFT JOIN transaction_payments tp ON tp.transaction_id=t.id LEFT JOIN branches b ON b.id=t.branch_id
      WHERE t.status='completed' AND date(t.created_at) BETWEEN date(?) AND date(?)${txBranch}
      GROUP BY t.id HAVING electronic_amount>0.001 ORDER BY t.created_at DESC LIMIT 250`,args:txArgs});
    const unmatchedSources=[];
    for(const row of source){
      const {rows:[m]}=await db.execute({sql:`SELECT COALESCE(SUM(matched_amount),0) matched FROM settlement_matches WHERE source_type='transaction' AND source_id=?`,args:[row.id]});
      const remaining=num(row.electronic_amount)-num(m?.matched);
      if(remaining>0.001) unmatchedSources.push({...row,matched_amount:num(m?.matched),remaining_amount:Number(remaining.toFixed(2))});
    }

    const drawerArgs=[start,end]; let drawerBranch=''; if(branchId){drawerBranch=' AND ds.branch_id=?';drawerArgs.push(branchId);}
    const {rows:drawerRows}=await db.execute({sql:`SELECT ds.id,ds.opened_at,ds.closed_at,ds.branch_id,d.name drawer_name,b.name branch_name,e.first_name||' '||e.last_name employee_name,
      dr.cash_counted,dr.card_counted,dr.check_counted,dr.direct_deposit_counted,dr.reconciled_at
      FROM drawer_sessions ds LEFT JOIN cash_drawers d ON d.id=ds.drawer_id LEFT JOIN branches b ON b.id=ds.branch_id LEFT JOIN employees e ON e.id=ds.employee_id
      LEFT JOIN drawer_reconciliations dr ON dr.session_id=ds.id
      WHERE date(ds.opened_at) BETWEEN date(?) AND date(?)${drawerBranch} AND ds.status='reconciled' ORDER BY ds.opened_at DESC LIMIT 150`,args:drawerArgs});

    res.json({period:{start,end,branch_id:branchId},summary,batches,unmatched_sources:unmatchedSources,reconciled_drawers:drawerRows,basis:'Settlement reconciliation compares externally recorded settlement batches against POS transaction/payment evidence. A batch is not bank-cleared until reconciled here.'});
  }catch(e){res.status(500).json({error:e.message});}
});

router.post('/batches', async(req,res)=>{
  try{
    const b=req.body||{}; const gross=num(b.gross_amount),fees=num(b.fees); const net=b.net_amount==null?Number((gross-fees).toFixed(2)):num(b.net_amount);
    if(!b.settlement_account_id||!b.settlement_date) return res.status(400).json({error:'settlement_account_id and settlement_date are required'});
    if(gross<0||fees<0||net<0) return res.status(400).json({error:'Amounts cannot be negative'});
    const r=await db.execute({sql:`INSERT INTO settlement_batches(settlement_account_id,branch_id,settlement_date,reference,gross_amount,fees,net_amount,notes,created_by_employee_id) VALUES(?,?,?,?,?,?,?,?,?)`,args:[b.settlement_account_id,b.branch_id||null,b.settlement_date,b.reference||null,gross,fees,net,b.notes||null,actor(req)]});
    const id=Number(r.lastInsertRowid);
    await db.execute({sql:`INSERT INTO settlement_events(settlement_batch_id,event_type,details,actor_employee_id) VALUES(?,?,?,?)`,args:[id,'created','Settlement batch created',actor(req)]});
    const {rows:[row]}=await db.execute({sql:'SELECT * FROM settlement_batches WHERE id=?',args:[id]}); res.status(201).json(row);
  }catch(e){res.status(400).json({error:e.message});}
});

router.post('/batches/:id/matches', async(req,res)=>{
  try{
    const b=req.body||{}; if(b.source_type!=='transaction') return res.status(400).json({error:'Only transaction settlement matching is supported in this phase'});
    const {rows:[batch]}=await db.execute({sql:'SELECT * FROM settlement_batches WHERE id=?',args:[req.params.id]}); if(!batch) return res.status(404).json({error:'Settlement batch not found'}); if(batch.status==='reconciled') return res.status(409).json({error:'Reconciled batches are locked'});
    const {rows:[tx]}=await db.execute({sql:`SELECT t.id,COALESCE(SUM(CASE WHEN LOWER(tp.payment_method) IN ('card','credit_card','debit_card','direct_deposit','bank_transfer') THEN tp.amount ELSE 0 END),0) amount FROM transactions t LEFT JOIN transaction_payments tp ON tp.transaction_id=t.id WHERE t.id=? AND t.status='completed' GROUP BY t.id`,args:[b.source_id]}); if(!tx) return res.status(404).json({error:'Eligible transaction not found'});
    const {rows:[sourceMatched]}=await db.execute({sql:`SELECT COALESCE(SUM(matched_amount),0) matched FROM settlement_matches WHERE source_type='transaction' AND source_id=?`,args:[tx.id]});
    const remainingSource=num(tx.amount)-num(sourceMatched?.matched);
    const {rows:[batchMatched]}=await db.execute({sql:`SELECT COALESCE(SUM(matched_amount),0) matched FROM settlement_matches WHERE settlement_batch_id=?`,args:[batch.id]});
    const remainingBatch=num(batch.net_amount)-num(batchMatched?.matched);
    const requested=b.matched_amount==null?Math.min(remainingSource,remainingBatch):num(b.matched_amount);
    if(requested<=0||requested>remainingSource+0.001||requested>remainingBatch+0.001) return res.status(409).json({error:'Match exceeds available transaction or settlement balance'});
    await db.execute({sql:`INSERT INTO settlement_matches(settlement_batch_id,source_type,source_id,source_amount,matched_amount,created_by_employee_id) VALUES(?,?,?,?,?,?)`,args:[batch.id,'transaction',tx.id,num(tx.amount),requested,actor(req)]});
    await db.execute({sql:`INSERT INTO settlement_events(settlement_batch_id,event_type,details,actor_employee_id) VALUES(?,?,?,?)`,args:[batch.id,'matched',`Matched transaction ${tx.id} for ${requested.toFixed(2)}`,actor(req)]});
    res.status(201).json({success:true,matched_amount:requested});
  }catch(e){res.status(400).json({error:e.message});}
});

router.post('/batches/:id/reconcile', async(req,res)=>{
  try{
    const {rows:[batch]}=await db.execute({sql:'SELECT * FROM settlement_batches WHERE id=?',args:[req.params.id]}); if(!batch) return res.status(404).json({error:'Settlement batch not found'});
    const {rows:[m]}=await db.execute({sql:'SELECT COALESCE(SUM(matched_amount),0) matched FROM settlement_matches WHERE settlement_batch_id=?',args:[batch.id]});
    const variance=Number((num(batch.net_amount)-num(m?.matched)).toFixed(2));
    const tolerance=Math.abs(num(req.body?.tolerance||0.01));
    if(Math.abs(variance)>tolerance) return res.status(409).json({error:`Batch variance ${variance.toFixed(2)} exceeds tolerance ${tolerance.toFixed(2)}`,variance});
    await db.execute({sql:"UPDATE settlement_batches SET status='reconciled',reconciled_at=CURRENT_TIMESTAMP WHERE id=?",args:[batch.id]});
    await db.execute({sql:`INSERT INTO settlement_events(settlement_batch_id,event_type,details,actor_employee_id) VALUES(?,?,?,?)`,args:[batch.id,'reconciled',`Reconciled with variance ${variance.toFixed(2)}`,actor(req)]});
    res.json({success:true,variance});
  }catch(e){res.status(400).json({error:e.message});}
});

router.get('/batches/:id/events', async(req,res)=>{
  try{const {rows}=await db.execute({sql:`SELECT se.*,e.first_name||' '||e.last_name actor_name FROM settlement_events se LEFT JOIN employees e ON e.id=se.actor_employee_id WHERE se.settlement_batch_id=? ORDER BY se.created_at DESC,se.id DESC`,args:[req.params.id]});res.json(rows);}catch(e){res.status(500).json({error:e.message});}
});

module.exports=router;
