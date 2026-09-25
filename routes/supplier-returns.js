'use strict';
const express=require('express');
const router=express.Router();
const {randomUUID}=require('crypto');
const {db}=require('../database');
const {requireAnyPermission,requirePermission}=require('../lib/permissions');
const {ensureInventoryMovementValuation,removeFromPool}=require('../lib/inventory-movement-valuation');
const {STATUSES,ensureInventoryStockStatus,getAvailableQty}=require('../lib/inventory-stock-status');
const {normalizeInventoryQuantity}=require('../lib/inventory-quantity-precision');
const {syncBinQty}=require('../lib/binSync');
const {ensureSupplierRecoverablesSchema,nextClaimNumber,money}=require('../lib/supplier-recoverables');

let readyPromise=null;
async function ensureSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await ensureInventoryMovementValuation();
    await ensureInventoryStockStatus();
    await ensureSupplierRecoverablesSchema();
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS supplier_returns(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        return_number TEXT NOT NULL UNIQUE,
        supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
        branch_id INTEGER NOT NULL REFERENCES branches(id),
        status TEXT NOT NULL DEFAULT 'draft',
        reason TEXT NOT NULL,
        supplier_rma TEXT,
        expected_credit_amount REAL NOT NULL DEFAULT 0,
        inventory_tracked_value REAL NOT NULL DEFAULT 0,
        inventory_legacy_quantity REAL NOT NULL DEFAULT 0,
        inventory_untracked_quantity REAL NOT NULL DEFAULT 0,
        recoverable_claim_id INTEGER REFERENCES supplier_recoverable_claims(id),
        created_by_employee_id INTEGER REFERENCES employees(id),
        approved_by_employee_id INTEGER REFERENCES employees(id),
        dispatched_by_employee_id INTEGER REFERENCES employees(id),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        approved_at DATETIME,
        dispatched_at DATETIME
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS supplier_return_items(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        supplier_return_id INTEGER NOT NULL REFERENCES supplier_returns(id) ON DELETE CASCADE,
        product_id INTEGER NOT NULL REFERENCES products(id),
        quantity REAL NOT NULL,
        source_status TEXT NOT NULL DEFAULT 'available',
        expected_unit_credit REAL NOT NULL DEFAULT 0,
        expected_line_credit REAL NOT NULL DEFAULT 0,
        tracked_quantity REAL NOT NULL DEFAULT 0,
        tracked_value REAL NOT NULL DEFAULT 0,
        legacy_quantity REAL NOT NULL DEFAULT 0,
        untracked_quantity REAL NOT NULL DEFAULT 0,
        source_purchase_receipt_item_id INTEGER REFERENCES purchase_receipt_items(id),
        notes TEXT
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS supplier_return_events(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        supplier_return_id INTEGER NOT NULL REFERENCES supplier_returns(id),
        event_type TEXT NOT NULL,
        actor_employee_id INTEGER REFERENCES employees(id),
        details_json TEXT NOT NULL DEFAULT '{}',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:'CREATE INDEX IF NOT EXISTS idx_supplier_returns_status ON supplier_returns(status,branch_id,supplier_id)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_supplier_return_items_return ON supplier_return_items(supplier_return_id)'}
    ],'write');
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
function actor(req){return req.employee?.id||req.user?.employee_id||null;}
function returnNumber(){return 'SRT-'+randomUUID().replaceAll('-','').slice(0,12).toUpperCase();}
async function detail(id,executor=db){
  const {rows:[row]}=await executor.execute({sql:`SELECT r.*,s.name supplier_name,b.name branch_name
    FROM supplier_returns r JOIN suppliers s ON s.id=r.supplier_id JOIN branches b ON b.id=r.branch_id WHERE r.id=?`,args:[id]});
  if(!row)return null;
  const {rows:items}=await executor.execute({sql:`SELECT i.*,p.name product_name,p.sku FROM supplier_return_items i
    JOIN products p ON p.id=i.product_id WHERE i.supplier_return_id=? ORDER BY i.id`,args:[id]});
  return {...row,items};
}
router.use(requireAnyPermission('purchasing','purchasing_receive','purchasing_approve','reports_financial'));
router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Supplier return initialization failed'});}});

