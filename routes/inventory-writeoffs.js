'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');
const {nextNumber}=require('../lib/nextNumber');
const {ensureInventoryMovementValuation,valueStockAdjustment}=require('../lib/inventory-movement-valuation');
const {ensureInventoryStockStatus,getAvailableQty}=require('../lib/inventory-stock-status');
const {ensureLedger,postSourceJournal}=require('../lib/accounting-posting');

const REASONS=new Set(['damage','theft','shrinkage','expiration','obsolescence','destruction','other']);
const RESTRICTED=new Set(['inspection','blocked','quarantine','damaged','expired']);
let readyPromise=null;

async function ensureSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await ensureInventoryMovementValuation();
    await ensureInventoryStockStatus();
    await ensureLedger();
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS inventory_writeoffs(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        writeoff_number TEXT NOT NULL UNIQUE,
        product_id INTEGER NOT NULL REFERENCES products(id),
        branch_id INTEGER NOT NULL REFERENCES branches(id),
        bin_id INTEGER REFERENCES storage_bins(id),
        source_status TEXT NOT NULL DEFAULT 'available',
        quantity INTEGER NOT NULL,
        reason_code TEXT NOT NULL,
        reason_detail TEXT NOT NULL,
        reference TEXT,
        status TEXT NOT NULL DEFAULT 'pending_approval',
        created_by_employee_id INTEGER REFERENCES employees(id),
        approved_by_employee_id INTEGER REFERENCES employees(id),
        rejected_by_employee_id INTEGER REFERENCES employees(id),
        stock_movement_id INTEGER UNIQUE REFERENCES stock_movements(id),
        tracked_quantity REAL NOT NULL DEFAULT 0,
        tracked_value REAL NOT NULL DEFAULT 0,
        legacy_quantity REAL NOT NULL DEFAULT 0,
        untracked_quantity REAL NOT NULL DEFAULT 0,
        valuation_status TEXT NOT NULL DEFAULT 'pending',
        journal_entry_id INTEGER,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        approved_at DATETIME,
        rejected_at DATETIME,
        rejection_reason TEXT
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS inventory_writeoff_events(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        writeoff_id INTEGER NOT NULL REFERENCES inventory_writeoffs(id),
        event_type TEXT NOT NULL,
        employee_id INTEGER REFERENCES employees(id),
        details TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:'CREATE INDEX IF NOT EXISTS idx_inventory_writeoffs_status ON inventory_writeoffs(status,branch_id,created_at)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_inventory_writeoff_events ON inventory_writeoff_events(writeoff_id,created_at,id)'},
      {sql:`INSERT OR IGNORE INTO ledger_accounts(code,name,account_type,normal_balance,system_account)
            VALUES('5500','Inventory Loss & Write-offs','expense','debit',1)`}
    ],'write');
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}

function actor(req){return req.employee?.id||null;}
async function selfApprovalAllowed(){
  const {rows:[row]}=await db.execute({sql:"SELECT value FROM settings WHERE key='inventory_writeoff_allow_self_approval'",args:[]});
  return row&&['1','true','yes','on'].includes(String(row.value||'').trim().toLowerCase());
}

router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Inventory write-off controls failed to initialize',detail:e.message});}});

router.get('/',requirePermission('inventory'),async(req,res)=>{
  try{
    const args=[];let sql=`SELECT w.*,p.name product_name,p.sku,b.name branch_name,sb.bin_code,
      c.first_name||' '||c.last_name created_by_name,a.first_name||' '||a.last_name approved_by_name
      FROM inventory_writeoffs w JOIN products p ON p.id=w.product_id JOIN branches b ON b.id=w.branch_id
      LEFT JOIN storage_bins sb ON sb.id=w.bin_id LEFT JOIN employees c ON c.id=w.created_by_employee_id
      LEFT JOIN employees a ON a.id=w.approved_by_employee_id WHERE 1=1`;
    if(req.query.status){sql+=' AND w.status=?';args.push(req.query.status);}
    if(req.query.branch_id){sql+=' AND w.branch_id=?';args.push(req.query.branch_id);}
    sql+=' ORDER BY w.created_at DESC,w.id DESC LIMIT 250';
    const {rows}=await db.execute({sql,args});res.json(rows);
  }catch(e){res.status(500).json({error:e.message});}
});

