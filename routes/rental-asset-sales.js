'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requireAnyPermission}=require('../lib/permissions');
const {nextNumber}=require('../lib/nextNumber');
const {ensureInventoryMovementValuation,valueStockAdjustment}=require('../lib/inventory-movement-valuation');
const {ensureLedger,postSourceJournal}=require('../lib/accounting-posting');

let readyPromise=null;
const m=v=>Number(Number(v||0).toFixed(2));
async function ensureColumn(table,name,definition){const {rows}=await db.execute({sql:`PRAGMA table_info(${table})`,args:[]});if(!rows.some(r=>String(r.name)===name))await db.execute({sql:`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`,args:[]});}
async function ensureSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await ensureInventoryMovementValuation();await ensureLedger();
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
      {sql:'CREATE INDEX IF NOT EXISTS idx_rental_asset_sales_customer ON rental_asset_sales(customer_id,created_at)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_rental_asset_sales_branch ON rental_asset_sales(branch_id,created_at)'},
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
async function asset(id,executor=db){const {rows:[a]}=await executor.execute({sql:`SELECT a.*,p.name product_name,p.sku,p.tax_rate,s.serial_number,s.unit_cost serial_unit_cost FROM rental_assets a JOIN products p ON p.id=a.product_id LEFT JOIN inventory_serials s ON s.id=a.serial_id WHERE a.id=?`,args:[id]});return a||null;}
async function readiness(id){
  const a=await asset(id);if(!a)return null;
  const {rows:[allocation]}=await db.execute({sql:'SELECT aa.*,ra.customer_id,ra.agreement_number,ra.status agreement_status FROM rental_asset_allocations aa JOIN rental_agreements ra ON ra.id=aa.agreement_id WHERE aa.asset_id=? AND aa.released_at IS NULL LIMIT 1',args:[id]});
  const {rows:[maintenance]}=await db.execute({sql:'SELECT id,maintenance_type,started_at FROM rental_asset_maintenance WHERE asset_id=? AND ended_at IS NULL LIMIT 1',args:[id]});
  const {rows:[priorSale]}=await db.execute({sql:'SELECT id,transaction_id FROM rental_asset_sales WHERE asset_id=?',args:[id]});
  return {asset:a,open_allocation:allocation||null,open_maintenance:maintenance||null,prior_sale:priorSale||null,ready:String(a.status)==='awaiting_sale'&&!allocation&&!maintenance&&!priorSale};
}
router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Rental fleet-sale controls failed to initialize',detail:e.message});}});

router.get('/assets/:id/sale-readiness',requireAnyPermission('rentals','reports_financial'),async(req,res)=>{
  try{const r=await readiness(Number(req.params.id));if(!r)return res.status(404).json({error:'Rental asset not found'});res.json({...r,policy:'Only company-owned assets explicitly placed in awaiting_sale may be sold. A posted sale permanently ends rental availability.'});}catch(e){res.status(500).json({error:e.message});}
});

