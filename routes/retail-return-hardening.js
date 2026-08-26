'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');
const {nextNumber}=require('../lib/nextNumber');
const {syncBinQty}=require('../lib/binSync');
const {ensureSchema:ensureCustomerAccountIntegrity}=require('./customer-account-integrity');

let readyPromise=null;
const money=v=>{const n=Number(v);return Number.isFinite(n)?Number(n.toFixed(2)):0;};
async function ensureSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await ensureCustomerAccountIntegrity();
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS retail_return_allocations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        return_id INTEGER NOT NULL UNIQUE REFERENCES returns(id),
        original_transaction_id INTEGER NOT NULL REFERENCES transactions(id),
        gross_merchandise REAL NOT NULL,
        tax_reversed REAL NOT NULL,
        order_discount_allocated REAL NOT NULL DEFAULT 0,
        cashback_allocated REAL NOT NULL DEFAULT 0,
        store_credit_restored REAL NOT NULL DEFAULT 0,
        customer_entitlement_total REAL NOT NULL,
        external_refund_total REAL NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:'CREATE INDEX IF NOT EXISTS idx_retail_return_alloc_tx ON retail_return_allocations(original_transaction_id)'}
    ],'write');
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Retail return integrity initialization failed',detail:e.message});}});

async function priorAllocations(transactionId){
  const {rows:[row]}=await db.execute({sql:`SELECT
      COALESCE(SUM(a.gross_merchandise),0) gross_returned,
      COALESCE(SUM(a.order_discount_allocated),0) discount_allocated,
      COALESCE(SUM(a.cashback_allocated),0) cashback_allocated,
      COALESCE(SUM(a.store_credit_restored),0) store_credit_restored
    FROM retail_return_allocations a JOIN returns r ON r.id=a.return_id
    WHERE a.original_transaction_id=? AND COALESCE(r.status,'completed')!='cancelled'`,args:[transactionId]});
  return row||{};
}

