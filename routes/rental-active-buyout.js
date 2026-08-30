'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requireAnyPermission}=require('../lib/permissions');
const {feeFor}=require('../lib/rentals');
const {nextNumber}=require('../lib/nextNumber');
const {ensureInventoryMovementValuation,valueStockAdjustment}=require('../lib/inventory-movement-valuation');
const {ensureLedger,postSourceJournal}=require('../lib/accounting-posting');

let readyPromise=null;
const money=v=>Number(Number(v||0).toFixed(2));
async function ensureColumn(table,name,definition){const {rows}=await db.execute({sql:`PRAGMA table_info(${table})`,args:[]});if(!rows.some(r=>String(r.name)===name))await db.execute({sql:`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`,args:[]});}
async function ensureSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await ensureInventoryMovementValuation();await ensureLedger();
    await ensureColumn('rental_agreement_items','quantity_sold','REAL NOT NULL DEFAULT 0');
    await ensureColumn('rental_agreements','deposit_applied_to_buyout_total','REAL NOT NULL DEFAULT 0');
    await ensureColumn('rental_agreements','buyout_closed_at','DATETIME');
    await ensureColumn('rental_agreements','buyout_transaction_id','INTEGER REFERENCES transactions(id)');
    await ensureColumn('rental_assets','sold_transaction_id','INTEGER REFERENCES transactions(id)');
    await ensureColumn('rental_assets','sold_customer_id','INTEGER REFERENCES customers(id)');
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS rental_asset_sales(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id INTEGER NOT NULL UNIQUE REFERENCES rental_assets(id),
        sale_type TEXT NOT NULL,
        customer_id INTEGER REFERENCES customers(id),
        source_agreement_id INTEGER REFERENCES rental_agreements(id),
        branch_id INTEGER NOT NULL REFERENCES branches(id),
        employee_id INTEGER REFERENCES employees(id),
        transaction_id INTEGER NOT NULL UNIQUE REFERENCES transactions(id),
        sale_price REAL NOT NULL,
        tax_amount REAL NOT NULL DEFAULT 0,
        total_collected REAL NOT NULL,
        payment_method TEXT NOT NULL,
        payment_reference TEXT,
        inventory_cost_removed REAL,
        cost_evidence_basis TEXT,
        cogs_accounting_status TEXT NOT NULL DEFAULT 'pending',
        sale_reason TEXT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS rental_asset_sale_events(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rental_asset_sale_id INTEGER NOT NULL REFERENCES rental_asset_sales(id),
        event_type TEXT NOT NULL,
        details TEXT,
        employee_id INTEGER REFERENCES employees(id),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`}
    ],'write');
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}

async function context(assetId,executor=db){
  const {rows:[row]}=await executor.execute({sql:`SELECT a.*,p.name product_name,p.sku,p.tax_rate,s.serial_number,
      aa.id allocation_id,aa.agreement_id,aa.agreement_item_id,aa.allocated_at,
      ra.agreement_number,ra.customer_id,ra.branch_id agreement_branch_id,ra.status agreement_status,ra.checkout_datetime,ra.checkout_date,ra.is_paused,ra.deposit_total,COALESCE(ra.deposit_applied_to_buyout_total,0) deposit_applied_to_buyout_total,
      rai.quantity line_quantity,rai.quantity_returned,COALESCE(rai.quantity_sold,0) quantity_sold,rai.rental_fee,rai.deposit_amount,rai.tax_rate rental_tax_rate,rai.rental_classification,rai.daily_rate,rai.weekly_rate,rai.monthly_rate,rai.hourly_rate,rai.is_mandatory
    FROM rental_assets a
    JOIN products p ON p.id=a.product_id
    LEFT JOIN inventory_serials s ON s.id=a.serial_id
    JOIN rental_asset_allocations aa ON aa.asset_id=a.id AND aa.released_at IS NULL
    JOIN rental_agreements ra ON ra.id=aa.agreement_id
    JOIN rental_agreement_items rai ON rai.id=aa.agreement_item_id
    WHERE a.id=? LIMIT 1`,args:[assetId]});
  return row||null;
}
async function pausedMs(agreementId,executor=db){const {rows}=await executor.execute({sql:'SELECT started_at,ended_at FROM rental_agreement_pauses WHERE agreement_id=? AND ended_at IS NOT NULL',args:[agreementId]});return rows.reduce((sum,p)=>sum+Math.max(0,new Date(p.ended_at)-new Date(p.started_at)),0);}
async function quote(assetId,price,executor=db){
  const c=await context(assetId,executor);if(!c)return null;
  if(String(c.agreement_status)!=='active')throw Object.assign(new Error(`Active buyout requires an active issued rental; agreement is ${c.agreement_status}.`),{status:409});
  if(Number(c.is_paused))throw Object.assign(new Error('Resume the rental before calculating an active buyout.'),{status:409});
  if(['lost','sold','disposed'].includes(String(c.status)))throw Object.assign(new Error(`A ${c.status} rental asset cannot be bought out.`),{status:409});
  const {rows:[prior]}=await executor.execute({sql:'SELECT id,transaction_id FROM rental_asset_sales WHERE asset_id=?',args:[assetId]});if(prior)throw Object.assign(new Error('This rental asset has already been sold.'),{status:409});
  const {rows:[other]}=await executor.execute({sql:`SELECT COALESCE(SUM(MAX(0,quantity-quantity_returned)),0) outstanding FROM rental_agreement_items WHERE agreement_id=? AND id<>?`,args:[c.agreement_id,c.agreement_item_id]});
  const sameLineOutstanding=Math.max(0,Number(c.line_quantity||0)-Number(c.quantity_returned||0));
  if(sameLineOutstanding!==1||Number(other?.outstanding||0)>0)throw Object.assign(new Error('Active buyout currently requires the selected asset to be the final unresolved rental unit on the agreement. Return or otherwise resolve the remaining units first.'),{status:409,control:'active_buyout_final_unit_required'});
  const checkout=new Date(c.checkout_datetime||`${c.checkout_date}T00:00:00.000Z`);if(Number.isNaN(checkout.getTime()))throw Object.assign(new Error('Rental checkout time evidence is missing.'),{status:409});
  const now=new Date(),effectiveNow=new Date(Math.max(checkout.getTime(),now.getTime()-await pausedMs(c.agreement_id,executor)));
  const actualFee=c.is_mandatory?0:feeFor({rental_classification:c.rental_classification,rental_rate:c.daily_rate,rental_weekly_rate:c.weekly_rate,rental_monthly_rate:c.monthly_rate,rental_hourly_rate:c.hourly_rate},1,checkout,effectiveNow);
  const originalFeePerUnit=Number(c.line_quantity||0)>0?Number(c.rental_fee||0)/Number(c.line_quantity):0;
  const durationAdjustment=money(actualFee-originalFeePerUnit);
  const rentalTaxAdjustment=money(durationAdjustment*Number(c.rental_tax_rate||0)/100);
  const originalDepositPerUnit=Number(c.line_quantity||0)>0?Number(c.deposit_amount||0)/Number(c.line_quantity):0;
  const depositRemaining=Math.max(0,money(Number(c.deposit_total||0)-Number(c.deposit_applied_to_buyout_total||0)));
  const depositApplied=Math.min(depositRemaining,Math.max(0,money(originalDepositPerUnit)));
  const salePrice=Number(price);const validPrice=Number.isFinite(salePrice)&&salePrice>0?salePrice:null;
  const saleTax=validPrice==null?null:money(salePrice*Number(c.tax_rate||0)/100);
  const amountDue=validPrice==null?null:money(salePrice+saleTax+durationAdjustment+rentalTaxAdjustment-depositApplied);
  return {asset:c,calculated_at:now.toISOString(),actual_rental_fee:money(actualFee),original_rental_fee_share:money(originalFeePerUnit),duration_adjustment:durationAdjustment,rental_tax_adjustment:rentalTaxAdjustment,deposit_available:depositRemaining,deposit_applied:depositApplied,sale_price:validPrice,sale_tax:saleTax,amount_due_now:amountDue,policy:'The refundable deposit share is applied once to the combined rental true-up and exact-asset purchase. The asset is never processed as a physical return.'};
}

router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Active rental buyout controls failed to initialize',detail:e.message});}});
router.get('/assets/:id/active-buyout-quote',requireAnyPermission('rentals','reports_financial'),async(req,res)=>{try{const q=await quote(Number(req.params.id),req.query.sale_price==null?NaN:Number(req.query.sale_price));if(!q)return res.status(404).json({error:'Active rental asset allocation not found'});res.json(q);}catch(e){res.status(e.status||409).json({error:e.message,control:e.control});}});

router.post('/assets/:id/active-buyout',requireAnyPermission('rentals_manage','reports_financial'),async(req,res)=>{
  try{
    const assetId=Number(req.params.id),price=Number(req.body?.sale_price),reason=String(req.body?.reason||'').trim(),method=String(req.body?.payment_method||'cash').trim().toLowerCase(),reference=String(req.body?.payment_reference||req.body?.approval_code||'').trim(),drawerId=req.body?.drawer_session_id==null?null:Number(req.body.drawer_session_id),tendered=Number(req.body?.amount_tendered);
    if(!Number.isFinite(price)||price<=0)return res.status(400).json({error:'Active rental buyout requires a sale price greater than zero.'});
    if(reason.length<5)return res.status(400).json({error:'A meaningful active-buyout reason is required.'});
    if(!['cash','card','direct_deposit','cheque','credit'].includes(method))return res.status(400).json({error:'Unsupported buyout payment method.'});
    if(['card','direct_deposit','cheque'].includes(method)&&reference.length<3)return res.status(400).json({error:'External payment/reference evidence is required for non-cash buyout settlement.'});
    const pre=await quote(assetId,price);if(!pre)return res.status(404).json({error:'Active rental asset allocation not found'});
    if(pre.amount_due_now<0)return res.status(409).json({error:'This buyout would create a net customer refund. Complete a controlled rental settlement first, then process the asset sale.',control:'active_buyout_negative_settlement'});
    const employeeId=Number(req.employee?.id)||null;
    if(method==='cash'){
      if(!employeeId||!drawerId)return res.status(409).json({error:'Cash active buyout requires the authenticated cashier and an open drawer session.'});
      if(!Number.isFinite(tendered)||tendered+0.009<pre.amount_due_now)return res.status(409).json({error:`Cash tendered cannot be less than ${pre.amount_due_now.toFixed(2)}.`});
      const {rows:[d]}=await db.execute({sql:'SELECT id,employee_id,branch_id,status FROM drawer_sessions WHERE id=?',args:[drawerId]});if(!d||d.status!=='open'||Number(d.employee_id)!==employeeId||Number(d.branch_id)!==Number(pre.asset.branch_id))return res.status(409).json({error:'Selected drawer must be open, belong to this cashier, and belong to the rental branch.'});
    }
    if(method==='credit'){
      const {rows:[cust]}=await db.execute({sql:'SELECT customer_type,account_blocked,account_balance,credit_limit FROM customers WHERE id=?',args:[pre.asset.customer_id]});if(!cust||cust.customer_type!=='credit'||cust.account_blocked)return res.status(409).json({error:'Customer is not eligible for charge-account buyout.'});if(Number(cust.credit_limit||0)>0&&Number(cust.account_balance||0)+pre.amount_due_now>Number(cust.credit_limit)+0.009)return res.status(409).json({error:'Active buyout would exceed the customer credit limit.'});
    }
    const tx=await db.transaction('write');let committed=false;
    try{
      const q=await quote(assetId,price,tx),a=q.asset;
      const {rows:[bi]}=await tx.execute({sql:'SELECT stock_qty FROM branch_inventory WHERE product_id=? AND branch_id=?',args:[a.product_id,a.branch_id]});const physicalBefore=Number(bi?.stock_qty||0);if(physicalBefore<1)throw Object.assign(new Error('Branch inventory no longer contains this physical rental asset.'),{status:409});
      const transactionNumber=await nextNumber(tx,'transactions','transaction_number','TXN-',6),change=method==='cash'?money(Math.max(0,tendered-q.amount_due_now)):0;
      const subtotal=money(price+q.duration_adjustment-q.deposit_applied),tax=money(q.sale_tax+q.rental_tax_adjustment),total=q.amount_due_now;
      const tr=await tx.execute({sql:`INSERT INTO transactions(transaction_number,customer_id,employee_id,branch_id,drawer_session_id,subtotal,tax_amount,total,payment_method,amount_tendered,change_amount,notes,status,source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:[transactionNumber,a.customer_id,employeeId,a.branch_id,method==='cash'?drawerId:null,subtotal,tax,total,method,method==='cash'?tendered:(method==='credit'?0:total),change,`Active rental buyout ${a.asset_number}: ${reason}`,'completed','rental_active_buyout']});const transactionId=Number(tr.lastInsertRowid);
      if(q.duration_adjustment!==0)await tx.execute({sql:`INSERT INTO transaction_items(transaction_id,product_name,sku,quantity,unit_price,tax_amount,total) VALUES(?,?,?,?,?,?,?)`,args:[transactionId,q.duration_adjustment>0?'Additional Rental Time':'Rental Fee Credit','DURATION-ADJ',1,q.duration_adjustment,q.rental_tax_adjustment,q.duration_adjustment]});
      if(q.deposit_applied>0)await tx.execute({sql:`INSERT INTO transaction_items(transaction_id,product_name,sku,quantity,unit_price,tax_amount,total) VALUES(?,?,?,?,?,?,?)`,args:[transactionId,'Rental Deposit Applied to Buyout','DEPOSIT-BUYOUT',1,-q.deposit_applied,0,-q.deposit_applied]});
      await tx.execute({sql:`INSERT INTO transaction_items(transaction_id,product_id,product_name,sku,quantity,unit_price,tax_amount,total) VALUES(?,?,?,?,1,?,?,?)`,args:[transactionId,a.product_id,`Used Fleet Asset Buyout — ${a.product_name}${a.serial_number?` — Serial ${a.serial_number}`:''}`,`FLEET-${a.asset_number}`,price,q.sale_tax,price]});
      if(method==='credit')await tx.execute({sql:'UPDATE customers SET account_balance=account_balance+? WHERE id=?',args:[total,a.customer_id]});
      const sm=await tx.execute({sql:`INSERT INTO stock_movements(product_id,branch_id,quantity_change,type,reference,reason) VALUES(?,?,?,?,?,?)`,args:[a.product_id,a.branch_id,-1,'rental_active_buyout',transactionNumber,`Customer bought out rental asset ${a.asset_number}${a.serial_number?` / ${a.serial_number}`:''}`]});const movementId=Number(sm.lastInsertRowid);
      await tx.execute({sql:'UPDATE branch_inventory SET stock_qty=stock_qty-1,updated_at=CURRENT_TIMESTAMP WHERE product_id=? AND branch_id=?',args:[a.product_id,a.branch_id]});
      await tx.execute({sql:'UPDATE products SET stock_qty=(SELECT COALESCE(SUM(stock_qty),0) FROM branch_inventory WHERE product_id=?) WHERE id=?',args:[a.product_id,a.product_id]});
      await valueStockAdjustment(tx,{stockMovementId:movementId,productId:a.product_id,branchKey:a.branch_id,quantityChange:-1,reason:`Active rental buyout ${a.asset_number}`,physicalBefore});
      const {rows:[val]}=await tx.execute({sql:'SELECT tracked_value FROM inventory_adjustment_valuations WHERE stock_movement_id=?',args:[movementId]});let cost=money(val?.tracked_value||0),basis=cost>0?'tracked_inventory_pool':null,cogsStatus='blocked_missing_cost_evidence';if(cost<=0&&String(a.acquisition_evidence_grade)==='complete'&&Number(a.acquisition_cost)>=0){cost=money(a.acquisition_cost);basis='complete_asset_acquisition_evidence';}
      const debitCode=method==='cash'?'1000':method==='credit'?'1100':'1010',lines=[];
      if(total>0)lines.push({code:debitCode,debit:total,credit:0,description:method==='credit'?'Customer receivable for active rental buyout':'Active rental buyout proceeds'});
      if(q.deposit_applied>0)lines.push({code:'2200',debit:q.deposit_applied,credit:0,description:'Apply refundable rental deposit to asset buyout'});
      if(q.duration_adjustment>0)lines.push({code:'4200',debit:0,credit:q.duration_adjustment,description:'Additional rental time through buyout'});else if(q.duration_adjustment<0)lines.push({code:'4200',debit:Math.abs(q.duration_adjustment),credit:0,description:'Rental time credit through buyout'});
      lines.push({code:'4000',debit:0,credit:price,description:'Used rental fleet asset buyout revenue'});
      const totalTax=money(q.sale_tax+q.rental_tax_adjustment);if(totalTax>0)lines.push({code:'2100',debit:0,credit:totalTax,description:'Tax payable on active rental buyout'});else if(totalTax<0)lines.push({code:'2100',debit:Math.abs(totalTax),credit:0,description:'Reverse excess rental tax at buyout'});
      await postSourceJournal({sourceType:'rental_active_buyout',sourceId:assetId,sourceReference:transactionNumber,entryDate:new Date().toISOString().slice(0,10),description:`Active buyout of rental asset ${a.asset_number}`,branchId:a.branch_id,actorId:employeeId,executor:tx,lines});
      if(cost>0){await postSourceJournal({sourceType:'rental_active_buyout_cogs',sourceId:assetId,sourceReference:transactionNumber,entryDate:new Date().toISOString().slice(0,10),description:`Cost removal for active buyout ${a.asset_number}`,branchId:a.branch_id,actorId:employeeId,executor:tx,lines:[{code:'5000',debit:cost,credit:0,description:'Cost of sold rental fleet asset'},{code:'1200',debit:0,credit:cost,description:'Remove bought-out rental asset from inventory'}]});cogsStatus='posted';}
      await tx.execute({sql:`UPDATE rental_agreement_items SET quantity_returned=quantity_returned+1,quantity_sold=COALESCE(quantity_sold,0)+1,final_rental_fee=final_rental_fee+? WHERE id=?`,args:[q.actual_rental_fee,a.agreement_item_id]});
      await tx.execute({sql:`UPDATE rental_asset_allocations SET released_at=CURRENT_TIMESTAMP,release_reason=? WHERE id=? AND released_at IS NULL`,args:[`Active customer buyout ${transactionNumber}`,a.allocation_id]});
      await tx.execute({sql:`UPDATE rental_agreements SET deposit_applied_to_buyout_total=COALESCE(deposit_applied_to_buyout_total,0)+?,buyout_closed_at=CURRENT_TIMESTAMP,buyout_transaction_id=?,status='returned',returned_at=CURRENT_TIMESTAMP WHERE id=?`,args:[q.deposit_applied,transactionId,a.agreement_id]});
      if(a.serial_id)await tx.execute({sql:`UPDATE inventory_serials SET status='sold',updated_at=CURRENT_TIMESTAMP WHERE id=?`,args:[a.serial_id]});
      await tx.execute({sql:`UPDATE rental_assets SET status='sold',sold_transaction_id=?,sold_customer_id=?,disposal_date=date('now'),disposal_value=?,disposal_reason=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`,args:[transactionId,a.customer_id,price,`customer_buyout:${reason}`,assetId]});
      const sr=await tx.execute({sql:`INSERT INTO rental_asset_sales(asset_id,sale_type,customer_id,source_agreement_id,branch_id,employee_id,transaction_id,sale_price,tax_amount,total_collected,payment_method,payment_reference,inventory_cost_removed,cost_evidence_basis,cogs_accounting_status,sale_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:[assetId,'customer_buyout',a.customer_id,a.agreement_id,a.branch_id,employeeId,transactionId,price,q.sale_tax,total,method,reference||null,cost||null,basis,cogsStatus,reason]});const saleId=Number(sr.lastInsertRowid);
      await tx.execute({sql:`INSERT INTO rental_asset_sale_events(rental_asset_sale_id,event_type,details,employee_id) VALUES(?,?,?,?)`,args:[saleId,'active_buyout',JSON.stringify({agreement_id:a.agreement_id,agreement_number:a.agreement_number,transaction_number:transactionNumber,duration_adjustment:q.duration_adjustment,rental_tax_adjustment:q.rental_tax_adjustment,deposit_applied:q.deposit_applied,sale_price:price,sale_tax:q.sale_tax,total}),employeeId]});
      try{await tx.execute({sql:`INSERT INTO rental_asset_lifecycle_events(asset_id,event_type,from_status,to_status,reason,disposition,evidence_ref,employee_id) VALUES(?,?,?,?,?,?,?,?)`,args:[assetId,'sold_via_active_buyout',a.status,'sold',reason,'customer_buyout',transactionNumber,employeeId]});}catch(_){}
      await tx.commit();committed=true;
      res.status(201).json({success:true,sale_id:saleId,transaction_id:transactionId,transaction_number:transactionNumber,asset_id:assetId,agreement_id:a.agreement_id,customer_id:a.customer_id,sale_price:price,sale_tax:q.sale_tax,duration_adjustment:q.duration_adjustment,rental_tax_adjustment:q.rental_tax_adjustment,deposit_applied:q.deposit_applied,total_collected:total,cogs_accounting_status:cogsStatus,cost_evidence_basis:basis});
    }catch(e){if(!committed)await tx.rollback();throw e;}
  }catch(e){res.status(e.status||409).json({error:e.message,control:e.control});}
});

module.exports=router;
module.exports.ensureSchema=ensureSchema;