router.post('/assets/:id/sell',requireAnyPermission('rentals_manage','reports_financial'),async(req,res)=>{
  try{
    const assetId=Number(req.params.id),saleType=String(req.body?.sale_type||'fleet_sale').trim().toLowerCase(),reason=String(req.body?.reason||'').trim();
    const customerId=req.body?.customer_id==null?null:Number(req.body.customer_id),sourceAgreementId=req.body?.source_agreement_id==null?null:Number(req.body.source_agreement_id);
    const price=Number(req.body?.sale_price),method=String(req.body?.payment_method||'cash').trim().toLowerCase(),reference=String(req.body?.payment_reference||req.body?.approval_code||'').trim();
    const tendered=Number(req.body?.amount_tendered),drawerSessionId=req.body?.drawer_session_id==null?null:Number(req.body.drawer_session_id);
    if(!['fleet_sale','customer_buyout'].includes(saleType))return res.status(400).json({error:'sale_type must be fleet_sale or customer_buyout'});
    if(!Number.isFinite(price)||price<0)return res.status(400).json({error:'A non-negative fleet sale price is required'});
    if(reason.length<5)return res.status(400).json({error:'A meaningful fleet sale/buyout reason is required'});
    if(!['cash','card','direct_deposit','cheque','credit'].includes(method))return res.status(400).json({error:'Unsupported fleet-sale payment method'});
    if(saleType==='customer_buyout'&&!customerId)return res.status(400).json({error:'Customer buyout requires the purchasing customer'});
    if(['card','direct_deposit','cheque'].includes(method)&&reference.length<3)return res.status(400).json({error:'External payment/reference evidence is required for non-cash fleet sale settlement'});
    const r=await readiness(assetId);if(!r)return res.status(404).json({error:'Rental asset not found'});
    if(r.prior_sale)return res.status(409).json({error:'Rental asset has already been sold',transaction_id:r.prior_sale.transaction_id});
    if(String(r.asset.status)!=='awaiting_sale')return res.status(409).json({error:`Rental asset must be placed in awaiting_sale before sale; current status is ${r.asset.status}.`});
    if(r.open_allocation)return res.status(409).json({error:'Rental asset cannot be sold while allocated to an unresolved rental'});
    if(r.open_maintenance)return res.status(409).json({error:'Complete or formally close maintenance before selling this asset'});
    if(customerId){const {rows:[c]}=await db.execute({sql:'SELECT id,customer_type,account_blocked,account_balance,credit_limit FROM customers WHERE id=?',args:[customerId]});if(!c)return res.status(404).json({error:'Customer not found'});if(method==='credit'){if(c.customer_type!=='credit'||c.account_blocked)return res.status(409).json({error:'Customer is not eligible for charge-account fleet purchase'});}}
    if(saleType==='customer_buyout'&&sourceAgreementId){const {rows:[history]}=await db.execute({sql:`SELECT aa.id,ra.customer_id FROM rental_asset_allocations aa JOIN rental_agreements ra ON ra.id=aa.agreement_id WHERE aa.asset_id=? AND aa.agreement_id=? LIMIT 1`,args:[assetId,sourceAgreementId]});if(!history||Number(history.customer_id)!==customerId)return res.status(409).json({error:'Customer buyout source agreement does not prove this customer previously held this exact rental asset'});}
    const tax=m(price*Number(r.asset.tax_rate||0)/100),total=m(price+tax);
    if(method==='cash'){
      const employeeId=Number(req.employee?.id||req.body?.employee_id)||null;if(!employeeId||!drawerSessionId)return res.status(409).json({error:'Cash fleet sale requires the authenticated cashier and an open drawer session'});
      if(!Number.isFinite(tendered)||tendered+0.009<total)return res.status(409).json({error:`Cash tendered cannot be less than ${total.toFixed(2)}`});
      const {rows:[d]}=await db.execute({sql:'SELECT id,employee_id,branch_id,status FROM drawer_sessions WHERE id=?',args:[drawerSessionId]});if(!d||d.status!=='open'||Number(d.employee_id)!==employeeId||Number(d.branch_id)!==Number(r.asset.branch_id))return res.status(409).json({error:'Selected cash drawer must be open, belong to this cashier, and belong to the rental asset branch'});
    }
    if(method==='credit'){
      if(!customerId)return res.status(400).json({error:'Charge-account fleet sale requires a customer'});
      const {rows:[c]}=await db.execute({sql:'SELECT account_balance,credit_limit FROM customers WHERE id=?',args:[customerId]});if(Number(c?.credit_limit||0)>0&&Number(c.account_balance||0)+total>Number(c.credit_limit)+0.009)return res.status(409).json({error:'Fleet sale would exceed the customer credit limit'});
    }
    const tx=await db.transaction('write');let committed=false;
    try{
      const a=await asset(assetId,tx);if(!a||String(a.status)!=='awaiting_sale')throw Object.assign(new Error('Rental asset status changed before sale; reload and review.'),{status:409});
      const {rows:[open]}=await tx.execute({sql:'SELECT id FROM rental_asset_allocations WHERE asset_id=? AND released_at IS NULL LIMIT 1',args:[assetId]});if(open)throw Object.assign(new Error('Rental asset became allocated before sale and cannot be sold.'),{status:409});
      const {rows:[bi]}=await tx.execute({sql:'SELECT stock_qty FROM branch_inventory WHERE product_id=? AND branch_id=?',args:[a.product_id,a.branch_id]});const physicalBefore=Number(bi?.stock_qty||0);if(physicalBefore<1)throw Object.assign(new Error('Branch inventory no longer contains this rental asset as recorded physical stock.'),{status:409});
      const transactionNumber=await nextNumber(tx,'transactions','transaction_number','TXN-',6);
      const change=method==='cash'?m(Math.max(0,tendered-total)):0;
      const tr=await tx.execute({sql:`INSERT INTO transactions(transaction_number,customer_id,employee_id,branch_id,drawer_session_id,subtotal,tax_amount,total,payment_method,amount_tendered,change_amount,notes,status,source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:[transactionNumber,customerId,req.employee?.id||null,a.branch_id,method==='cash'?drawerSessionId:null,price,tax,total,method,method==='cash'?tendered:(method==='credit'?0:total),change,`${saleType==='customer_buyout'?'Rental customer buyout':'Rental fleet asset sale'} ${a.asset_number}: ${reason}`,'completed','rental_fleet_sale']});
      const transactionId=Number(tr.lastInsertRowid);
      await tx.execute({sql:`INSERT INTO transaction_items(transaction_id,product_id,product_name,sku,quantity,unit_price,discount_amount,tax_amount,total) VALUES(?,?,?,?,1,?,0,?,?)`,args:[transactionId,a.product_id,`Used Fleet Asset — ${a.product_name}${a.serial_number?` — Serial ${a.serial_number}`:''}`,`FLEET-${a.asset_number}`,price,tax,price]});
      if(method==='credit')await tx.execute({sql:'UPDATE customers SET account_balance=account_balance+? WHERE id=?',args:[total,customerId]});
      const sm=await tx.execute({sql:`INSERT INTO stock_movements(product_id,branch_id,quantity_change,type,reference,reason) VALUES(?,?,?,?,?,?)`,args:[a.product_id,a.branch_id,-1,'rental_fleet_sale',transactionNumber,`Sold rental asset ${a.asset_number}${a.serial_number?` / ${a.serial_number}`:''}`]});const movementId=Number(sm.lastInsertRowid);
      await tx.execute({sql:'UPDATE branch_inventory SET stock_qty=stock_qty-1,updated_at=CURRENT_TIMESTAMP WHERE product_id=? AND branch_id=?',args:[a.product_id,a.branch_id]});
      await tx.execute({sql:'UPDATE products SET stock_qty=(SELECT COALESCE(SUM(stock_qty),0) FROM branch_inventory WHERE product_id=?) WHERE id=?',args:[a.product_id,a.product_id]});
      await valueStockAdjustment(tx,{stockMovementId:movementId,productId:a.product_id,branchKey:a.branch_id,quantityChange:-1,reason:`Rental fleet sale ${a.asset_number}`,physicalBefore});
      const {rows:[val]}=await tx.execute({sql:'SELECT tracked_value,legacy_quantity,untracked_quantity FROM inventory_adjustment_valuations WHERE stock_movement_id=?',args:[movementId]});
      let cost=m(Number(val?.tracked_value||0)),basis=cost>0?'tracked_inventory_pool':null,cogsStatus='blocked_missing_cost_evidence';
      if(cost<=0&&String(a.acquisition_evidence_grade)==='complete'&&Number(a.acquisition_cost)>=0){cost=m(a.acquisition_cost);basis='complete_asset_acquisition_evidence';}
      const cashCode=method==='cash'?'1000':method==='credit'?'1100':'1010';
      const saleLines=[{code:cashCode,debit:total,credit:0,description:method==='credit'?'Customer receivable for rental fleet asset sale':'Fleet asset sale proceeds'},{code:'4000',debit:0,credit:price,description:'Used rental fleet asset sale revenue'}];if(tax>0)saleLines.push({code:'2100',debit:0,credit:tax,description:'Tax payable on rental fleet asset sale'});
      await postSourceJournal({sourceType:'rental_asset_sale',sourceId:assetId,sourceReference:transactionNumber,entryDate:new Date().toISOString().slice(0,10),description:`Sale of rental asset ${a.asset_number}`,branchId:a.branch_id,actorId:req.employee?.id||null,executor:tx,lines:saleLines});
      if(cost>0){await postSourceJournal({sourceType:'rental_asset_sale_cogs',sourceId:assetId,sourceReference:transactionNumber,entryDate:new Date().toISOString().slice(0,10),description:`Cost removal for sold rental asset ${a.asset_number}`,branchId:a.branch_id,actorId:req.employee?.id||null,executor:tx,lines:[{code:'5000',debit:cost,credit:0,description:'Cost of sold rental fleet asset'},{code:'1200',debit:0,credit:cost,description:'Remove sold rental fleet asset from inventory'}]});cogsStatus='posted';}
      if(a.serial_id)await tx.execute({sql:`UPDATE inventory_serials SET status='sold',updated_at=CURRENT_TIMESTAMP WHERE id=?`,args:[a.serial_id]});
      await tx.execute({sql:`UPDATE rental_assets SET status='sold',sold_transaction_id=?,sold_customer_id=?,disposal_date=date('now'),disposal_value=?,disposal_reason=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`,args:[transactionId,customerId,price,`${saleType}:${reason}`,assetId]});
      const sr=await tx.execute({sql:`INSERT INTO rental_asset_sales(asset_id,sale_type,customer_id,source_agreement_id,branch_id,employee_id,transaction_id,sale_price,tax_amount,total_collected,payment_method,payment_reference,inventory_cost_removed,cost_evidence_basis,cogs_accounting_status,sale_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:[assetId,saleType,customerId,sourceAgreementId,a.branch_id,req.employee?.id||null,transactionId,price,tax,total,method,reference||null,cost||null,basis,cogsStatus,reason]});const saleId=Number(sr.lastInsertRowid);
      await tx.execute({sql:`INSERT INTO rental_asset_sale_events(rental_asset_sale_id,event_type,details,employee_id) VALUES(?,?,?,?)`,args:[saleId,'sold',JSON.stringify({asset_number:a.asset_number,serial_number:a.serial_number||null,transaction_number:transactionNumber,sale_type:saleType,sale_price:price,tax,total,cost_evidence_basis:basis,cogs_accounting_status:cogsStatus}),req.employee?.id||null]});
      try{await tx.execute({sql:`INSERT INTO rental_asset_lifecycle_events(asset_id,event_type,from_status,to_status,reason,disposition,evidence_ref,employee_id) VALUES(?,?,?,?,?,?,?,?)`,args:[assetId,'sold',a.status,'sold',reason,saleType,transactionNumber,req.employee?.id||null]});}catch(_){}
      await tx.commit();committed=true;
      res.status(201).json({success:true,sale_id:saleId,transaction_id:transactionId,transaction_number:transactionNumber,asset_id:assetId,asset_number:a.asset_number,serial_number:a.serial_number||null,sale_type:saleType,sale_price:price,tax_amount:tax,total,cogs_accounting_status:cogsStatus,cost_evidence_basis:basis,inventory_cost_removed:cost||null,status:'sold'});
    }catch(e){if(!committed)await tx.rollback();throw e;}
  }catch(e){res.status(e.status||409).json({error:e.message});}
});

router.get('/sales',requireAnyPermission('rentals','reports_financial'),async(req,res)=>{
  try{const args=[];let sql=`SELECT s.*,a.asset_number,p.name product_name,p.sku,iser.serial_number,t.transaction_number,c.first_name||' '||c.last_name customer_name,b.name branch_name FROM rental_asset_sales s JOIN rental_assets a ON a.id=s.asset_id JOIN products p ON p.id=a.product_id LEFT JOIN inventory_serials iser ON iser.id=a.serial_id JOIN transactions t ON t.id=s.transaction_id LEFT JOIN customers c ON c.id=s.customer_id LEFT JOIN branches b ON b.id=s.branch_id WHERE 1=1`;if(req.query.branch_id){sql+=' AND s.branch_id=?';args.push(req.query.branch_id);}if(req.query.customer_id){sql+=' AND s.customer_id=?';args.push(req.query.customer_id);}sql+=' ORDER BY s.created_at DESC,s.id DESC LIMIT 250';const {rows}=await db.execute({sql,args});res.json(rows);}catch(e){res.status(500).json({error:e.message});}
});

module.exports=router;
module.exports.ensureSchema=ensureSchema;
