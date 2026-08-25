const {db}=require('../database');
const {ensureLedger,postSourceJournal}=require('./accounting-posting');

function money(v){const n=Number(v);return Number.isFinite(n)?Number(n.toFixed(2)):0;}
async function exists(table){const {rows:[r]}=await db.execute({sql:"SELECT name FROM sqlite_master WHERE type='table' AND name=?",args:[table]});return !!r;}

async function ensureReturnAccounts(){
  await ensureLedger();
  const defs=[
    ['2300','Customer Store Credit','liability','credit'],
    ['2400','Customer Refunds Payable','liability','credit'],
    ['4300','Sales Returns & Allowances','revenue','debit']
  ];
  for(const a of defs)await db.execute({sql:'INSERT OR IGNORE INTO ledger_accounts(code,name,account_type,normal_balance,system_account) VALUES(?,?,?,?,1)',args:a});
}

async function syncRetailReturns({actorId,stats}){
  if(!(await exists('returns'))||!(await exists('return_items'))||!(await exists('transactions')))return;
  await ensureReturnAccounts();
  const hasRentals=await exists('rental_agreements');
  const hasWorkOrders=await exists('work_orders');
  const rentalExclusion=hasRentals?`AND NOT EXISTS (SELECT 1 FROM rental_agreements ra WHERE ra.checkout_transaction_id=r.original_transaction_id OR ra.settlement_transaction_id=r.original_transaction_id)`:'';
  const workOrderExclusion=hasWorkOrders?`AND NOT EXISTS (SELECT 1 FROM work_orders wo WHERE wo.assessment_transaction_id=r.original_transaction_id OR wo.deposit_transaction_id=r.original_transaction_id OR wo.final_transaction_id=r.original_transaction_id)`:'';
  const {rows}=await db.execute({sql:`SELECT r.*,t.transaction_number AS original_transaction_number
    FROM returns r JOIN transactions t ON t.id=r.original_transaction_id
    WHERE COALESCE(r.status,'completed')!='cancelled' ${rentalExclusion} ${workOrderExclusion}
    ORDER BY r.id`,args:[]});

  const {rows:cols}=await db.execute({sql:'PRAGMA table_info(return_items)',args:[]});
  const names=new Set(cols.map(c=>String(c.name||'').toLowerCase()));
  const hasCost=names.has('unit_cost_at_return');

  for(const r of rows){
    try{
      const subtotal=money(r.subtotal);
      const tax=money(r.tax_amount);
      const total=money(r.total);
      if(Math.abs(money(subtotal+tax)-total)>0.01){
        stats.reconciliation_issues.push({return_id:r.id,return_number:r.return_number,type:'retail_return_total_mismatch',subtotal,tax,total});
        continue;
      }

      if(r.resolution==='refund'||r.resolution==='credit_note'){
        const lines=[];
        if(subtotal>0)lines.push({code:'4300',debit:subtotal,credit:0,description:'Reverse retail revenue for returned merchandise'});
        if(tax>0)lines.push({code:'2100',debit:tax,credit:0,description:'Reverse sales tax liability on return'});
        if(total>0)lines.push({code:r.resolution==='credit_note'?'2300':'2400',debit:0,credit:total,description:r.resolution==='credit_note'?'Customer store credit created':'Customer refund payable pending settlement evidence'});
        if(lines.length){
          const j=await postSourceJournal({sourceType:'retail_return',sourceId:r.id,sourceReference:r.return_number,entryDate:String(r.created_at||new Date().toISOString()).slice(0,10),description:`Retail ${r.resolution} ${r.return_number}`,branchId:r.branch_id,actorId,lines});
          stats.retail_returns[j.existing?'existing':'posted']++;
        }
      }else if(r.resolution==='replacement'){
        stats.evidence_gaps.push({return_id:r.id,return_number:r.return_number,type:'replacement_fulfillment_accounting_untracked',automatic_posting:false,reason:'The return records the item coming back, but the current replacement workflow does not preserve a separate outgoing replacement transaction. Revenue/tax are therefore not reversed or recreated automatically.'});
      }else{
        stats.evidence_gaps.push({return_id:r.id,return_number:r.return_number,type:'unknown_return_resolution',resolution:r.resolution,automatic_posting:false});
      }

      if(!hasCost){
        stats.evidence_gaps.push({return_id:r.id,return_number:r.return_number,type:'return_cost_snapshot_missing',automatic_posting:false,reason:'return_items has no original sale-cost snapshot field, so Accounting will not infer inventory value from current catalog cost.'});
        continue;
      }
      const {rows:items}=await db.execute({sql:'SELECT quantity,unit_cost_at_return FROM return_items WHERE return_id=?',args:[r.id]});
      let cost=0,missing=0;
      for(const item of items){
        const unit=Number(item.unit_cost_at_return);
        if(!Number.isFinite(unit)){missing++;continue;}
        cost+=Number(item.quantity||0)*unit;
      }
      cost=money(cost);
      if(missing){
        stats.evidence_gaps.push({return_id:r.id,return_number:r.return_number,type:'return_item_cost_evidence_missing',missing_lines:missing,automatic_posting:false,reason:'One or more returned lines predate sale-time cost snapshots; inventory/COGS reversal is not partially estimated.'});
        continue;
      }
      if(cost>0){
        const j=await postSourceJournal({sourceType:'retail_return_inventory',sourceId:r.id,sourceReference:r.return_number,entryDate:String(r.created_at||new Date().toISOString()).slice(0,10),description:`Inventory restored by ${r.return_number}`,branchId:r.branch_id,actorId,lines:[{code:'1200',debit:cost,credit:0,description:'Returned merchandise restored to inventory'},{code:'5000',debit:0,credit:cost,description:'Reverse original retail COGS'}]});
        stats.retail_return_inventory[j.existing?'existing':'posted']++;
      }
    }catch(e){stats.errors.push(`retail_return:${r.id}: ${e.message}`);}
  }
}

module.exports={ensureReturnAccounts,syncRetailReturns};
