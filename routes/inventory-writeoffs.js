'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission,can}=require('../lib/permissions');
const {nextNumber}=require('../lib/nextNumber');
const {ensureInventoryMovementValuation,valueStockAdjustment}=require('../lib/inventory-movement-valuation');
const {ensureInventoryStockStatus,getAvailableQty}=require('../lib/inventory-stock-status');
const {ensureLedger,postSourceJournal}=require('../lib/accounting-posting');
const {ensureInventoryTraceability,getTrackingProfile}=require('../lib/inventory-traceability');
const {writeoffError,sendWriteoffError,rollbackWriteoffQuietly}=require('../lib/inventory-writeoff-errors');

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
async function selfApprovalAllowed(executor=db){
  const {rows:[row]}=await executor.execute({sql:"SELECT value FROM settings WHERE key='inventory_writeoff_allow_self_approval'",args:[]});
  return row&&['1','true','yes','on'].includes(String(row.value||'').trim().toLowerCase());
}

async function settingNumber(executor,key,fallback){const {rows:[row]}=await executor.execute({sql:'SELECT value FROM settings WHERE key=?',args:[key]});const n=Number(row?.value);return Number.isFinite(n)?n:fallback;}
function meaningfulEvidence(value){const s=String(value||'').trim();return s.length>=3&&!new Set(['NA','N/A','NONE','UNKNOWN','NO','NIL','TBD','NOT AVAILABLE']).has(s.toUpperCase());}
async function financialRequirement(executor,w){
  const {rows:[product]}=await executor.execute({sql:'SELECT cost FROM products WHERE id=?',args:[w.product_id]});
  let unitCost=Number(product?.cost||0),basis='catalog_cost_fallback';
  const {rows:[pool]}=await executor.execute({sql:'SELECT tracked_qty,tracked_value,legacy_unlayered_qty FROM inventory_cost_pools WHERE product_id=? AND branch_key=?',args:[w.product_id,w.branch_id]});
  if(pool&&Number(pool.tracked_qty||0)>0&&Number(pool.tracked_value||0)>=0&&Number(pool.legacy_unlayered_qty||0)<=1e-9){unitCost=Number(pool.tracked_value)/Number(pool.tracked_qty);basis='current_tracked_inventory_pool';}
  const estimatedValue=Number((unitCost*Number(w.quantity||0)).toFixed(2));
  const threshold=Math.max(0,await settingNumber(executor,'loss_control_high_value_writeoff_threshold',100000));
  const evidenceThreshold=Math.max(threshold,await settingNumber(executor,'loss_control_writeoff_evidence_threshold',250000));
  const highRiskReason=['theft','destruction','shrinkage'].includes(String(w.reason_code||'').toLowerCase());
  return {required:estimatedValue+0.009>=threshold||highRiskReason,evidenceRequired:highRiskReason||estimatedValue+0.009>=evidenceThreshold,estimatedValue,basis,threshold,evidenceThreshold};
}
async function revalidateOperationalApprover(executor,employeeId){
  const {rows:[row]}=await executor.execute({sql:'SELECT e.id,e.active,sg.permissions FROM employees e LEFT JOIN security_groups sg ON sg.id=e.security_group_id WHERE e.id=?',args:[employeeId]});
  let permissions={};try{permissions=JSON.parse(row?.permissions||'{}')}catch{}
  return !!(row&&Number(row.active)!==0&&can(permissions,'inventory_writeoff_approve'));
}

router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){return sendWriteoffError(res,e,{operation:'writeoff_controls_initialize'});}});

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
  }catch(e){return sendWriteoffError(res,e,{operation:'list_writeoffs',employee_id:actor(req)});}
});

router.get('/:id',requirePermission('inventory'),async(req,res)=>{
  try{
    const {rows:[row]}=await db.execute({sql:`SELECT w.*,p.name product_name,p.sku,b.name branch_name,sb.bin_code
      FROM inventory_writeoffs w JOIN products p ON p.id=w.product_id JOIN branches b ON b.id=w.branch_id
      LEFT JOIN storage_bins sb ON sb.id=w.bin_id WHERE w.id=?`,args:[req.params.id]});
    if(!row)return res.status(404).json({error:'Write-off not found'});
    const {rows:events}=await db.execute({sql:'SELECT * FROM inventory_writeoff_events WHERE writeoff_id=? ORDER BY id',args:[row.id]});
    row.events=events;res.json(row);
  }catch(e){return sendWriteoffError(res,e,{operation:'get_writeoff',writeoff_id:req.params.id,employee_id:actor(req)});}
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
  }catch(e){return sendWriteoffError(res,e,{operation:'create_writeoff',employee_id:actor(req)});}
});

