const { db } = require('../database');
const { ensureLedger } = require('./accounting-posting');

function money(v){ const n=Number(v); return Number.isFinite(n)?Number(n.toFixed(2)):0; }
async function exists(table){ const {rows:[r]}=await db.execute({sql:"SELECT name FROM sqlite_master WHERE type='table' AND name=?",args:[table]}); return !!r; }

async function reversePostedJournal({journalId,sourceType,sourceId,sourceReference,entryDate,description,branchId,actorId}){
  await ensureLedger();
  const reversalSourceType=`${sourceType}_void_reversal`;
  const reversalSourceId=String(sourceId);
  const {rows:[existing]}=await db.execute({sql:`SELECT id,journal_number,status FROM journal_entries WHERE source_type=? AND source_id=? AND status='posted' LIMIT 1`,args:[reversalSourceType,reversalSourceId]});
  if(existing) return {...existing,existing:true};
  const {rows:lines}=await db.execute({sql:`SELECT jl.*,la.code FROM journal_lines jl JOIN ledger_accounts la ON la.id=jl.ledger_account_id WHERE jl.journal_entry_id=? ORDER BY jl.id`,args:[journalId]});
  if(!lines.length) throw new Error(`Posted journal ${journalId} has no lines to reverse`);
  let debit=0,credit=0;
  for(const l of lines){debit=money(debit+Number(l.credit||0));credit=money(credit+Number(l.debit||0));}
  if(debit<=0||Math.abs(debit-credit)>0.01) throw new Error(`Reversal for journal ${journalId} would not balance`);
  const number=`VOID-${String(sourceType).toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,8)}-${sourceId}`;
  const r=await db.execute({sql:`INSERT INTO journal_entries(journal_number,entry_date,description,status,branch_id,source_type,source_id,source_reference,created_by_employee_id,posted_by_employee_id,posted_at,reversal_of_id) VALUES(?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,?)`,args:[number,entryDate,description,'posted',branchId||null,reversalSourceType,reversalSourceId,sourceReference||null,actorId||null,actorId||null,journalId]});
  const id=Number(r.lastInsertRowid);
  for(const l of lines){
    await db.execute({sql:`INSERT INTO journal_lines(journal_entry_id,ledger_account_id,description,debit,credit,branch_id,source_type,source_id) VALUES(?,?,?,?,?,?,?,?)`,args:[id,l.ledger_account_id,`Void reversal: ${l.description||description}`,money(l.credit),money(l.debit),branchId||null,reversalSourceType,reversalSourceId]});
  }
  await db.execute({sql:`INSERT INTO journal_events(journal_entry_id,event_type,details,actor_employee_id) VALUES(?,?,?,?)`,args:[id,'void_reversal',`Reversed posted journal ${journalId} because source transaction ${sourceReference||sourceId} was voided.`,actorId||null]});
  return {id,journal_number:number,status:'posted',existing:false};
}

async function syncVoidedRetailAccounting({actorId,stats}){
  stats.retail_void_reversals ||= {posted:0,existing:0};
  if(!(await exists('transactions'))||!(await exists('journal_entries'))) return;
  const hasRentals=await exists('rental_agreements');
  const hasWorkOrders=await exists('work_orders');
  const rentalExclusion=hasRentals?`AND NOT EXISTS (SELECT 1 FROM rental_agreements ra WHERE ra.checkout_transaction_id=t.id OR ra.settlement_transaction_id=t.id)`:'';
  const workOrderExclusion=hasWorkOrders?`AND NOT EXISTS (SELECT 1 FROM work_orders wo WHERE wo.assessment_transaction_id=t.id OR wo.deposit_transaction_id=t.id OR wo.final_transaction_id=t.id)`:'';
  const {rows:voided}=await db.execute({sql:`SELECT t.* FROM transactions t WHERE t.status='voided' ${rentalExclusion} ${workOrderExclusion} ORDER BY t.id`,args:[]});
  for(const t of voided){
    try{
      const {rows:journals}=await db.execute({sql:`SELECT id,source_type FROM journal_entries WHERE status='posted' AND source_id=? AND source_type IN ('retail_sale','retail_sale_cogs') ORDER BY id`,args:[String(t.id)]});
      for(const j of journals){
        const r=await reversePostedJournal({journalId:j.id,sourceType:j.source_type,sourceId:t.id,sourceReference:t.transaction_number,entryDate:String(t.voided_at||new Date().toISOString()).slice(0,10),description:`Void reversal ${t.transaction_number}`,branchId:t.branch_id,actorId});
        stats.retail_void_reversals[r.existing?'existing':'posted']++;
      }
      if(!journals.length){
        stats.evidence_gaps.push({transaction_id:t.id,transaction_number:t.transaction_number,type:'voided_retail_transaction_without_posted_source_journal',automatic_posting:false,reason:'The transaction is voided but no prior retail sale/COGS journal exists to reverse. No synthetic reversal is created.'});
      }
    }catch(e){stats.errors.push(`retail_void:${t.id}: ${e.message}`);}
  }
}

module.exports={reversePostedJournal,syncVoidedRetailAccounting};
