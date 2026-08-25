const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requireAnyPermission}=require('../lib/permissions');
const {ensureLedger,postSourceJournal}=require('../lib/accounting-posting');
const {syncRetailReturns}=require('../lib/accounting-retail-returns');
const {syncRentalAccounting}=require('../lib/accounting-rentals');
const {syncPurchasingAccounting}=require('../lib/accounting-purchasing');
router.use(requireAnyPermission('reports_financial','reports'));
function actor(req){return req.employee?.id||req.user?.employee_id||null;}
async function exists(table){const {rows:[r]}=await db.execute({sql:"SELECT name FROM sqlite_master WHERE type='table' AND name=?",args:[table]});return !!r;}
async function ensureBridgeAccounts(){
  await ensureLedger();
  const defs=[
    ['1050','Electronic Settlement Clearing','asset','debit'],
    ['1250','Purchasing & Receiving Clearing','asset','debit'],
    ['2200','Customer Deposits','liability','credit'],
    ['2300','Customer Store Credit','liability','credit']
  ];
  for(const a of defs)await db.execute({sql:`INSERT OR IGNORE INTO ledger_accounts(code,name,account_type,normal_balance,system_account) VALUES(?,?,?,?,1)`,args:a});
}
function money(v){const n=Number(v);return Number.isFinite(n)?Number(n.toFixed(2)):0;}
function paymentDebitCode(method){
  const m=String(method||'').toLowerCase();
  if(m.includes('cash'))return '1000';
  if(m.includes('charge')||m==='credit'||m.includes('account'))return '1100';
  return '1050';
}
async function syncSupplierInvoices(req,stats){if(!(await exists('supplier_invoices')))return;const {rows}=await db.execute({sql:`SELECT * FROM supplier_invoices WHERE status!='void' ORDER BY id`,args:[]});for(const x of rows){try{const j=await postSourceJournal({sourceType:'supplier_invoice',sourceId:x.id,sourceReference:x.invoice_number,entryDate:x.invoice_date,description:`Supplier invoice ${x.invoice_number}`,branchId:x.branch_id,actorId:actor(req),lines:[{code:'1250',debit:x.total,credit:0,description:'Purchasing/receiving clearing'},{code:'2000',debit:0,credit:x.total,description:'Accounts payable'}]});stats.supplier_invoices[j.existing?'existing':'posted']++;}catch(e){stats.errors.push(`supplier_invoice:${x.id}: ${e.message}`);}}}
async function syncSupplierPayments(req,stats){if(!(await exists('supplier_payments')))return;const {rows}=await db.execute({sql:`SELECT * FROM supplier_payments ORDER BY id`,args:[]});for(const x of rows){try{const method=String(x.payment_method||'').toLowerCase();const cash=method.includes('cash');const j=await postSourceJournal({sourceType:'supplier_payment',sourceId:x.id,sourceReference:x.payment_number,entryDate:x.payment_date,description:`Supplier payment ${x.payment_number}`,branchId:x.branch_id,actorId:actor(req),lines:[{code:'2000',debit:x.amount,credit:0,description:'Reduce accounts payable'},{code:cash?'1000':'1010',debit:0,credit:x.amount,description:cash?'Cash paid':'Bank payment'}]});stats.supplier_payments[j.existing?'existing':'posted']++;}catch(e){stats.errors.push(`supplier_payment:${x.id}: ${e.message}`);}}}
async function syncSettlements(req,stats){if(!(await exists('settlement_batches')))return;const {rows}=await db.execute({sql:`SELECT sb.* FROM settlement_batches sb WHERE sb.status='reconciled' ORDER BY sb.id`,args:[]});for(const x of rows){try{const gross=Number(x.gross_amount||0),fees=Number(x.fees||0),net=Number(x.net_amount||0);const lines=[{code:'1010',debit:net,credit:0,description:'Bank settlement received'}];if(fees>0)lines.push({code:'5300',debit:fees,credit:0,description:'Processor/bank fees'});lines.push({code:'1050',debit:0,credit:gross,description:'Clear electronic settlement receivable'});const j=await postSourceJournal({sourceType:'settlement_batch',sourceId:x.id,sourceReference:x.reference,entryDate:x.settlement_date,description:`Reconciled settlement ${x.reference||x.id}`,branchId:x.branch_id,actorId:actor(req),lines});stats.settlements[j.existing?'existing':'posted']++;}catch(e){stats.errors.push(`settlement_batch:${x.id}: ${e.message}`);}}}
async function syncRetailSales(req,stats){
  if(!(await exists('transactions')))return;
  const hasPayments=await exists('transaction_payments');
  const hasRentals=await exists('rental_agreements');
  const hasWorkOrders=await exists('work_orders');
  const rentalExclusion=hasRentals?`AND NOT EXISTS (SELECT 1 FROM rental_agreements ra WHERE ra.checkout_transaction_id=t.id OR ra.settlement_transaction_id=t.id)`:'';
  const workOrderExclusion=hasWorkOrders?`AND NOT EXISTS (SELECT 1 FROM work_orders wo WHERE wo.assessment_transaction_id=t.id OR wo.deposit_transaction_id=t.id OR wo.final_transaction_id=t.id)`:'';
  const {rows}=await db.execute({sql:`SELECT t.* FROM transactions t WHERE t.status='completed' ${rentalExclusion} ${workOrderExclusion} ORDER BY t.id`,args:[]});
  if(rows.length&&await exists('transaction_items')){
    const {rows:cols}=await db.execute({sql:'PRAGMA table_info(transaction_items)',args:[]});
    const names=new Set(cols.map(c=>String(c.name||'').toLowerCase()));
    const hasHistoricalCost=['unit_cost','cost','cost_at_sale','unit_cost_at_sale'].some(n=>names.has(n));
    if(!hasHistoricalCost){
      stats.evidence_gaps.push({type:'retail_cogs_cost_snapshot_missing',affected_transactions:rows.length,automatic_posting:false,reason:'Retail transaction lines do not preserve historical unit cost. Current product cost may have changed, so Accounting will not invent COGS from today\'s catalog cost.'});
    }
  }
  for(const t of rows){
    try{
      const tax=money(t.tax_amount);
      const storeCredit=money(t.store_credit_applied);
      const total=money(t.total);
      const revenue=money(total-tax+storeCredit);
      if(total<0||tax<0||storeCredit<0||revenue<0){
        stats.reconciliation_issues.push({transaction_id:t.id,transaction_number:t.transaction_number,type:'retail_sale_negative_component',total,tax,store_credit:storeCredit,revenue});
        continue;
      }
      let payments=[];
      if(hasPayments){
        const result=await db.execute({sql:'SELECT payment_method,amount FROM transaction_payments WHERE transaction_id=? ORDER BY id',args:[t.id]});
        payments=result.rows||[];
      }
      if(!payments.length&&total>0)payments=[{payment_method:t.payment_method||'cash',amount:total}];
      const paymentTotal=money(payments.reduce((s,p)=>s+money(p.amount),0));
      if(Math.abs(paymentTotal-total)>0.01){
        stats.reconciliation_issues.push({transaction_id:t.id,transaction_number:t.transaction_number,type:'retail_tender_mismatch',expected:total,actual:paymentTotal});
        continue;
      }
      const byAccount={};
      for(const p of payments){
        const amount=money(p.amount);if(amount<=0)continue;
        const code=paymentDebitCode(p.payment_method);
        byAccount[code]=money((byAccount[code]||0)+amount);
      }
      const lines=[];
      for(const [code,amount] of Object.entries(byAccount))lines.push({code,debit:amount,credit:0,description:code==='1000'?'Retail cash tender':code==='1100'?'Retail charge-account receivable':'Retail electronic tender clearing'});
      if(storeCredit>0)lines.push({code:'2300',debit:storeCredit,credit:0,description:'Customer store credit redeemed'});
      if(revenue>0)lines.push({code:'4000',debit:0,credit:revenue,description:'Retail sales revenue net of discounts and loyalty cash-back'});
      if(tax>0)lines.push({code:'2100',debit:0,credit:tax,description:'Sales tax payable'});
      if(!lines.length)continue;
      const j=await postSourceJournal({sourceType:'retail_sale',sourceId:t.id,sourceReference:t.transaction_number,entryDate:String(t.created_at||new Date().toISOString()).slice(0,10),description:`Retail sale ${t.transaction_number}`,branchId:t.branch_id,actorId:actor(req),lines});
      stats.retail_sales[j.existing?'existing':'posted']++;
    }catch(e){stats.errors.push(`retail_sale:${t.id}: ${e.message}`);}
  }
}
async function syncRepairPartUsage(req,stats){
  if(!(await exists('repair_part_reservations'))||!(await exists('work_order_items'))||!(await exists('work_orders')))return;
  const {rows}=await db.execute({sql:`SELECT wo.id,wo.wo_number,wo.branch_id,COALESCE(wo.completed_at,wo.picked_up_at,wo.created_at) AS evidence_date,
      ROUND(SUM(r.quantity_consumed*COALESCE(woi.unit_cost,0)),2) AS inventory_cost,
      SUM(r.quantity_consumed) AS consumed_units
    FROM work_orders wo
    JOIN work_order_items woi ON woi.work_order_id=wo.id AND COALESCE(woi.is_customer_supplied,0)=0
    JOIN repair_part_reservations r ON r.work_order_item_id=woi.id AND r.work_order_id=wo.id
    WHERE wo.status IN ('complete','awaiting_pickup','picked_up') AND r.quantity_consumed>0
    GROUP BY wo.id,wo.wo_number,wo.branch_id
    HAVING inventory_cost>0
    ORDER BY wo.id`,args:[]});
  for(const x of rows){
    try{
      const cost=Number(x.inventory_cost||0);
      if(cost<=0)continue;
      const j=await postSourceJournal({sourceType:'repair_part_usage',sourceId:x.id,sourceReference:x.wo_number,entryDate:String(x.evidence_date||new Date().toISOString()).slice(0,10),description:`Repair parts consumed on ${x.wo_number}`,branchId:x.branch_id,actorId:actor(req),lines:[{code:'5000',debit:cost,credit:0,description:`Repair parts COGS (${x.consumed_units} units)`},{code:'1200',debit:0,credit:cost,description:'Reduce inventory for parts installed on repair'}]});
      stats.repair_part_usage[j.existing?'existing':'posted']++;
    }catch(e){stats.errors.push(`repair_part_usage:${x.id}: ${e.message}`);}
  }
}
async function syncRepairFinancials(req,stats){
  if(!(await exists('work_orders'))||!(await exists('transactions')))return;
  const {rows}=await db.execute({sql:`SELECT wo.*,
      COALESCE((SELECT SUM(total) FROM work_order_items WHERE work_order_id=wo.id),0) AS parts_total,
      atx.total AS assessment_paid,atx.payment_method AS assessment_method,atx.created_at AS assessment_paid_at,atx.status AS assessment_tx_status,
      dtx.total AS deposit_paid,dtx.payment_method AS deposit_method,dtx.created_at AS deposit_paid_at,dtx.status AS deposit_tx_status,
      ftx.total AS final_paid,ftx.payment_method AS final_method,ftx.created_at AS final_paid_at,ftx.status AS final_tx_status
    FROM work_orders wo
    LEFT JOIN transactions atx ON atx.id=wo.assessment_transaction_id
    LEFT JOIN transactions dtx ON dtx.id=wo.deposit_transaction_id
    LEFT JOIN transactions ftx ON ftx.id=wo.final_transaction_id
    ORDER BY wo.id`,args:[]});
  for(const wo of rows){
    const ref=wo.wo_number||String(wo.id);
    const branchId=wo.branch_id||null;
    const assessmentPaid=money(wo.assessment_paid);
    const depositPaid=money(wo.deposit_paid);
    const finalPaid=money(wo.final_paid);
    const assessmentExpected=money(wo.assessment_fee);
    const depositExpected=money(wo.deposit_amount);
    const serviceValue=money(money(wo.estimate_labor)+money(wo.estimate_consumables)+money(wo.parts_total));
    const depositApplied=money(Math.min(Math.max(depositPaid,0),Math.max(serviceValue,0)));
    const expectedFinal=money(Math.max(0,serviceValue-depositApplied));
    try{
      if(wo.assessment_transaction_id&&Math.abs(assessmentPaid-assessmentExpected)>0.01){
        stats.reconciliation_issues.push({work_order_id:wo.id,wo_number:ref,type:'assessment_payment_mismatch',expected:assessmentExpected,actual:assessmentPaid});
      }
      if(wo.deposit_transaction_id&&Math.abs(depositPaid-depositExpected)>0.01){
        stats.reconciliation_issues.push({work_order_id:wo.id,wo_number:ref,type:'deposit_payment_mismatch',expected:depositExpected,actual:depositPaid});
      }
      if(wo.assessment_transaction_id&&wo.assessment_tx_status!=='voided'&&assessmentPaid>0){
        const j=await postSourceJournal({sourceType:'repair_assessment',sourceId:wo.assessment_transaction_id,sourceReference:ref,entryDate:String(wo.assessment_paid_at||wo.created_at).slice(0,10),description:`Assessment fee ${ref}`,branchId,actorId:actor(req),lines:[{code:paymentDebitCode(wo.assessment_method),debit:assessmentPaid,credit:0,description:'Assessment fee collected'},{code:'4100',debit:0,credit:assessmentPaid,description:'Assessment service revenue'}]});
        stats.repair_assessments[j.existing?'existing':'posted']++;
      }
      if(wo.deposit_transaction_id&&wo.deposit_tx_status!=='voided'&&depositPaid>0){
        const j=await postSourceJournal({sourceType:'repair_deposit',sourceId:wo.deposit_transaction_id,sourceReference:ref,entryDate:String(wo.deposit_paid_at||wo.created_at).slice(0,10),description:`Customer deposit ${ref}`,branchId,actorId:actor(req),lines:[{code:paymentDebitCode(wo.deposit_method),debit:depositPaid,credit:0,description:'Repair deposit received'},{code:'2200',debit:0,credit:depositPaid,description:'Customer deposit liability'}]});
        stats.repair_deposits[j.existing?'existing':'posted']++;
      }
      if(['complete','awaiting_pickup','picked_up'].includes(wo.status)&&serviceValue>0){
        const lines=[];
        if(depositApplied>0)lines.push({code:'2200',debit:depositApplied,credit:0,description:'Apply customer deposit to completed repair'});
        if(expectedFinal>0)lines.push({code:'1100',debit:expectedFinal,credit:0,description:'Completed repair balance receivable'});
        lines.push({code:'4100',debit:0,credit:serviceValue,description:'Completed repair service revenue'});
        const j=await postSourceJournal({sourceType:'repair_service',sourceId:wo.id,sourceReference:ref,entryDate:String(wo.completed_at||wo.created_at).slice(0,10),description:`Completed repair ${ref}`,branchId,actorId:actor(req),lines});
        stats.repair_service_revenue[j.existing?'existing':'posted']++;
      }
      if(wo.final_transaction_id&&wo.final_tx_status!=='voided'&&finalPaid>0){
        if(Math.abs(finalPaid-expectedFinal)>0.01){
          stats.reconciliation_issues.push({work_order_id:wo.id,wo_number:ref,type:'final_payment_mismatch',expected:expectedFinal,actual:finalPaid});
        }else{
          const j=await postSourceJournal({sourceType:'repair_final_payment',sourceId:wo.final_transaction_id,sourceReference:ref,entryDate:String(wo.final_paid_at||wo.picked_up_at||wo.created_at).slice(0,10),description:`Final repair payment ${ref}`,branchId,actorId:actor(req),lines:[{code:paymentDebitCode(wo.final_method),debit:finalPaid,credit:0,description:'Final repair payment collected'},{code:'1100',debit:0,credit:finalPaid,description:'Clear completed repair receivable'}]});
          stats.repair_final_payments[j.existing?'existing':'posted']++;
        }
      }
      if(depositPaid>serviceValue&&serviceValue>=0){
        stats.reconciliation_issues.push({work_order_id:wo.id,wo_number:ref,type:'excess_customer_deposit',service_value:serviceValue,deposit_paid:depositPaid,unapplied_liability:money(depositPaid-serviceValue)});
      }
      if(wo.status==='picked_up'&&expectedFinal>0&&!wo.final_transaction_id){
        stats.reconciliation_issues.push({work_order_id:wo.id,wo_number:ref,type:'picked_up_without_final_payment',expected_final_payment:expectedFinal});
      }
    }catch(e){stats.errors.push(`repair_financial:${wo.id}: ${e.message}`);}
  }
}
router.post('/sync',async(req,res)=>{try{
  await ensureBridgeAccounts();
  const stats={supplier_invoices:{posted:0,existing:0},supplier_payments:{posted:0,existing:0},purchase_receipts:{posted:0,existing:0},settlements:{posted:0,existing:0},retail_sales:{posted:0,existing:0},retail_returns:{posted:0,existing:0},retail_return_inventory:{posted:0,existing:0},retail_replacement_fulfillment:{posted:0,existing:0},rental_checkout:{posted:0,existing:0},rental_settlement:{posted:0,existing:0},repair_part_usage:{posted:0,existing:0},repair_assessments:{posted:0,existing:0},repair_deposits:{posted:0,existing:0},repair_service_revenue:{posted:0,existing:0},repair_final_payments:{posted:0,existing:0},reconciliation_issues:[],evidence_gaps:[],errors:[]};
  await syncPurchasingAccounting({actorId:actor(req),stats});
  await syncSupplierInvoices(req,stats);
  await syncSupplierPayments(req,stats);
  await syncSettlements(req,stats);
  await syncRetailSales(req,stats);
  await syncRetailReturns({actorId:actor(req),stats});
  await syncRentalAccounting({actorId:actor(req),stats});
  await syncRepairPartUsage(req,stats);
  await syncRepairFinancials(req,stats);
  res.json({success:stats.errors.length===0&&stats.reconciliation_issues.length===0,stats,basis:'Verified purchase receipts now debit Inventory and credit Purchasing & Receiving Clearing from immutable receipt-time quantity and cost evidence; supplier invoices then debit that clearing account and credit Accounts Payable, while receipt/invoice value mismatches are surfaced instead of guessed. Verified retail sales, retail returns, rentals, and work-order activity are posted by economic substance rather than by generic transaction totals. Retail returns preserve original sale-time cost evidence and audited replacements preserve outgoing replacement inventory plus quarantine evidence. Rental checkout separates rental/service revenue, sales tax, and refundable deposit liability; rental return settlement releases the deposit, records verified duration/damage/tax adjustments, and leaves negative non-credit settlements in Customer Refunds Payable instead of inventing a cash refund. Positive rental balances are not posted until the cashier settlement transaction exists. Repair cash flows remain separated by assessment revenue, deposit liability, completed service revenue, final payment, and verified parts COGS. All automatic postings are idempotent by source and reconciliation mismatches are surfaced instead of guessed.'});
}catch(e){res.status(500).json({error:e.message});}});
module.exports=router;
