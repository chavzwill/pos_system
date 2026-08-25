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

async function syncRetailSaleCogs({actorId,stats}){
  stats.retail_cogs ||= {posted:0,existing:0};
  if(!(await exists('transactions'))||!(await exists('transaction_items')))return;
  const {rows:cols}=await db.execute({sql:'PRAGMA table_info(transaction_items)',args:[]});
  const names=new Set(cols.map(c=>String(c.name||'').toLowerCase()));
  if(!names.has('unit_cost_at_sale')){
    stats.evidence_gaps.push({type:'retail_cogs_cost_snapshot_missing',automatic_posting:false,reason:'transaction_items does not preserve sale-time inventory cost, so Accounting will not infer COGS from current catalog cost.'});
    return;
  }
  const hasRentals=await exists('rental_agreements');
  const hasWorkOrders=await exists('work_orders');
  const rentalExclusion=hasRentals?`AND NOT EXISTS (SELECT 1 FROM rental_agreements ra WHERE ra.checkout_transaction_id=t.id OR ra.settlement_transaction_id=t.id)`:'';
  const workOrderExclusion=hasWorkOrders?`AND NOT EXISTS (SELECT 1 FROM work_orders wo WHERE wo.assessment_transaction_id=t.id OR wo.deposit_transaction_id=t.id OR wo.final_transaction_id=t.id)`:'';
  const {rows:sales}=await db.execute({sql:`SELECT t.id,t.transaction_number,t.branch_id,t.created_at,
      ROUND(SUM(ti.quantity*ti.unit_cost_at_sale),2) cogs,
      SUM(CASE WHEN ti.product_id IS NOT NULL AND ti.unit_cost_at_sale IS NULL THEN 1 ELSE 0 END) missing_cost_lines
    FROM transactions t JOIN transaction_items ti ON ti.transaction_id=t.id
    WHERE t.status='completed' ${rentalExclusion} ${workOrderExclusion}
      AND ti.product_id IS NOT NULL
    GROUP BY t.id,t.transaction_number,t.branch_id,t.created_at ORDER BY t.id`,args:[]});
  for(const sale of sales){
    try{
      if(Number(sale.missing_cost_lines||0)>0){
        stats.evidence_gaps.push({transaction_id:sale.id,transaction_number:sale.transaction_number,type:'retail_sale_cost_evidence_missing',missing_lines:Number(sale.missing_cost_lines||0),automatic_posting:false,reason:'One or more retail lines lack a preserved sale-time cost. COGS is not partially estimated.'});
        continue;
      }
      const cost=money(sale.cogs);
      if(cost<=0)continue;
      const j=await postSourceJournal({sourceType:'retail_sale_cogs',sourceId:sale.id,sourceReference:sale.transaction_number,entryDate:String(sale.created_at||new Date().toISOString()).slice(0,10),description:`Retail COGS ${sale.transaction_number}`,branchId:sale.branch_id,actorId,lines:[{code:'5000',debit:cost,credit:0,description:'Retail merchandise cost at preserved sale-time valuation'},{code:'1200',debit:0,credit:cost,description:'Inventory consumed by retail sale'}]});
      stats.retail_cogs[j.existing?'existing':'posted']++;
    }catch(e){stats.errors.push(`retail_sale_cogs:${sale.id}: ${e.message}`);}
  }
}

async function syncRetailReturns({actorId,stats}){
  await syncRetailSaleCogs({actorId,stats});
  if(!(await exists('returns'))||!(await exists('return_items'))||!(await exists('transactions')))return;
  await ensureReturnAccounts();
  stats.retail_replacement_fulfillment ||= {posted:0,existing:0};
  const hasRentals=await exists('rental_agreements');
  const hasWorkOrders=await exists('work_orders');
  const hasReplacementFulfillment=await exists('replacement_fulfillments');
  const hasQuarantine=await exists('return_quarantine');
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
        if(!hasReplacementFulfillment){
          stats.evidence_gaps.push({return_id:r.id,return_number:r.return_number,type:'replacement_fulfillment_accounting_untracked',automatic_posting:false,reason:'This replacement predates the audited replacement-fulfillment ledger.'});
        }else{
          const {rows:fulfillments}=await db.execute({sql:'SELECT quantity,unit_cost_at_issue FROM replacement_fulfillments WHERE return_id=? ORDER BY id',args:[r.id]});
          const {rows:returnLines}=await db.execute({sql:'SELECT quantity FROM return_items WHERE return_id=? ORDER BY id',args:[r.id]});
          const returnedQty=returnLines.reduce((s,x)=>s+Number(x.quantity||0),0);
          const issuedQty=fulfillments.reduce((s,x)=>s+Number(x.quantity||0),0);
          if(!fulfillments.length||issuedQty!==returnedQty){
            stats.reconciliation_issues.push({return_id:r.id,return_number:r.return_number,type:'replacement_quantity_mismatch',returned_quantity:returnedQty,issued_quantity:issuedQty});
          }else{
            let issueCost=0,missingCost=0;
            for(const f of fulfillments){const unit=Number(f.unit_cost_at_issue);if(!Number.isFinite(unit)){missingCost++;continue;}issueCost+=Number(f.quantity||0)*unit;}
            issueCost=money(issueCost);
            if(missingCost){
              stats.evidence_gaps.push({return_id:r.id,return_number:r.return_number,type:'replacement_issue_cost_missing',missing_lines:missingCost,automatic_posting:false,reason:'Replacement stock left the business, but one or more fulfillment lines lack a preserved issue-time cost.'});
            }else if(issueCost>0){
              const j=await postSourceJournal({sourceType:'retail_replacement_issue',sourceId:r.id,sourceReference:r.return_number,entryDate:String(r.created_at||new Date().toISOString()).slice(0,10),description:`Replacement inventory issued ${r.return_number}`,branchId:r.branch_id,actorId,lines:[{code:'5000',debit:issueCost,credit:0,description:'Replacement merchandise cost'},{code:'1200',debit:0,credit:issueCost,description:'Inventory issued for like-for-like replacement'}]});
              stats.retail_replacement_fulfillment[j.existing?'existing':'posted']++;
            }
          }
          if(hasQuarantine){
            const {rows:[q]}=await db.execute({sql:'SELECT COALESCE(SUM(quantity),0) quantity FROM return_quarantine WHERE return_id=?',args:[r.id]});
            const quarantined=Number(q?.quantity||0);
            if(quarantined!==returnedQty)stats.reconciliation_issues.push({return_id:r.id,return_number:r.return_number,type:'replacement_quarantine_quantity_mismatch',returned_quantity:returnedQty,quarantined_quantity:quarantined});
          }else{
            stats.evidence_gaps.push({return_id:r.id,return_number:r.return_number,type:'replacement_quarantine_evidence_missing',automatic_posting:false,reason:'Returned replacement merchandise has no quarantine/disposition ledger.'});
          }
        }
      }else{
        stats.evidence_gaps.push({return_id:r.id,return_number:r.return_number,type:'unknown_return_resolution',resolution:r.resolution,automatic_posting:false});
      }

      if(r.resolution==='replacement')continue;

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

module.exports={ensureReturnAccounts,syncRetailSaleCogs,syncRetailReturns};