router.post('/:id/reject',requirePermission('inventory_writeoff_approve'),async(req,res)=>{
  try{
    const reason=String(req.body?.reason||'').trim();if(reason.length<3)return res.status(400).json({error:'A rejection reason is required'});
    const r=await db.execute({sql:`UPDATE inventory_writeoffs SET status='rejected',rejected_by_employee_id=?,rejected_at=CURRENT_TIMESTAMP,rejection_reason=? WHERE id=? AND status='pending_approval'`,args:[actor(req),reason,req.params.id]});
    if(!Number(r.rowsAffected||0))return res.status(409).json({error:'Write-off is not pending approval'});
    await db.execute({sql:'INSERT INTO inventory_writeoff_events(writeoff_id,event_type,employee_id,details) VALUES(?,?,?,?)',args:[req.params.id,'rejected',actor(req),reason]});
    res.json({success:true,status:'rejected'});
  }catch(e){return sendWriteoffError(res,e,{operation:'reject_writeoff',writeoff_id:req.params.id,employee_id:actor(req)});}
});

router.post('/:id/approve',requirePermission('inventory_writeoff_approve'),async(req,res)=>{
  const tx=await db.transaction('write');let committed=false;
  try{
    const approverId=actor(req);
    const {rows:[w]}=await tx.execute({sql:'SELECT * FROM inventory_writeoffs WHERE id=?',args:[req.params.id]});
    if(!w)throw writeoffError('WRITEOFF_NOT_FOUND');
    if(w.status!=='pending_approval')throw writeoffError('WRITEOFF_NOT_PENDING');
    if(!approverId||!await revalidateOperationalApprover(tx,approverId))throw writeoffError('WRITEOFF_SELF_APPROVAL_FORBIDDEN');
    if(!await selfApprovalAllowed(tx)&&w.created_by_employee_id&&String(w.created_by_employee_id)===String(approverId))throw writeoffError('WRITEOFF_SELF_APPROVAL_FORBIDDEN');

    const financial=await financialRequirement(tx,w);
    let financialRecorded=false;
    if(financial.required){
      const prepared=req.writeoffFinancialAuthorization;
      if(!prepared?.required||!prepared.authorizerEmployeeId)throw writeoffError('WRITEOFF_FINANCIAL_AUTH_REQUIRED');
      const {rows:[auth]}=await tx.execute({sql:'SELECT e.id,e.active,sg.permissions FROM employees e LEFT JOIN security_groups sg ON sg.id=e.security_group_id WHERE e.id=?',args:[prepared.authorizerEmployeeId]});
      let permissions={};try{permissions=JSON.parse(auth?.permissions||'{}')}catch{}
      if(!auth||Number(auth.active)===0||!(can(permissions,'reports_financial')||can(permissions,'security_manage')))throw writeoffError('WRITEOFF_FINANCIAL_AUTH_FORBIDDEN');
      if(String(auth.id)===String(approverId)||(w.created_by_employee_id&&String(auth.id)===String(w.created_by_employee_id)))throw writeoffError('WRITEOFF_FINANCIAL_AUTH_FORBIDDEN');
      if(String(prepared.reason||'').trim().length<5)throw writeoffError('WRITEOFF_FINANCIAL_AUTH_REQUIRED');
      if(financial.evidenceRequired&&!meaningfulEvidence(prepared.evidenceReference))throw writeoffError('WRITEOFF_FINANCIAL_AUTH_REQUIRED');
      await tx.execute({sql:`INSERT INTO inventory_writeoff_financial_approvals(writeoff_id,estimated_value,valuation_basis,threshold_value,approving_employee_id,financial_authorizer_employee_id,reason,evidence_reference,reason_code) VALUES(?,?,?,?,?,?,?,?,?)`,args:[w.id,financial.estimatedValue,financial.basis,financial.threshold,approverId,auth.id,String(prepared.reason).trim(),prepared.evidenceReference||null,w.reason_code||null]});
      financialRecorded=true;
    }

    const profile=await getTrackingProfile(tx,w.product_id);
    const {rows:alloc}=profile.tracking_mode==='none'?{rows:[]}:await tx.execute({sql:`SELECT * FROM inventory_writeoff_identity_allocations WHERE writeoff_id=? AND status='pending_approval' ORDER BY id`,args:[w.id]});
    if(profile.tracking_mode!=='none'){
      const total=alloc.reduce((sum,row)=>sum+Number(row.quantity||0),0);
      if(total!==Number(w.quantity))throw writeoffError('WRITEOFF_IDENTITY_CHANGED');
      if(profile.tracking_mode==='serial'){
        if(alloc.length!==Number(w.quantity)||alloc.some(row=>!row.serial_id||row.lot_id||Number(row.quantity)!==1))throw writeoffError('WRITEOFF_IDENTITY_CHANGED');
        for(const a of alloc){
          const u=await tx.execute({sql:`UPDATE inventory_serials SET status='written_off',updated_at=CURRENT_TIMESTAMP WHERE id=? AND product_id=? AND branch_id=? AND status='available'`,args:[a.serial_id,w.product_id,w.branch_id]});
          if(Number(u.rowsAffected||0)!==1)throw writeoffError('WRITEOFF_IDENTITY_CHANGED');
          await tx.execute({sql:`INSERT INTO inventory_identity_events(product_id,branch_id,serial_id,event_type,quantity,reference_type,reference_id,employee_id,details) VALUES(?,?,?,?,1,'inventory_writeoff',?,?,?)`,args:[w.product_id,w.branch_id,a.serial_id,'written_off',String(w.id),approverId,`${w.reason_code}: ${w.reason_detail}`]});
        }
      }else if(profile.tracking_mode==='lot'){
        if(alloc.some(row=>!row.lot_id||row.serial_id||Number(row.quantity)<=0))throw writeoffError('WRITEOFF_IDENTITY_CHANGED');
        for(const a of alloc){
          const u=await tx.execute({sql:`UPDATE inventory_lots SET available_quantity=available_quantity-? WHERE id=? AND product_id=? AND branch_id=? AND status='available' AND available_quantity>=?`,args:[a.quantity,a.lot_id,w.product_id,w.branch_id,a.quantity]});
          if(Number(u.rowsAffected||0)!==1)throw writeoffError('WRITEOFF_IDENTITY_CHANGED');
          await tx.execute({sql:`INSERT INTO inventory_identity_events(product_id,branch_id,lot_id,event_type,quantity,reference_type,reference_id,employee_id,details) VALUES(?,?,?,?,?,'inventory_writeoff',?,?,?)`,args:[w.product_id,w.branch_id,a.lot_id,'written_off',a.quantity,String(w.id),approverId,`${w.reason_code}: ${w.reason_detail}`]});
        }
      }else throw writeoffError('WRITEOFF_IDENTITY_CHANGED');
      const finalized=await tx.execute({sql:`UPDATE inventory_writeoff_identity_allocations SET status='finalized',finalized_at=CURRENT_TIMESTAMP WHERE writeoff_id=? AND status='pending_approval'`,args:[w.id]});
      if(Number(finalized.rowsAffected||0)!==alloc.length)throw writeoffError('WRITEOFF_IDENTITY_CHANGED');
    }

    const {rows:[inv]}=await tx.execute({sql:'SELECT stock_qty FROM branch_inventory WHERE product_id=? AND branch_id=?',args:[w.product_id,w.branch_id]});
    const physicalBefore=Number(inv?.stock_qty||0);if(physicalBefore<Number(w.quantity))throw writeoffError('WRITEOFF_STOCK_CHANGED');
    if(w.source_status==='available'){
      const state=await getAvailableQty(tx,w.product_id,w.branch_id);if(state.available<Number(w.quantity))throw writeoffError('WRITEOFF_STOCK_CHANGED');
    }else{
      const restricted=await tx.execute({sql:'UPDATE inventory_stock_status_balances SET quantity=quantity-?,updated_at=CURRENT_TIMESTAMP WHERE product_id=? AND branch_id=? AND status=? AND quantity>=?',args:[w.quantity,w.product_id,w.branch_id,w.source_status,w.quantity]});
      if(Number(restricted.rowsAffected||0)!==1)throw writeoffError('WRITEOFF_STOCK_CHANGED');
    }
    if(w.bin_id){
      const bin=await tx.execute({sql:'UPDATE product_bin_assignments SET quantity=quantity-?,updated_at=CURRENT_TIMESTAMP WHERE product_id=? AND branch_id=? AND bin_id=? AND quantity>=?',args:[w.quantity,w.product_id,w.branch_id,w.bin_id,w.quantity]});
      if(Number(bin.rowsAffected||0)!==1)throw writeoffError('WRITEOFF_STOCK_CHANGED');
    }else{
      const {rows:[anyBin]}=await tx.execute({sql:'SELECT id FROM product_bin_assignments WHERE product_id=? AND branch_id=? LIMIT 1',args:[w.product_id,w.branch_id]});
      if(anyBin)throw writeoffError('WRITEOFF_STOCK_CHANGED');
    }
    const branch=await tx.execute({sql:'UPDATE branch_inventory SET stock_qty=stock_qty-?,updated_at=CURRENT_TIMESTAMP WHERE product_id=? AND branch_id=? AND stock_qty>=?',args:[w.quantity,w.product_id,w.branch_id,w.quantity]});
    if(Number(branch.rowsAffected||0)!==1)throw writeoffError('WRITEOFF_STOCK_CHANGED');
    await tx.execute({sql:'UPDATE products SET stock_qty=(SELECT COALESCE(SUM(stock_qty),0) FROM branch_inventory WHERE product_id=?) WHERE id=?',args:[w.product_id,w.product_id]});
    const mov=await tx.execute({sql:`INSERT INTO stock_movements(product_id,branch_id,quantity_change,type,reference,reason) VALUES(?,?,?,?,?,?)`,args:[w.product_id,w.branch_id,-Number(w.quantity),'writeoff',w.writeoff_number,`${w.reason_code}: ${w.reason_detail}`]});
    const movementId=Number(mov.lastInsertRowid);
    await valueStockAdjustment(tx,{stockMovementId:movementId,productId:w.product_id,branchKey:w.branch_id,quantityChange:-Number(w.quantity),reason:`${w.reason_code}: ${w.reason_detail}`,physicalBefore});
    const {rows:[val]}=await tx.execute({sql:'SELECT * FROM inventory_adjustment_valuations WHERE stock_movement_id=?',args:[movementId]});
    const trackedValue=Number(val?.tracked_value||0),legacyQty=Number(val?.legacy_quantity||0),untrackedQty=Number(val?.untracked_quantity||0),trackedQty=Number(val?.tracked_quantity||0);
    let journal=null;
    if(trackedValue>0.0001)journal=await postSourceJournal({sourceType:'inventory_writeoff',sourceId:w.id,sourceReference:w.writeoff_number,entryDate:new Date().toISOString().slice(0,10),description:`Inventory write-off ${w.writeoff_number}`,branchId:w.branch_id,actorId:approverId,executor:tx,lines:[{code:'5500',debit:trackedValue,credit:0,description:'Inventory loss / write-off expense'},{code:'1200',debit:0,credit:trackedValue,description:'Reduce inventory asset for written-off stock'}]});
    const valuationStatus=(legacyQty+untrackedQty)>0?(trackedValue>0?'partial':'unvalued'):'fully_valued';
    const approved=await tx.execute({sql:`UPDATE inventory_writeoffs SET status='approved',approved_by_employee_id=?,approved_at=CURRENT_TIMESTAMP,stock_movement_id=?,tracked_quantity=?,tracked_value=?,legacy_quantity=?,untracked_quantity=?,valuation_status=?,journal_entry_id=? WHERE id=? AND status='pending_approval' RETURNING *`,args:[approverId,movementId,trackedQty,trackedValue,legacyQty,untrackedQty,valuationStatus,journal?.id||null,w.id]});
    if(!approved.rows.length)throw writeoffError('WRITEOFF_CONCURRENT_DECISION');
    await tx.execute({sql:`INSERT INTO inventory_stock_status_events(product_id,branch_id,from_status,to_status,quantity,reason,employee_id,reference) VALUES(?,?,?,?,?,?,?,?)`,args:[w.product_id,w.branch_id,w.source_status,'written_off',w.quantity,`${w.reason_code}: ${w.reason_detail}`,approverId,w.writeoff_number]});
    await tx.execute({sql:'INSERT INTO inventory_writeoff_events(writeoff_id,event_type,employee_id,details) VALUES(?,?,?,?)',args:[w.id,'approved',approverId,`Physical stock removed; valuation=${valuationStatus}; tracked value=${trackedValue.toFixed(2)}`]});
    await tx.commit();committed=true;
    const {rows:[row]}=await db.execute({sql:'SELECT * FROM inventory_writeoffs WHERE id=?',args:[w.id]});
    return res.json({...row,financial_approval_recorded:financialRecorded,estimated_writeoff_value:financial.estimatedValue,writeoff_evidence_required:financial.evidenceRequired});
  }catch(e){
    if(!committed)await rollbackWriteoffQuietly(tx,{operation:'approve_rollback',writeoff_id:req.params.id,employee_id:actor(req)},e);
    return sendWriteoffError(res,e,{operation:'approve',writeoff_id:req.params.id,employee_id:actor(req)});
  }
});
module.exports=router;
