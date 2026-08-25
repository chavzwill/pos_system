const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requireAnyPermission}=require('../lib/permissions');
const {ensureLedger,postSourceJournal}=require('../lib/accounting-posting');
router.use(requireAnyPermission('reports_financial','reports'));
function actor(req){return req.employee?.id||req.user?.employee_id||null;}
async function exists(table){const {rows:[r]}=await db.execute({sql:"SELECT name FROM sqlite_master WHERE type='table' AND name=?",args:[table]});return !!r;}
async function ensureBridgeAccounts(){await ensureLedger();const defs=[['1050','Electronic Settlement Clearing','asset','debit'],['1250','Purchasing & Receiving Clearing','asset','debit']];for(const a of defs)await db.execute({sql:`INSERT OR IGNORE INTO ledger_accounts(code,name,account_type,normal_balance,system_account) VALUES(?,?,?,?,1)`,args:a});}
async function syncSupplierInvoices(req,stats){if(!(await exists('supplier_invoices')))return;const {rows}=await db.execute({sql:`SELECT * FROM supplier_invoices WHERE status!='void' ORDER BY id`,args:[]});for(const x of rows){try{const j=await postSourceJournal({sourceType:'supplier_invoice',sourceId:x.id,sourceReference:x.invoice_number,entryDate:x.invoice_date,description:`Supplier invoice ${x.invoice_number}`,branchId:x.branch_id,actorId:actor(req),lines:[{code:'1250',debit:x.total,credit:0,description:'Purchasing/receiving clearing'},{code:'2000',debit:0,credit:x.total,description:'Accounts payable'}]});stats.supplier_invoices[j.existing?'existing':'posted']++;}catch(e){stats.errors.push(`supplier_invoice:${x.id}: ${e.message}`);}}}
async function syncSupplierPayments(req,stats){if(!(await exists('supplier_payments')))return;const {rows}=await db.execute({sql:`SELECT * FROM supplier_payments ORDER BY id`,args:[]});for(const x of rows){try{const method=String(x.payment_method||'').toLowerCase();const cash=method.includes('cash');const j=await postSourceJournal({sourceType:'supplier_payment',sourceId:x.id,sourceReference:x.payment_number,entryDate:x.payment_date,description:`Supplier payment ${x.payment_number}`,branchId:x.branch_id,actorId:actor(req),lines:[{code:'2000',debit:x.amount,credit:0,description:'Reduce accounts payable'},{code:cash?'1000':'1010',debit:0,credit:x.amount,description:cash?'Cash paid':'Bank payment'}]});stats.supplier_payments[j.existing?'existing':'posted']++;}catch(e){stats.errors.push(`supplier_payment:${x.id}: ${e.message}`);}}}
async function syncSettlements(req,stats){if(!(await exists('settlement_batches')))return;const {rows}=await db.execute({sql:`SELECT sb.* FROM settlement_batches sb WHERE sb.status='reconciled' ORDER BY sb.id`,args:[]});for(const x of rows){try{const gross=Number(x.gross_amount||0),fees=Number(x.fees||0),net=Number(x.net_amount||0);const lines=[{code:'1010',debit:net,credit:0,description:'Bank settlement received'}];if(fees>0)lines.push({code:'5300',debit:fees,credit:0,description:'Processor/bank fees'});lines.push({code:'1050',debit:0,credit:gross,description:'Clear electronic settlement receivable'});const j=await postSourceJournal({sourceType:'settlement_batch',sourceId:x.id,sourceReference:x.reference,entryDate:x.settlement_date,description:`Reconciled settlement ${x.reference||x.id}`,branchId:x.branch_id,actorId:actor(req),lines});stats.settlements[j.existing?'existing':'posted']++;}catch(e){stats.errors.push(`settlement_batch:${x.id}: ${e.message}`);}}}
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
router.post('/sync',async(req,res)=>{try{await ensureBridgeAccounts();const stats={supplier_invoices:{posted:0,existing:0},supplier_payments:{posted:0,existing:0},settlements:{posted:0,existing:0},repair_part_usage:{posted:0,existing:0},errors:[]};await syncSupplierInvoices(req,stats);await syncSupplierPayments(req,stats);await syncSettlements(req,stats);await syncRepairPartUsage(req,stats);res.json({success:stats.errors.length===0,stats,basis:'Only verified posted supplier invoices, recorded supplier payments, reconciled settlement batches, and completed repair part consumption are bridged. Repair COGS posts only after the work order reaches a completed state and is idempotent by work order.'});}catch(e){res.status(500).json({error:e.message});}});
module.exports=router;
