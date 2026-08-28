'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {can,requireAnyPermission}=require('../lib/permissions');
const {ensureInventoryMovementValuation,valueStockAdjustment}=require('../lib/inventory-movement-valuation');
const {ensureLedger,postSourceJournal}=require('../lib/accounting-posting');

let readyPromise=null;
const r2=v=>Number(Number(v||0).toFixed(2));
async function ensureColumn(table,name,definition){const {rows}=await db.execute({sql:`PRAGMA table_info(${table})`,args:[]});if(!rows.some(x=>String(x.name)===name))await db.execute({sql:`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`,args:[]});}
async function ensureSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await ensureInventoryMovementValuation();
    await ensureLedger();
    await ensureColumn('rental_agreement_items','quantity_missing','INTEGER NOT NULL DEFAULT 0');
    await ensureColumn('rental_agreements','missing_asset_charge_total','REAL NOT NULL DEFAULT 0');
    await ensureColumn('rental_agreements','missing_asset_loss_value_total','REAL NOT NULL DEFAULT 0');
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS rental_missing_asset_dispositions(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agreement_id INTEGER NOT NULL REFERENCES rental_agreements(id),
        agreement_item_id INTEGER NOT NULL REFERENCES rental_agreement_items(id),
        product_id INTEGER NOT NULL REFERENCES products(id),
        branch_id INTEGER NOT NULL REFERENCES branches(id),
        quantity INTEGER NOT NULL,
        replacement_value REAL NOT NULL DEFAULT 0,
        proposed_customer_charge REAL NOT NULL DEFAULT 0,
        approved_customer_charge REAL NOT NULL DEFAULT 0,
        inventory_loss_value REAL NOT NULL DEFAULT 0,
        valuation_basis TEXT,
        disposition_reason TEXT NOT NULL,
        evidence_reference TEXT NOT NULL,
        customer_charge_reason TEXT,
        status TEXT NOT NULL DEFAULT 'pending_approval',
        created_by_employee_id INTEGER REFERENCES employees(id),
        approved_by_employee_id INTEGER REFERENCES employees(id),
        financial_authorizer_employee_id INTEGER REFERENCES employees(id),
        rejected_by_employee_id INTEGER REFERENCES employees(id),
        stock_movement_id INTEGER REFERENCES stock_movements(id),
        journal_entry_id INTEGER,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        approved_at DATETIME,
        rejected_at DATETIME,
        rejection_reason TEXT,
        UNIQUE(agreement_item_id,status)
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS rental_missing_asset_events(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        disposition_id INTEGER NOT NULL REFERENCES rental_missing_asset_dispositions(id),
        event_type TEXT NOT NULL,
        employee_id INTEGER REFERENCES employees(id),
        details TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:'CREATE INDEX IF NOT EXISTS idx_rental_missing_agreement ON rental_missing_asset_dispositions(agreement_id,status,created_at)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_rental_missing_product ON rental_missing_asset_dispositions(product_id,branch_id,status)'}
    ],'write');
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
async function settingNumber(key,fallback){const {rows:[r]}=await db.execute({sql:'SELECT value FROM settings WHERE key=?',args:[key]});const n=Number(r?.value);return Number.isFinite(n)?n:fallback;}
async function authorize(req,disposition){
  const pin=String(req.body?.financial_authorizer_pin||'').trim(),reason=String(req.body?.approval_reason||'').trim();
  if(!pin)return {error:'Independent management authorization is required before a missing rental asset can be financially disposed.'};
  if(reason.length<5)return {error:'A meaningful approval reason is required.'};
  const {rows:employees}=await db.execute({sql:'SELECT e.id,e.pin,sg.permissions FROM employees e LEFT JOIN security_groups sg ON sg.id=e.security_group_id WHERE e.active=1',args:[]});
  const auth=employees.find(e=>String(e.pin)===pin&&(()=>{let p={};try{p=JSON.parse(e.permissions||'{}')}catch{}return can(p,'reports_financial')||can(p,'security_manage')||can(p,'rentals_manage');})());
  if(!auth)return {error:'Invalid management PIN or insufficient financial-control authority.'};
  if(req.employee&&String(auth.id)===String(req.employee.id))return {error:'Missing-asset disposition requires an independent financial authorizer.'};
  if(disposition.created_by_employee_id&&String(auth.id)===String(disposition.created_by_employee_id))return {error:'The employee who declared the asset missing cannot provide its financial authorization.'};
  return {auth,reason};
}
async function estimateUnitCost(executor,productId,branchId){
  let unitCost=0,basis='catalog_cost_fallback';
  const {rows:[p]}=await executor.execute({sql:'SELECT cost FROM products WHERE id=?',args:[productId]});unitCost=Number(p?.cost||0);
  try{const {rows:[pool]}=await executor.execute({sql:'SELECT tracked_qty,tracked_value,legacy_unlayered_qty FROM inventory_cost_pools WHERE product_id=? AND branch_key=?',args:[productId,branchId]});if(pool&&Number(pool.tracked_qty||0)>0&&Number(pool.legacy_unlayered_qty||0)<=1e-9){unitCost=Number(pool.tracked_value||0)/Number(pool.tracked_qty);basis='current_tracked_inventory_pool';}}catch(e){}
  return {unit_cost:r2(unitCost),basis};
}
router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Rental missing-asset controls failed to initialize',detail:e.message});}});