router.get('/:id',requirePermission('inventory'),async(req,res)=>{
  try{
    const {rows:[row]}=await db.execute({sql:`SELECT w.*,p.name product_name,p.sku,b.name branch_name,sb.bin_code
      FROM inventory_writeoffs w JOIN products p ON p.id=w.product_id JOIN branches b ON b.id=w.branch_id
      LEFT JOIN storage_bins sb ON sb.id=w.bin_id WHERE w.id=?`,args:[req.params.id]});
    if(!row)return res.status(404).json({error:'Write-off not found'});
    const {rows:events}=await db.execute({sql:'SELECT * FROM inventory_writeoff_events WHERE writeoff_id=? ORDER BY id',args:[row.id]});
    row.events=events;res.json(row);
  }catch(e){res.status(500).json({error:e.message});}
});

router.post('/',requirePermission('inventory_writeoff_create'),async(req,res)=>{
  try{
    const productId=Number(req.body?.product_id),branchId=Number(req.body?.branch_id),binId=req.body?.bin_id?Number(req.body.bin_id):null;
    const quantity=Number(req.body?.quantity),sourceStatus=String(req.body?.source_status||'available').trim().toLowerCase();
    const reasonCode=String(req.body?.reason_code||'').trim().toLowerCase(),reasonDetail=String(req.body?.reason_detail||'').trim();
    if(!Number.isInteger(productId)||productId<=0||!Number.isInteger(branchId)||branchId<=0)return res.status(400).json({error:'product_id and branch_id are required'});
    if(!Number.isInteger(quantity)||quantity<=0)return res.status(400).json({error:'Write-off quantity must be a positive whole number'});
    if(!REASONS.has(reasonCode))return res.status(400).json({error:'A valid write-off reason code is required'});
    if(reasonDetail.length<3)return res.status(400).json({error:'Write-off reason detail is required'});
    if(sourceStatus!=='available'&&!RESTRICTED.has(sourceStatus))return res.status(400).json({error:'Invalid source stock status'});
    const {rows:[product]}=await db.execute({sql:'SELECT * FROM products WHERE id=? AND active=1',args:[productId]});
    if(!product||product.is_service||product.is_non_inventory)return res.status(409).json({error:'Selected product is not eligible for physical inventory write-off'});
    const {rows:[branch]}=await db.execute({sql:'SELECT id FROM branches WHERE id=? AND active=1',args:[branchId]});
    if(!branch)return res.status(400).json({error:'Selected branch is unavailable'});
    const {rows:bins}=await db.execute({sql:'SELECT id,bin_id,quantity FROM product_bin_assignments WHERE product_id=? AND branch_id=? ORDER BY is_primary DESC,id',args:[productId,branchId]});
    if(bins.length&&!binId)return res.status(409).json({error:'This product is bin-controlled at the branch; select the exact bin being written off'});
    if(binId){
      const bin=bins.find(x=>String(x.bin_id)===String(binId));
      if(!bin)return res.status(409).json({error:'Selected bin does not contain this product at the branch'});
      if(Number(bin.quantity||0)<quantity)return res.status(409).json({error:`Selected bin contains only ${Number(bin.quantity||0)} units`});
    }
    if(sourceStatus==='available'){
      const state=await getAvailableQty(db,productId,branchId);
      if(state.available<quantity)return res.status(409).json({error:`Only ${state.available} units are available to write off`});
    }else{
      const {rows:[bal]}=await db.execute({sql:'SELECT quantity FROM inventory_stock_status_balances WHERE product_id=? AND branch_id=? AND status=?',args:[productId,branchId,sourceStatus]});
      if(Number(bal?.quantity||0)<quantity)return res.status(409).json({error:`Only ${Number(bal?.quantity||0)} units are in ${sourceStatus} status`});
    }
    const number=await nextNumber(db,'inventory_writeoffs','writeoff_number','WOFF-',6);
    const tx=await db.transaction('write');let committed=false;
    try{
      const r=await tx.execute({sql:`INSERT INTO inventory_writeoffs(writeoff_number,product_id,branch_id,bin_id,source_status,quantity,reason_code,reason_detail,reference,created_by_employee_id)
        VALUES(?,?,?,?,?,?,?,?,?,?)`,args:[number,productId,branchId,binId,sourceStatus,quantity,reasonCode,reasonDetail,req.body?.reference||null,actor(req)]});
      const id=Number(r.lastInsertRowid);
      await tx.execute({sql:'INSERT INTO inventory_writeoff_events(writeoff_id,event_type,employee_id,details) VALUES(?,?,?,?)',args:[id,'submitted',actor(req),`${reasonCode}: ${reasonDetail}`]});
      await tx.commit();committed=true;
      const {rows:[row]}=await db.execute({sql:'SELECT * FROM inventory_writeoffs WHERE id=?',args:[id]});res.status(201).json(row);
    }catch(e){if(!committed)await tx.rollback();throw e;}
  }catch(e){res.status(500).json({error:e.message});}
});

