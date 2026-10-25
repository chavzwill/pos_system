'use strict';
const {db}=require('../database');
const returns=require('./supplier-returns'),credits=require('./supplier-credit-notes'),replacements=require('./supplier-return-replacements');
async function syncSupplierCorrections({actorId,stats}){
 // Initialize schemas and chart accounts before any posting transaction.
 await returns.ensureSupplierReturnSchema();
 await credits.ensureSupplierCreditSchema();
 await replacements.ensureSupplierReturnReplacementSchema();
 const sources=[
  ['supplier_returns',"status='dispatched'",'supplier_returns',async row=>{row.items=(await db.execute({sql:'SELECT * FROM supplier_return_items WHERE return_id=? ORDER BY id',args:[row.id]})).rows;return returns.postReturnJournal(db,row,actorId);} ],
  ['supplier_credit_notes',"status='posted'",'supplier_credits',row=>credits.postSupplierCreditJournal(db,row,actorId)],
  ['supplier_credit_refunds','1=1','supplier_credit_refunds',row=>credits.postSupplierRefundJournal(db,row,actorId)],
  ['supplier_return_replacements','1=1','supplier_replacements',row=>replacements.postReplacementJournal(db,row,actorId)]
 ];
 for(const [table,where,key,post] of sources){
  stats[key]||={posted:0,existing:0};
  const {rows}=await db.execute({sql:`SELECT * FROM ${table} WHERE ${where} ORDER BY id`,args:[]});
  for(const row of rows)try{const journal=await post(row);if(journal)stats[key][journal.existing?'existing':'posted']++;}catch(error){stats.errors.push(`${key}:${row.id}: ${error.message}`);}
 }
 const {rows}=await db.execute({sql:`SELECT r.id return_id,r.return_number,r.po_id,r.branch_id,
  COALESCE((SELECT SUM(i.carrying_cents) FROM supplier_return_items i WHERE i.return_id=r.id),0) dispatched_cents,
  COALESCE((SELECT SUM(c.carrying_cents) FROM supplier_credit_notes c WHERE c.return_id=r.id AND c.status='posted'),0) credited_cents,
  COALESCE((SELECT SUM(ROUND(x.original_value*100)) FROM supplier_return_replacements x WHERE x.return_id=r.id),0) replaced_cents
  FROM supplier_returns r WHERE r.status='dispatched' ORDER BY r.id`,args:[]});
 stats.supplier_return_reconciliation=rows.map(row=>({...row,unsettled_cents:Number(row.dispatched_cents)-Number(row.credited_cents)-Number(row.replaced_cents)}));
 for(const row of stats.supplier_return_reconciliation)if(row.unsettled_cents<0)stats.reconciliation_issues.push({...row,type:'supplier_return_over_settled'});
}
module.exports={syncSupplierCorrections};