router.get('/missing-assets',requireAnyPermission('rentals','reports'),async(req,res)=>{
  try{const args=[];let sql=`SELECT d.*,ra.agreement_number,rai.product_name,rai.sku,c.first_name||' '||c.last_name customer_name,b.name branch_name FROM rental_missing_asset_dispositions d JOIN rental_agreements ra ON ra.id=d.agreement_id JOIN rental_agreement_items rai ON rai.id=d.agreement_item_id LEFT JOIN customers c ON c.id=ra.customer_id LEFT JOIN branches b ON b.id=d.branch_id WHERE 1=1`;if(req.query.agreement_id){sql+=' AND d.agreement_id=?';args.push(req.query.agreement_id);}if(req.query.status){sql+=' AND d.status=?';args.push(req.query.status);}sql+=' ORDER BY d.created_at DESC,d.id DESC LIMIT 250';const {rows}=await db.execute({sql,args});res.json(rows);}catch(e){res.status(500).json({error:e.message});}
});

router.post('/agreements/:id/missing-assets',requireAnyPermission('rentals_returns','rentals_manage'),async(req,res)=>{
  try{
    const itemId=Number(req.body?.item_id),qty=Number(req.body?.quantity),reason=String(req.body?.reason||'').trim(),evidence=String(req.body?.evidence_reference||'').trim();
    if(!itemId||!Number.isInteger(qty)||qty<=0)return res.status(400).json({error:'item_id and a positive whole quantity are required'});
    if(reason.length<5||evidence.length<3)return res.status(400).json({error:'A meaningful missing-asset reason and evidence/reference are required'});
    const {rows:[agreement]}=await db.execute({sql:'SELECT * FROM rental_agreements WHERE id=?',args:[req.params.id]});if(!agreement)return res.status(404).json({error:'Rental agreement not found'});if(!['active','awaiting_issue'].includes(String(agreement.status)))return res.status(409).json({error:`Missing assets can only be declared on an active/issued rental, not ${agreement.status}.`});
    const {rows:[item]}=await db.execute({sql:'SELECT * FROM rental_agreement_items WHERE id=? AND agreement_id=?',args:[itemId,agreement.id]});if(!item)return res.status(404).json({error:'Rental item not found on this agreement'});
    const alreadyMissing=Number(item.quantity_missing||0),outstanding=Number(item.quantity||0)-Number(item.quantity_returned||0)-alreadyMissing;if(qty>outstanding)return res.status(409).json({error:`Only ${Math.max(0,outstanding)} unit(s) remain unresolved on this rental item.`});
    const {rows:[pending]}=await db.execute({sql:`SELECT id FROM rental_missing_asset_dispositions WHERE agreement_item_id=? AND status='pending_approval'`,args:[item.id]});if(pending)return res.status(409).json({error:'A missing-asset disposition for this rental item is already awaiting approval.'});
    const proposed=Math.max(0,r2(req.body?.proposed_customer_charge??Number(item.replacement_value||0)*qty));
    const r=await db.execute({sql:`INSERT INTO rental_missing_asset_dispositions(agreement_id,agreement_item_id,product_id,branch_id,quantity,replacement_value,proposed_customer_charge,disposition_reason,evidence_reference,created_by_employee_id) VALUES(?,?,?,?,?,?,?,?,?,?)`,args:[agreement.id,item.id,item.product_id,agreement.branch_id,qty,r2(Number(item.replacement_value||0)*qty),proposed,reason,evidence,req.employee?.id||null]});
    const id=Number(r.lastInsertRowid);await db.execute({sql:'INSERT INTO rental_missing_asset_events(disposition_id,event_type,employee_id,details) VALUES(?,?,?,?)',args:[id,'declared_missing',req.employee?.id||null,`${item.product_name} x${qty}; ${reason}; evidence=${evidence}`]});
    const {rows:[row]}=await db.execute({sql:'SELECT * FROM rental_missing_asset_dispositions WHERE id=?',args:[id]});res.status(201).json(row);
  }catch(e){res.status(500).json({error:e.message});}
});