router.post('/:id/reject',requirePermission('inventory_writeoff_approve'),async(req,res)=>{
  try{
    const reason=String(req.body?.reason||'').trim();if(reason.length<3)return res.status(400).json({error:'A rejection reason is required'});
    const r=await db.execute({sql:`UPDATE inventory_writeoffs SET status='rejected',rejected_by_employee_id=?,rejected_at=CURRENT_TIMESTAMP,rejection_reason=? WHERE id=? AND status='pending_approval'`,args:[actor(req),reason,req.params.id]});
    if(!Number(r.rowsAffected||0))return res.status(409).json({error:'Write-off is not pending approval'});
    await db.execute({sql:'INSERT INTO inventory_writeoff_events(writeoff_id,event_type,employee_id,details) VALUES(?,?,?,?)',args:[req.params.id,'rejected',actor(req),reason]});
    res.json({success:true,status:'rejected'});
  }catch(e){res.status(500).json({error:e.message});}
});

router.post('/:id/approve',requirePermission('inventory_writeoff_approve'),async(req,res)=>{
  try{
    const tx=await db.transaction('write');let committed=false;
    try{
      const {rows:[w]}=await tx.execute({sql:'SELECT * FROM inventory_writeoffs WHERE id=?',args:[req.params.id]});
      if(!w)throw Object.assign(new Error('Write-off not found'),{status:404});
      if(w.status!=='pending_approval')throw Object.assign(new Error('Write-off is not pending approval'),{status:409});
      if(!await selfApprovalAllowed()&&w.created_by_employee_id&&String(w.created_by_employee_id)===String(actor(req)))throw Object.assign(new Error('Independent approval is required for inventory write-offs'),{status:403});
      const {rows:[inv]}=await tx.execute({sql:'SELECT stock_qty FROM branch_inventory WHERE product_id=? AND branch_id=?',args:[w.product_id,w.branch_id]});
      const physicalBefore=Number(inv?.stock_qty||0);if(physicalBefore<Number(w.quantity))throw Object.assign(new Error('Branch inventory changed and no longer contains enough stock for this write-off'),{status:409});
      if(w.source_status==='available'){
        const state=await getAvailableQty(tx,w.product_id,w.branch_id);if(state.available<Number(w.quantity))throw Object.assign(new Error('Available stock changed; reload and review this write-off before approval'),{status:409});
      }else{
        const {rows:[bal]}=await tx.execute({sql:'SELECT quantity FROM inventory_stock_status_balances WHERE product_id=? AND branch_id=? AND status=?',args:[w.product_id,w.branch_id,w.source_status]});
        if(Number(bal?.quantity||0)<Number(w.quantity))throw Object.assign(new Error(`${w.source_status} stock changed; reload and review before approval`),{status:409});
        await tx.execute({sql:'UPDATE inventory_stock_status_balances SET quantity=quantity-?,updated_at=CURRENT_TIMESTAMP WHERE product_id=? AND branch_id=? AND status=?',args:[w.quantity,w.product_id,w.branch_id,w.source_status]});
      }
      if(w.bin_id){
        const {rows:[bin]}=await tx.execute({sql:'SELECT * FROM product_bin_assignments WHERE product_id=? AND branch_id=? AND bin_id=?',args:[w.product_id,w.branch_id,w.bin_id]});
        if(!bin||Number(bin.quantity||0)<Number(w.quantity))throw Object.assign(new Error('Exact-bin quantity changed; write-off approval has been stopped'),{status:409});
        await tx.execute({sql:'UPDATE product_bin_assignments SET quantity=quantity-?,updated_at=CURRENT_TIMESTAMP WHERE id=?',args:[w.quantity,bin.id]});
      }else{
        const {rows:[anyBin]}=await tx.execute({sql:'SELECT id FROM product_bin_assignments WHERE product_id=? AND branch_id=? LIMIT 1',args:[w.product_id,w.branch_id]});
        if(anyBin)throw Object.assign(new Error('Bin-controlled inventory requires exact-bin evidence before write-off approval'),{status:409});
      }
      await tx.execute({sql:'UPDATE branch_inventory SET stock_qty=stock_qty-?,updated_at=CURRENT_TIMESTAMP WHERE product_id=? AND branch_id=?',args:[w.quantity,w.product_id,w.branch_id]});
      await tx.execute({sql:'UPDATE products SET stock_qty=(SELECT COALESCE(SUM(stock_qty),0) FROM branch_inventory WHERE product_id=?) WHERE id=?',args:[w.product_id,w.product_id]});
      const mov=await tx.execute({sql:`INSERT INTO stock_movements(product_id,branch_id,quantity_change,type,reference,reason) VALUES(?,?,?,?,?,?)`,args:[w.product_id,w.branch_id,-Number(w.quantity),'writeoff',w.writeoff_number,`${w.reason_code}: ${w.reason_detail}`]});
      const movementId=Number(mov.lastInsertRowid);
      await valueStockAdjustment(tx,{stockMovementId:movementId,productId:w.product_id,branchKey:w.branch_id,quantityChange:-Number(w.quantity),reason:`${w.reason_code}: ${w.reason_detail}`,physicalBefore});
      const {rows:[val]}=await tx.execute({sql:'SELECT * FROM inventory_adjustment_valuations WHERE stock_movement_id=?',args:[movementId]});
      const trackedValue=Number(val?.tracked_value||0),legacyQty=Number(val?.legacy_quantity||0),untrackedQty=Number(val?.untracked_quantity||0),trackedQty=Number(val?.tracked_quantity||0);
      let journal=null;
      if(trackedValue>0.0001){
        journal=await postSourceJournal({sourceType:'inventory_writeoff',sourceId:w.id,sourceReference:w.writeoff_number,entryDate:new Date().toISOString().slice(0,10),description:`Inventory write-off ${w.writeoff_number}`,branchId:w.branch_id,actorId:actor(req),executor:tx,lines:[{code:'5500',debit:trackedValue,credit:0,description:'Inventory loss / write-off expense'},{code:'1200',debit:0,credit:trackedValue,description:'Reduce inventory asset for written-off stock'}]});
      }
      const valuationStatus=(legacyQty+untrackedQty)>0?(trackedValue>0?'partial':'unvalued'):'fully_valued';
      await tx.execute({sql:`UPDATE inventory_writeoffs SET status='approved',approved_by_employee_id=?,approved_at=CURRENT_TIMESTAMP,stock_movement_id=?,tracked_quantity=?,tracked_value=?,legacy_quantity=?,untracked_quantity=?,valuation_status=?,journal_entry_id=? WHERE id=? AND status='pending_approval'`,args:[actor(req),movementId,trackedQty,trackedValue,legacyQty,untrackedQty,valuationStatus,journal?.id||null,w.id]});
      await tx.execute({sql:`INSERT INTO inventory_stock_status_events(product_id,branch_id,from_status,to_status,quantity,reason,employee_id,reference) VALUES(?,?,?,?,?,?,?,?)`,args:[w.product_id,w.branch_id,w.source_status,'written_off',w.quantity,`${w.reason_code}: ${w.reason_detail}`,actor(req),w.writeoff_number]});
      await tx.execute({sql:'INSERT INTO inventory_writeoff_events(writeoff_id,event_type,employee_id,details) VALUES(?,?,?,?)',args:[w.id,'approved',actor(req),`Physical stock removed; valuation=${valuationStatus}; tracked value=${trackedValue.toFixed(2)}`]});
      await tx.commit();committed=true;
      const {rows:[row]}=await db.execute({sql:'SELECT * FROM inventory_writeoffs WHERE id=?',args:[w.id]});res.json(row);
    }catch(e){if(!committed)await tx.rollback();res.status(e.status||400).json({error:e.message});}
  }catch(e){res.status(500).json({error:e.message});}
});

module.exports=router;