router.get('/',async(req,res)=>{
  try{
    const {rows}=await db.execute({sql:`SELECT r.*,s.name supplier_name,b.name branch_name
      FROM supplier_returns r JOIN suppliers s ON s.id=r.supplier_id JOIN branches b ON b.id=r.branch_id
      ORDER BY r.id DESC LIMIT 300`,args:[]});
    res.json(rows);
  }catch(e){res.status(500).json({error:e.message});}
});

router.get('/:id',async(req,res)=>{
  try{const row=await detail(req.params.id);if(!row)return res.status(404).json({error:'Supplier return not found'});res.json(row);}
  catch(e){res.status(500).json({error:e.message});}
});

router.post('/',requirePermission('purchasing'),async(req,res)=>{
  try{
    const supplierId=Number(req.body?.supplier_id),branchId=Number(req.body?.branch_id);
    const reason=String(req.body?.reason||'').trim(),items=Array.isArray(req.body?.items)?req.body.items:[];
    if(!supplierId||!branchId||reason.length<5||!items.length)return res.status(400).json({error:'Supplier, branch, meaningful reason and at least one return item are required'});
    const {rows:[supplier]}=await db.execute({sql:'SELECT id FROM suppliers WHERE id=?',args:[supplierId]});
    const {rows:[branch]}=await db.execute({sql:'SELECT id FROM branches WHERE id=?',args:[branchId]});
    if(!supplier||!branch)return res.status(404).json({error:'Supplier or branch not found'});
    const validated=[];
    for(const x of items){
      const productId=Number(x.product_id),rawQty=Number(x.quantity),unit=money(x.expected_unit_credit||0);
      const sourceStatus=String(x.source_status||'available').trim().toLowerCase();
      if(!productId||!Number.isFinite(rawQty)||rawQty<=0||!Number.isFinite(unit)||unit<0)throw new Error('Each return item requires product, positive quantity and non-negative expected credit');
      if(sourceStatus!=='available'&&!STATUSES.has(sourceStatus))throw new Error('Invalid supplier-return source stock status');
      const {rows:[product]}=await db.execute({sql:'SELECT id,name,sku FROM products WHERE id=?',args:[productId]});
      if(!product)throw new Error('Return product not found');
      const normalized=await normalizeInventoryQuantity(db,productId,rawQty,{label:'Supplier return quantity'});
      const qty=normalized.quantity;
      if(sourceStatus==='available'){
        const stock=await getAvailableQty(db,productId,branchId);
        if(stock.available+1e-9<qty)throw new Error(`Only ${stock.available} ${normalized.base_uom} of ${product.name} are available to return`);
      }else{
        const {rows:[bal]}=await db.execute({sql:'SELECT quantity FROM inventory_stock_status_balances WHERE product_id=? AND branch_id=? AND status=?',args:[productId,branchId,sourceStatus]});
        if(Number(bal?.quantity||0)+1e-9<qty)throw new Error(`Only ${Number(bal?.quantity||0)} ${normalized.base_uom} of ${product.name} are in ${sourceStatus} status`);
      }
      validated.push({product,qty,sourceStatus,unit,line:money(qty*unit),sourcePurchaseReceiptItemId:x.source_purchase_receipt_item_id?Number(x.source_purchase_receipt_item_id):null,notes:x.notes||null});
    }
    const expected=money(validated.reduce((s,x)=>s+x.line,0));
    const tx=await db.transaction('write');let committed=false;
    try{
      const n=returnNumber();
      const r=await tx.execute({sql:`INSERT INTO supplier_returns(return_number,supplier_id,branch_id,reason,supplier_rma,expected_credit_amount,created_by_employee_id)
        VALUES(?,?,?,?,?,?,?)`,args:[n,supplierId,branchId,reason,req.body?.supplier_rma||null,expected,actor(req)]});
      const id=Number(r.lastInsertRowid);
      for(const x of validated)await tx.execute({sql:`INSERT INTO supplier_return_items(supplier_return_id,product_id,quantity,source_status,expected_unit_credit,expected_line_credit,source_purchase_receipt_item_id,notes)
        VALUES(?,?,?,?,?,?,?,?)`,args:[id,x.product.id,x.qty,x.sourceStatus,x.unit,x.line,x.sourcePurchaseReceiptItemId,x.notes]});
      await tx.execute({sql:'INSERT INTO supplier_return_events(supplier_return_id,event_type,actor_employee_id,details_json) VALUES(?,?,?,?)',args:[id,'created',actor(req),JSON.stringify({expectedCreditAmount:expected})]});
      await tx.commit();committed=true;
      res.status(201).json(await detail(id));
    }catch(e){if(!committed)try{await tx.rollback();}catch{}throw e;}
  }catch(e){res.status(400).json({error:e.message});}
});