router.post('/missing-assets/:id/reject',requireAnyPermission('rentals_manage','reports_financial'),async(req,res)=>{
  try{const reason=String(req.body?.reason||'').trim();if(reason.length<5)return res.status(400).json({error:'A meaningful rejection reason is required'});const r=await db.execute({sql:`UPDATE rental_missing_asset_dispositions SET status='rejected',rejected_by_employee_id=?,rejected_at=CURRENT_TIMESTAMP,rejection_reason=? WHERE id=? AND status='pending_approval'`,args:[req.employee?.id||null,reason,req.params.id]});if(!Number(r.rowsAffected||0))return res.status(409).json({error:'Disposition is not pending approval'});await db.execute({sql:'INSERT INTO rental_missing_asset_events(disposition_id,event_type,employee_id,details) VALUES(?,?,?,?)',args:[req.params.id,'rejected',req.employee?.id||null,reason]});res.json({success:true,status:'rejected'});}catch(e){res.status(500).json({error:e.message});}
});

router.post('/missing-assets/:id/approve',requireAnyPermission('rentals_manage','reports_financial'),async(req,res)=>{
  try{
    const {rows:[d]}=await db.execute({sql:'SELECT * FROM rental_missing_asset_dispositions WHERE id=?',args:[req.params.id]});if(!d)return res.status(404).json({error:'Missing-asset disposition not found'});if(d.status!=='pending_approval')return res.status(409).json({error:'Disposition is not pending approval'});
    const auth=await authorize(req,d);if(auth.error)return res.status(409).json({error:auth.error,control:'rental_missing_asset_disposition'});
    const approvedCharge=Math.max(0,r2(req.body?.approved_customer_charge??d.proposed_customer_charge));
    const waiver=r2(Math.max(0,Number(d.replacement_value||0)-approvedCharge));
    const waiverThreshold=Math.max(0,await settingNumber('loss_control_rental_missing_asset_waiver_threshold',25000));
    const chargeReason=String(req.body?.customer_charge_reason||'').trim();
    if(waiver>=waiverThreshold&&chargeReason.length<5)return res.status(409).json({error:`Reducing the customer charge by ${waiver.toFixed(2)} requires a documented waiver/recovery reason.`,control:'missing_asset_charge_waiver'});
    const tx=await db.transaction('write');let committed=false;
    try{
      const {rows:[cur]}=await tx.execute({sql:`SELECT d.*,ra.status agreement_status,ra.customer_id,ra.agreement_number,ra.missing_asset_charge_total,ra.missing_asset_loss_value_total,rai.quantity item_quantity,rai.quantity_returned,rai.quantity_missing,rai.product_name,rai.replacement_value item_replacement_value FROM rental_missing_asset_dispositions d JOIN rental_agreements ra ON ra.id=d.agreement_id JOIN rental_agreement_items rai ON rai.id=d.agreement_item_id WHERE d.id=?`,args:[d.id]});
      if(!cur||cur.status!=='pending_approval')throw Object.assign(new Error('Disposition changed before approval; reload and review.'),{status:409});
      const unresolved=Number(cur.item_quantity||0)-Number(cur.quantity_returned||0)-Number(cur.quantity_missing||0);if(unresolved<Number(cur.quantity))throw Object.assign(new Error('Rental item quantity changed; disposition can no longer be applied safely.'),{status:409});
      const {rows:[bi]}=await tx.execute({sql:'SELECT stock_qty FROM branch_inventory WHERE product_id=? AND branch_id=?',args:[cur.product_id,cur.branch_id]});const physicalBefore=Number(bi?.stock_qty||0);if(physicalBefore<Number(cur.quantity))throw Object.assign(new Error('Branch inventory no longer contains enough recorded stock to dispose this missing asset.'),{status:409});
      const val=await estimateUnitCost(tx,cur.product_id,cur.branch_id);
      const move=await tx.execute({sql:`INSERT INTO stock_movements(product_id,branch_id,quantity_change,type,reference,reason) VALUES(?,?,?,?,?,?)`,args:[cur.product_id,cur.branch_id,-Number(cur.quantity),'rental_missing_writeoff',`RMA-${cur.id}`,`Missing rental asset ${cur.agreement_number}: ${cur.disposition_reason}`]});const movementId=Number(move.lastInsertRowid);
      await tx.execute({sql:'UPDATE branch_inventory SET stock_qty=stock_qty-?,updated_at=CURRENT_TIMESTAMP WHERE product_id=? AND branch_id=?',args:[cur.quantity,cur.product_id,cur.branch_id]});
      await tx.execute({sql:'UPDATE products SET stock_qty=(SELECT COALESCE(SUM(stock_qty),0) FROM branch_inventory WHERE product_id=?) WHERE id=?',args:[cur.product_id,cur.product_id]});
      await valueStockAdjustment(tx,{stockMovementId:movementId,productId:cur.product_id,branchKey:cur.branch_id,quantityChange:-Number(cur.quantity),reason:`Missing rental asset ${cur.agreement_number}`,physicalBefore});
      const {rows:[iv]}=await tx.execute({sql:'SELECT tracked_value,tracked_quantity,legacy_quantity,untracked_quantity FROM inventory_adjustment_valuations WHERE stock_movement_id=?',args:[movementId]});
      const inventoryLoss=r2(Number(iv?.tracked_value||0)>0?Number(iv.tracked_value):val.unit_cost*Number(cur.quantity));
      let journal=null;if(inventoryLoss>0.0001)journal=await postSourceJournal({sourceType:'rental_missing_asset',sourceId:cur.id,sourceReference:`RMA-${cur.id}`,entryDate:new Date().toISOString().slice(0,10),description:`Missing rental asset ${cur.agreement_number}`,branchId:cur.branch_id,actorId:req.employee?.id||null,executor:tx,lines:[{code:'5500',debit:inventoryLoss,credit:0,description:'Rental asset loss / write-off expense'},{code:'1200',debit:0,credit:inventoryLoss,description:'Reduce inventory asset for missing rental item'}]});
      await tx.execute({sql:'UPDATE rental_agreement_items SET quantity_missing=quantity_missing+? WHERE id=?',args:[cur.quantity,cur.agreement_item_id]});
      await tx.execute({sql:'UPDATE rental_agreements SET missing_asset_charge_total=missing_asset_charge_total+?,missing_asset_loss_value_total=missing_asset_loss_value_total+? WHERE id=?',args:[approvedCharge,inventoryLoss,cur.agreement_id]});
      await tx.execute({sql:`UPDATE rental_missing_asset_dispositions SET status='approved',approved_customer_charge=?,inventory_loss_value=?,valuation_basis=?,approved_by_employee_id=?,financial_authorizer_employee_id=?,customer_charge_reason=?,stock_movement_id=?,journal_entry_id=?,approved_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending_approval'`,args:[approvedCharge,inventoryLoss,val.basis,req.employee?.id||null,auth.auth.id,chargeReason||auth.reason,movementId,journal?.id||null,cur.id]});
      await tx.execute({sql:'INSERT INTO rental_missing_asset_events(disposition_id,event_type,employee_id,details) VALUES(?,?,?,?)',args:[cur.id,'approved',req.employee?.id||null,`Inventory loss=${inventoryLoss.toFixed(2)}; customer charge=${approvedCharge.toFixed(2)}; waiver=${waiver.toFixed(2)}; ${auth.reason}`]});
      const {rows:items}=await tx.execute({sql:'SELECT quantity,quantity_returned,quantity_missing FROM rental_agreement_items WHERE agreement_id=?',args:[cur.agreement_id]});
      if(items.every(x=>Number(x.quantity_returned||0)+Number(x.quantity_missing||0)>=Number(x.quantity||0)))await tx.execute({sql:`UPDATE rental_agreements SET status='returned',returned_at=COALESCE(returned_at,CURRENT_TIMESTAMP) WHERE id=? AND status IN ('active','awaiting_issue')`,args:[cur.agreement_id]});
      await tx.commit();committed=true;
      delete req.body.financial_authorizer_pin;
      const {rows:[row]}=await db.execute({sql:'SELECT * FROM rental_missing_asset_dispositions WHERE id=?',args:[cur.id]});res.json({...row,waived_replacement_value:waiver,customer_charge_pending_settlement:approvedCharge>0});
    }catch(e){if(!committed)await tx.rollback();throw e;}
  }catch(e){res.status(e.status||500).json({error:e.message});}
});

module.exports=router;
module.exports.ensureSchema=ensureSchema;
