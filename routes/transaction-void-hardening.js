const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requireAuth}=require('../lib/permissions');
const {syncBinQty}=require('../lib/binSync');
const {ensureInventoryCostRestoration,restoreTransactionItemCost}=require('../lib/inventory-cost-restoration');

router.use(async(req,res,next)=>{
  try{await ensureInventoryCostRestoration();next();}
  catch(e){res.status(500).json({error:'Void valuation integrity initialization failed',detail:e.message});}
});

router.patch('/:id/void',requireAuth,async(req,res)=>{
  try{
    const {pin,reason}=req.body||{};
    if(!pin)return res.status(400).json({error:'Override PIN required'});
    const {rows:employees}=await db.execute({sql:'SELECT e.id,e.first_name,e.last_name,e.pin,sg.permissions FROM employees e LEFT JOIN security_groups sg ON e.security_group_id=sg.id WHERE e.active=1',args:[]});
    const authorizer=employees.find(e=>{
      if(e.pin!==String(pin))return false;
      try{return JSON.parse(e.permissions||'{}').void_transactions===true;}catch{return false;}
    });
    if(!authorizer)return res.status(403).json({error:'Invalid PIN or insufficient privilege'});

    const {rows:[sale]}=await db.execute({sql:'SELECT * FROM transactions WHERE id=?',args:[req.params.id]});
    if(!sale)return res.status(404).json({error:'Transaction not found'});
    if(sale.status==='voided')return res.status(400).json({error:'Already voided'});
    if(sale.status!=='completed')return res.status(409).json({error:`Only completed retail transactions can be voided. Current status: ${sale.status}`});

    const {rows:[rental]}=await db.execute({sql:'SELECT agreement_number FROM rental_agreements WHERE checkout_transaction_id=? OR settlement_transaction_id=?',args:[sale.id,sale.id]});
    if(rental)return res.status(409).json({error:`This transaction belongs to rental agreement ${rental.agreement_number}; cancel it through the Rentals workflow.`});
    const {rows:[workOrder]}=await db.execute({sql:'SELECT wo_number FROM work_orders WHERE assessment_transaction_id=? OR deposit_transaction_id=? OR final_transaction_id=?',args:[sale.id,sale.id,sale.id]});
    if(workOrder)return res.status(409).json({error:`This transaction belongs to work order ${workOrder.wo_number}; reverse it through the repair workflow so service/deposit accounting remains intact.`});

    const {rows:[returnEvidence]}=await db.execute({sql:`SELECT r.return_number FROM returns r WHERE r.original_transaction_id=? AND COALESCE(r.status,'completed')!='cancelled' LIMIT 1`,args:[sale.id]});
    if(returnEvidence)return res.status(409).json({error:`Transaction ${sale.transaction_number} already has return ${returnEvidence.return_number}. A whole-sale void would double-restore inventory and conflict with return accounting; reverse the remaining balance through the return workflow instead.`});

    const tx=await db.transaction('write');
    let committed=false;
    try{
      await tx.execute({sql:"UPDATE transactions SET status='voided',voided_by=?,voided_at=CURRENT_TIMESTAMP,void_reason=? WHERE id=? AND status='completed'",args:[authorizer.id,reason||null,sale.id]});
      const {rows:items}=await tx.execute({sql:'SELECT * FROM transaction_items WHERE transaction_id=? ORDER BY id',args:[sale.id]});
      for(const item of items){
        if(!item.product_id)continue;
        const qty=Number(item.quantity||0);
        if(qty<=0)continue;
        if(item.variation_id){
          await tx.execute({sql:'UPDATE product_variations SET stock_qty=stock_qty+? WHERE id=? AND product_id=?',args:[qty,item.variation_id,item.product_id]});
        }else{
          await tx.execute({sql:'UPDATE products SET stock_qty=stock_qty+? WHERE id=?',args:[qty,item.product_id]});
        }
        if(sale.branch_id){
          await tx.execute({sql:`INSERT INTO branch_inventory(product_id,branch_id,stock_qty,min_stock,updated_at)
            VALUES(?,?,?,(SELECT min_stock FROM products WHERE id=?),CURRENT_TIMESTAMP)
            ON CONFLICT(product_id,branch_id) DO UPDATE SET stock_qty=stock_qty+?,updated_at=CURRENT_TIMESTAMP`,args:[item.product_id,sale.branch_id,qty,item.product_id,qty]});
          await syncBinQty(tx,item.product_id,sale.branch_id,qty);
        }
        await restoreTransactionItemCost(tx,{sourceType:'transaction_void',sourceId:sale.id,transactionItemId:item.id,quantity:qty});
        await tx.execute({sql:`INSERT INTO stock_movements(product_id,branch_id,quantity_change,type,reference,reason)
          VALUES(?,?,?,'void_restore',?,?)`,args:[item.product_id,sale.branch_id||null,qty,sale.transaction_number,`Inventory restored by authorized void: ${reason||'No reason supplied'}`]});
      }

      if(sale.customer_id){
        const loyaltyPts=Math.floor(Number(sale.total||0)*0.5);
        await tx.execute({sql:'UPDATE customers SET loyalty_points=MAX(0,loyalty_points-?),total_spent=MAX(0,total_spent-?) WHERE id=?',args:[loyaltyPts,Number(sale.total||0),sale.customer_id]});
        if(sale.is_credit)await tx.execute({sql:'UPDATE customers SET account_balance=MAX(0,account_balance-?) WHERE id=?',args:[Number(sale.total||0),sale.customer_id]});
      }
      await tx.commit();committed=true;
    }catch(e){if(!committed)await tx.rollback();throw e;}

    try{await db.execute({sql:"DELETE FROM commission_records WHERE source_type='transaction' AND source_id=? AND status!='paid'",args:[sale.id]});}catch(e){}
    const {rows:[voided]}=await db.execute({sql:'SELECT id,transaction_number,status,voided_by,voided_at,void_reason FROM transactions WHERE id=?',args:[sale.id]});
    res.json({...voided,voided_by_name:`${authorizer.first_name} ${authorizer.last_name}`,accounting_reversal:'Accounting Source Sync will reverse any posted retail sale and COGS journals using immutable journal evidence.'});
  }catch(e){res.status(500).json({error:e.message});}
});

module.exports=router;