router.post('/:id/return',requirePermission('transactions_returns'),async(req,res,next)=>{
  try{
    if(req.body?.resolution==='replacement')return next();
    const resolution=String(req.body?.resolution||'').trim();
    if(!['refund','credit_note'].includes(resolution))return res.status(400).json({error:'Return resolution must be refund, credit_note, or replacement'});
    const transactionId=Number(req.params.id);
    const {rows:[tx]}=await db.execute({sql:'SELECT * FROM transactions WHERE id=?',args:[transactionId]});
    if(!tx)return res.status(404).json({error:'Transaction not found'});
    if(tx.status!=='completed')return res.status(409).json({error:'Only completed transactions can be returned'});
    const {rows:[rental]}=await db.execute({sql:'SELECT agreement_number FROM rental_agreements WHERE checkout_transaction_id=? OR settlement_transaction_id=?',args:[transactionId,transactionId]});
    if(rental)return res.status(409).json({error:`Transaction belongs to rental agreement ${rental.agreement_number}; use the Rentals return workflow.`});
    if(resolution==='credit_note'&&!tx.customer_id)return res.status(400).json({error:'A credit note requires a customer on the original transaction'});
    if(tx.payment_method==='credit'&&resolution==='refund')return res.status(409).json({error:'Charge-account sales must be returned as a credit note so Accounts Receivable is reduced correctly'});

    const requested=Array.isArray(req.body?.items)?req.body.items:[];
    if(!requested.length)return res.status(400).json({error:'No items selected for return'});
    const {rows:txItems}=await db.execute({sql:'SELECT * FROM transaction_items WHERE transaction_id=? ORDER BY id',args:[transactionId]});
    const {rows:returned}=await db.execute({sql:`SELECT ri.transaction_item_id,COALESCE(SUM(ri.quantity),0) returned_qty
      FROM return_items ri JOIN returns r ON r.id=ri.return_id
      WHERE r.original_transaction_id=? AND COALESCE(r.status,'completed')!='cancelled'
      GROUP BY ri.transaction_item_id`,args:[transactionId]});
    const returnedMap=new Map(returned.map(r=>[Number(r.transaction_item_id),Number(r.returned_qty||0)]));

    let gross=0,tax=0;const selected=[];
    for(const item of requested){
      const qty=Number(item.quantity);
      if(!Number.isInteger(qty)||qty<=0)return res.status(400).json({error:'Return quantities must be positive whole numbers'});
      const line=txItems.find(x=>Number(x.id)===Number(item.transaction_item_id));
      if(!line)return res.status(400).json({error:`Item ${item.transaction_item_id} not found in transaction`});
      const prior=returnedMap.get(Number(line.id))||0;
      const max=Number(line.quantity||0)-prior;
      if(qty-max>0.0001)return res.status(409).json({error:`Invalid quantity for "${line.product_name}". Max returnable: ${max}`});
      const ratio=qty/Number(line.quantity||1);
      const lineGross=money(Number(line.total||0)*ratio);
      const lineTax=money(Number(line.tax_amount||0)*ratio);
      gross=money(gross+lineGross);tax=money(tax+lineTax);
      selected.push({line,qty,lineGross,lineTax});
    }

    const prior=await priorAllocations(transactionId);
    const originalGross=money(txItems.reduce((s,x)=>s+Number(x.total||0),0));
    const remainingGross=money(Math.max(0,originalGross-Number(prior.gross_returned||0)));
    if(gross-remainingGross>0.01)return res.status(409).json({error:'Return value exceeds the remaining unreturned merchandise value'});
    const finalReturn=Math.abs(gross-remainingGross)<=0.01;
    const share=remainingGross>0?Math.min(1,gross/remainingGross):0;
    const remainingDiscount=money(Math.max(0,Number(tx.discount_amount||0)-Number(prior.discount_allocated||0)));
    const remainingCashback=money(Math.max(0,Number(tx.cash_back_applied||0)-Number(prior.cashback_allocated||0)));
    const remainingStoreCredit=money(Math.max(0,Number(tx.store_credit_applied||0)-Number(prior.store_credit_restored||0)));
    const discountAllocated=finalReturn?remainingDiscount:money(remainingDiscount*share);
    const cashbackAllocated=finalReturn?remainingCashback:money(remainingCashback*share);
    const netMerchandise=money(Math.max(0,gross-discountAllocated-cashbackAllocated));
    const entitlement=money(netMerchandise+tax);
    const storeCreditRestored=finalReturn?Math.min(remainingStoreCredit,entitlement):money(Math.min(remainingStoreCredit*share,entitlement));
    const externalRefund=money(Math.max(0,entitlement-storeCreditRestored));
    if(entitlement<=0)return res.status(409).json({error:'The selected return has no remaining refundable or creditable value'});

    const returnNumber=await nextNumber(db,'returns','return_number','RET-',6);
    const actor=req.employee?.id||tx.employee_id||null;
    const txn=await db.transaction('write');let committed=false;
    try{
      const rr=await txn.execute({sql:`INSERT INTO returns(return_number,original_transaction_id,customer_id,employee_id,branch_id,resolution,subtotal,tax_amount,total,notes)
        VALUES(?,?,?,?,?,?,?,?,?,?)`,args:[returnNumber,transactionId,tx.customer_id||null,actor,tx.branch_id||null,resolution,netMerchandise,tax,entitlement,req.body?.notes||null]});
      const returnId=Number(rr.lastInsertRowid);
      await txn.execute({sql:`INSERT INTO retail_return_allocations(return_id,original_transaction_id,gross_merchandise,tax_reversed,order_discount_allocated,cashback_allocated,store_credit_restored,customer_entitlement_total,external_refund_total)
        VALUES(?,?,?,?,?,?,?,?,?)`,args:[returnId,transactionId,gross,tax,discountAllocated,cashbackAllocated,storeCreditRestored,entitlement,resolution==='refund'?externalRefund:0]});

      for(const s of selected){
        await txn.execute({sql:`INSERT INTO return_items(return_id,transaction_item_id,product_id,product_name,sku,quantity,unit_price,tax_amount,total)
          VALUES(?,?,?,?,?,?,?,?,?)`,args:[returnId,s.line.id,s.line.product_id,s.line.product_name,s.line.sku,s.qty,s.line.unit_price,s.lineTax,s.lineGross]});
        if(s.line.variation_id){
          await txn.execute({sql:'UPDATE product_variations SET stock_qty=stock_qty+? WHERE id=?',args:[s.qty,s.line.variation_id]});
        }else if(s.line.product_id){
          await txn.execute({sql:'UPDATE products SET stock_qty=stock_qty+? WHERE id=?',args:[s.qty,s.line.product_id]});
        }
        if(tx.branch_id&&s.line.product_id){
          await txn.execute({sql:`INSERT INTO branch_inventory(product_id,branch_id,stock_qty,min_stock,updated_at)
            VALUES(?,?,?,(SELECT min_stock FROM products WHERE id=?),CURRENT_TIMESTAMP)
            ON CONFLICT(product_id,branch_id) DO UPDATE SET stock_qty=stock_qty+excluded.stock_qty,updated_at=CURRENT_TIMESTAMP`,args:[s.line.product_id,tx.branch_id,s.qty,s.line.product_id]});
          await syncBinQty(txn,s.line.product_id,tx.branch_id,s.qty);
          try{await txn.execute({sql:`INSERT INTO stock_movements(product_id,branch_id,movement_type,quantity,reference_type,reference_id,notes,employee_id)
            VALUES(?,?,'return',?,'return',?,?,?)`,args:[s.line.product_id,tx.branch_id,s.qty,returnId,`Return ${returnNumber}`,actor]});}catch(e){}
        }
      }

      if(tx.customer_id){
        const spentReduction=externalRefund;
        const loyaltyReduction=Math.floor(spentReduction*0.5);
        await txn.execute({sql:'UPDATE customers SET loyalty_points=MAX(0,loyalty_points-?),total_spent=MAX(0,total_spent-?) WHERE id=?',args:[loyaltyReduction,spentReduction,tx.customer_id]});
        if(resolution==='credit_note'){
          await txn.execute({sql:'UPDATE customers SET account_balance=account_balance-? WHERE id=?',args:[entitlement,tx.customer_id]});
        }else if(storeCreditRestored>0){
          await txn.execute({sql:'UPDATE customers SET account_balance=account_balance-? WHERE id=?',args:[storeCreditRestored,tx.customer_id]});
        }
      }

      await txn.commit();committed=true;
      const {rows:[saved]}=await db.execute({sql:'SELECT * FROM returns WHERE id=?',args:[returnId]});
      const {rows:items}=await db.execute({sql:'SELECT * FROM return_items WHERE return_id=? ORDER BY id',args:[returnId]});
      const {rows:[allocation]}=await db.execute({sql:'SELECT * FROM retail_return_allocations WHERE return_id=?',args:[returnId]});
      return res.status(201).json({...saved,items,allocation});
    }catch(e){if(!committed)await txn.rollback();return res.status(committed?500:400).json({error:e.message});}
  }catch(e){res.status(500).json({error:e.message});}
});

module.exports=router;
module.exports.ensureSchema=ensureSchema;