router.post('/:id/approve',requirePermission('purchasing_approve'),async(req,res)=>{
  try{
    const row=await detail(req.params.id);if(!row)return res.status(404).json({error:'Supplier return not found'});
    if(row.status!=='draft')return res.status(409).json({error:'Only draft supplier returns can be approved'});
    await db.execute({sql:`UPDATE supplier_returns SET status='approved',approved_by_employee_id=?,approved_at=CURRENT_TIMESTAMP WHERE id=?`,args:[actor(req),row.id]});
    await db.execute({sql:'INSERT INTO supplier_return_events(supplier_return_id,event_type,actor_employee_id,details_json) VALUES(?,?,?,?)',args:[row.id,'approved',actor(req),'{}']});
    res.json(await detail(row.id));
  }catch(e){res.status(400).json({error:e.message});}
});

router.post('/:id/dispatch',requirePermission('purchasing_receive'),async(req,res)=>{
  const tx=await db.transaction('write');let committed=false;
  try{
    const row=await detail(req.params.id,tx);
    if(!row)throw new Error('Supplier return not found');
    if(row.status!=='approved')throw new Error('Only approved supplier returns can be dispatched');
    let trackedValue=0,legacyQty=0,untrackedQty=0;
    for(const item of row.items){
      const sourceStatus=String(item.source_status||'available');
      if(sourceStatus==='available'){
        const stock=await getAvailableQty(tx,item.product_id,row.branch_id);
        if(stock.available+1e-9<Number(item.quantity))throw new Error(`Only ${stock.available} units of ${item.product_name} remain available to dispatch`);
      }else{
        const {rows:[bal]}=await tx.execute({sql:'SELECT quantity FROM inventory_stock_status_balances WHERE product_id=? AND branch_id=? AND status=?',args:[item.product_id,row.branch_id,sourceStatus]});
        if(Number(bal?.quantity||0)+1e-9<Number(item.quantity))throw new Error(`Only ${Number(bal?.quantity||0)} units of ${item.product_name} remain in ${sourceStatus} status`);
        await tx.execute({sql:'UPDATE inventory_stock_status_balances SET quantity=quantity-?,updated_at=CURRENT_TIMESTAMP WHERE product_id=? AND branch_id=? AND status=?',
          args:[item.quantity,item.product_id,row.branch_id,sourceStatus]});
      }
      if(item.source_purchase_receipt_item_id){
        const {rows:[source]}=await tx.execute({sql:`SELECT pri.id,pri.product_id,pr.supplier_id,pr.branch_id
          FROM purchase_receipt_items pri JOIN purchase_receipts pr ON pr.id=pri.receipt_id
          WHERE pri.id=?`,args:[item.source_purchase_receipt_item_id]});
        if(!source||Number(source.product_id)!==Number(item.product_id)||Number(source.supplier_id)!==Number(row.supplier_id)||Number(source.branch_id||0)!==Number(row.branch_id||0)){
          throw new Error(`Receipt evidence for ${item.product_name} does not match this supplier return`);
        }
      }
      const comp=await removeFromPool(tx,item.product_id,Number(row.branch_id),Number(item.quantity),'supplier_return',item.id);
      trackedValue=money(trackedValue+Number(comp.value||0));
      legacyQty=Number((legacyQty+Number(comp.legacy||0)).toFixed(4));
      untrackedQty=Number((untrackedQty+Number(comp.shortage||0)).toFixed(4));
      await tx.execute({sql:`UPDATE supplier_return_items SET tracked_quantity=?,tracked_value=?,legacy_quantity=?,untracked_quantity=? WHERE id=?`,
        args:[comp.tracked,comp.value,comp.legacy,comp.shortage,item.id]});
      await tx.execute({sql:'UPDATE branch_inventory SET stock_qty=stock_qty-?,updated_at=CURRENT_TIMESTAMP WHERE product_id=? AND branch_id=?',
        args:[item.quantity,item.product_id,row.branch_id]});
      await syncBinQty(tx,item.product_id,row.branch_id,-Number(item.quantity));
      await tx.execute({sql:'UPDATE products SET stock_qty=MAX(0,stock_qty-?) WHERE id=?',args:[item.quantity,item.product_id]});
      await tx.execute({sql:`INSERT INTO stock_movements(product_id,branch_id,quantity_change,type,reference,reason)
        VALUES(?,?,?,?,?,?)`,args:[item.product_id,row.branch_id,-Number(item.quantity),'supplier_return',row.return_number,`Returned to supplier ${row.supplier_name}: ${row.reason}`]});
    }

    const {rows:[branchCurrency]}=await tx.execute({sql:'SELECT currency FROM branches WHERE id=?',args:[row.branch_id]});
    const claimNumber=await nextClaimNumber();
    const claimInsert=await tx.execute({sql:`INSERT INTO supplier_recoverable_claims(
      claim_number,supplier_id,branch_id,claim_type,status,source_type,source_id,source_reference,currency,
      identified_amount,obligation_date,owner_employee_id,notes,evidence_json
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:[
      claimNumber,row.supplier_id,row.branch_id,'supplier_return','identified','supplier_return',String(row.id),row.return_number,branchCurrency?.currency||null,
      money(row.expected_credit_amount),new Date().toISOString(),actor(req),row.reason,
      JSON.stringify({supplierReturnNumber:row.return_number,supplierRma:row.supplier_rma||null,expectedCreditAmount:money(row.expected_credit_amount),inventoryTrackedValue:trackedValue,legacyQuantity:legacyQty,untrackedQuantity:untrackedQty})
    ]});
    const claimId=Number(claimInsert.lastInsertRowid);
    await tx.execute({sql:`UPDATE supplier_returns SET status='dispatched',dispatched_by_employee_id=?,dispatched_at=CURRENT_TIMESTAMP,
      inventory_tracked_value=?,inventory_legacy_quantity=?,inventory_untracked_quantity=?,recoverable_claim_id=? WHERE id=?`,
      args:[actor(req),trackedValue,legacyQty,untrackedQty,claimId,row.id]});
    await tx.execute({sql:'INSERT INTO supplier_return_events(supplier_return_id,event_type,actor_employee_id,details_json) VALUES(?,?,?,?)',
      args:[row.id,'dispatched',actor(req),JSON.stringify({claimId,claimNumber,trackedInventoryValue:trackedValue,legacyQuantity:legacyQty,untrackedQuantity:untrackedQty})]});
    await tx.commit();committed=true;
    res.json(await detail(row.id));
  }catch(e){if(!committed)try{await tx.rollback();}catch{}res.status(400).json({error:e.message});}
});

module.exports=router;
module.exports.ensureSchema=ensureSchema;
