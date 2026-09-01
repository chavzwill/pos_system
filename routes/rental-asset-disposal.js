'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requireAnyPermission,can}=require('../lib/permissions');
const {ensureInventoryMovementValuation,valueStockAdjustment}=require('../lib/inventory-movement-valuation');
const {ensureLedger,postSourceJournal}=require('../lib/accounting-posting');

let readyPromise=null;
const money=v=>Number(Number(v||0).toFixed(2));
const BAD=new Set(['n/a','na','none','unknown','tbd','-']);
function meaningful(v,min=3){const s=String(v||'').trim();return s.length>=min&&!BAD.has(s.toLowerCase());}
async function ensureSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await ensureInventoryMovementValuation();
    await ensureLedger();
    await db.execute({sql:`INSERT OR IGNORE INTO ledger_accounts(code,name,account_type,normal_balance,system_account) VALUES('5500','Inventory Loss & Write-offs','expense','debit',1)`,args:[]});
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS rental_asset_disposals(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id INTEGER NOT NULL UNIQUE REFERENCES rental_assets(id),
        branch_id INTEGER NOT NULL REFERENCES branches(id),
        product_id INTEGER NOT NULL REFERENCES products(id),
        serial_id INTEGER REFERENCES inventory_serials(id),
        disposal_type TEXT NOT NULL,
        reason TEXT NOT NULL,
        evidence_ref TEXT NOT NULL,
        disposed_by_employee_id INTEGER REFERENCES employees(id),
        authorized_by_employee_id INTEGER NOT NULL REFERENCES employees(id),
        stock_movement_id INTEGER REFERENCES stock_movements(id),
        inventory_cost_removed REAL,
        cost_evidence_basis TEXT,
        accounting_status TEXT NOT NULL DEFAULT 'pending',
        journal_id INTEGER REFERENCES journal_entries(id),
        disposed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:'CREATE INDEX IF NOT EXISTS idx_rental_asset_disposals_branch ON rental_asset_disposals(branch_id,disposed_at)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_rental_asset_disposals_authorizer ON rental_asset_disposals(authorized_by_employee_id,disposed_at)'}
    ],'write');
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
async function authorize(pin,actorId){
  const value=String(pin||'').trim();if(!value)return null;
  const {rows}=await db.execute({sql:'SELECT e.id,e.first_name,e.last_name,e.pin,sg.permissions FROM employees e LEFT JOIN security_groups sg ON sg.id=e.security_group_id WHERE e.active=1',args:[]});
  const employee=rows.find(e=>String(e.pin)===value&&(()=>{let p={};try{p=JSON.parse(e.permissions||'{}')}catch{}return can(p,'inventory_writeoff_approve')||can(p,'reports_financial')||can(p,'security_manage');})());
  if(!employee||String(employee.id)===String(actorId||''))return null;
  return employee;
}
async function loadAsset(id,executor=db){
  const {rows:[a]}=await executor.execute({sql:`SELECT a.*,p.name product_name,p.sku,s.serial_number FROM rental_assets a JOIN products p ON p.id=a.product_id LEFT JOIN inventory_serials s ON s.id=a.serial_id WHERE a.id=?`,args:[id]});return a||null;
}
router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Rental asset disposal controls failed to initialize',detail:e.message});}});
router.get('/assets/:id/disposal-readiness',requireAnyPermission('rentals','reports_financial','inventory_writeoff_approve'),async(req,res)=>{
  try{
    const a=await loadAsset(Number(req.params.id));if(!a)return res.status(404).json({error:'Rental asset not found'});
    const {rows:[allocation]}=await db.execute({sql:'SELECT id,agreement_id FROM rental_asset_allocations WHERE asset_id=? AND released_at IS NULL LIMIT 1',args:[a.id]});
    const {rows:[maintenance]}=await db.execute({sql:'SELECT id,maintenance_type FROM rental_asset_maintenance WHERE asset_id=? AND ended_at IS NULL LIMIT 1',args:[a.id]});
    const {rows:[prior]}=await db.execute({sql:'SELECT id FROM rental_asset_disposals WHERE asset_id=?',args:[a.id]});
    const ownedNonRental=['retired','internal_use','reserve','parts_donor','long_term_storage','awaiting_sale'];
    res.json({asset:a,open_allocation:allocation||null,open_maintenance:maintenance||null,prior_disposal:prior||null,ready:ownedNonRental.includes(String(a.status))&&!allocation&&!maintenance&&!prior,policy:'Disposal permanently removes a company-owned fleet asset. Retire it first. If money will be received, use the controlled fleet-sale workflow instead of disposal.'});
  }catch(e){res.status(500).json({error:e.message});}
});
router.post('/assets/:id/dispose',requireAnyPermission('reports_financial','inventory_writeoff_approve'),async(req,res)=>{
  try{
    const assetId=Number(req.params.id),type=String(req.body?.disposal_type||'scrap').trim().toLowerCase(),reason=String(req.body?.reason||'').trim(),evidence=String(req.body?.evidence_ref||'').trim(),proceeds=money(req.body?.disposal_value||0),actorId=Number(req.employee?.id)||null;
    if(!['scrap','destroyed','donated','parts_exhausted','economic_end_of_life','other'].includes(type))return res.status(400).json({error:'Invalid disposal type.'});
    if(!meaningful(reason,5))return res.status(400).json({error:'A meaningful disposal reason is required.'});
    if(!meaningful(evidence))return res.status(400).json({error:'A meaningful disposal/write-off evidence reference is required.'});
    if(proceeds>0.009)return res.status(409).json({error:'A disposal cannot record sale proceeds. If money will be received for this asset, use the controlled Fleet Sale workflow so payment, tax, customer and sale evidence are preserved.',control:'rental_asset_sale_required'});
    const authorizer=await authorize(req.body?.disposal_authorizer_pin,actorId);if(!authorizer)return res.status(403).json({error:'Independent supervisor/financial authorization is required to permanently dispose of a rental asset.',control:'rental_asset_disposal_independent_authorization'});
    const pre=await loadAsset(assetId);if(!pre)return res.status(404).json({error:'Rental asset not found'});
    if(['active','maintenance'].includes(String(pre.status)))return res.status(409).json({error:'Retire the asset from rental service before permanent disposal.',control:'rental_asset_retirement_required'});
    if(['sold','lost','disposed'].includes(String(pre.status)))return res.status(409).json({error:`A ${pre.status} asset cannot be disposed through this workflow.`});
    const tx=await db.transaction('write');let committed=false;
    try{
      const a=await loadAsset(assetId,tx);if(!a)throw Object.assign(new Error('Rental asset not found'),{status:404});
      if(['active','maintenance','sold','lost','disposed'].includes(String(a.status)))throw Object.assign(new Error(`Asset lifecycle changed to ${a.status}; reload before disposal.`),{status:409});
      const {rows:[allocation]}=await tx.execute({sql:'SELECT id FROM rental_asset_allocations WHERE asset_id=? AND released_at IS NULL LIMIT 1',args:[assetId]});if(allocation)throw Object.assign(new Error('Rental asset cannot be disposed while allocated to an unresolved rental.'),{status:409});
      const {rows:[maintenance]}=await tx.execute({sql:'SELECT id FROM rental_asset_maintenance WHERE asset_id=? AND ended_at IS NULL LIMIT 1',args:[assetId]});if(maintenance)throw Object.assign(new Error('Complete or formally close maintenance before permanent disposal.'),{status:409});
      const {rows:[prior]}=await tx.execute({sql:'SELECT id FROM rental_asset_disposals WHERE asset_id=?',args:[assetId]});if(prior)throw Object.assign(new Error('Rental asset has already been disposed.'),{status:409});
      const {rows:[bi]}=await tx.execute({sql:'SELECT stock_qty FROM branch_inventory WHERE product_id=? AND branch_id=?',args:[a.product_id,a.branch_id]});const physicalBefore=Number(bi?.stock_qty||0);if(physicalBefore<1)throw Object.assign(new Error('Branch inventory no longer contains this physical rental asset; reconcile inventory before disposal.'),{status:409});
      const sm=await tx.execute({sql:`INSERT INTO stock_movements(product_id,branch_id,quantity_change,type,reference,reason) VALUES(?,?,?,?,?,?)`,args:[a.product_id,a.branch_id,-1,'rental_asset_disposal',evidence,`Disposed rental asset ${a.asset_number}: ${reason}`]});const movementId=Number(sm.lastInsertRowid);
      await tx.execute({sql:'UPDATE branch_inventory SET stock_qty=stock_qty-1,updated_at=CURRENT_TIMESTAMP WHERE product_id=? AND branch_id=?',args:[a.product_id,a.branch_id]});
      await tx.execute({sql:'UPDATE products SET stock_qty=(SELECT COALESCE(SUM(stock_qty),0) FROM branch_inventory WHERE product_id=?) WHERE id=?',args:[a.product_id,a.product_id]});
      await valueStockAdjustment(tx,{stockMovementId:movementId,productId:a.product_id,branchKey:a.branch_id,quantityChange:-1,reason:`Rental asset disposal ${a.asset_number}`,physicalBefore});
      const {rows:[val]}=await tx.execute({sql:'SELECT tracked_value FROM inventory_adjustment_valuations WHERE stock_movement_id=?',args:[movementId]});
      let cost=money(val?.tracked_value||0),basis=cost>0?'tracked_inventory_pool':null,accountingStatus='blocked_missing_cost_evidence',journalId=null;
      if(cost<=0&&String(a.acquisition_evidence_grade)==='complete'&&Number(a.acquisition_cost)>=0){cost=money(a.acquisition_cost);basis='complete_asset_acquisition_evidence';}
      if(cost>0){const j=await postSourceJournal({sourceType:'rental_asset_disposal',sourceId:assetId,sourceReference:evidence,entryDate:new Date().toISOString().slice(0,10),description:`Permanent disposal of rental asset ${a.asset_number}`,branchId:a.branch_id,actorId,executor:tx,lines:[{code:'5500',debit:cost,credit:0,description:'Rental fleet asset disposal/write-off loss'},{code:'1200',debit:0,credit:cost,description:'Remove disposed rental asset from inventory'}]});journalId=j.id;accountingStatus='posted';}
      if(a.serial_id)await tx.execute({sql:`UPDATE inventory_serials SET status='disposed',updated_at=CURRENT_TIMESTAMP WHERE id=?`,args:[a.serial_id]});
      await tx.execute({sql:`UPDATE rental_assets SET status='disposed',disposal_date=date('now'),disposal_value=0,disposal_reason=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`,args:[`${type}:${reason} | evidence:${evidence}`,assetId]});
      const dr=await tx.execute({sql:`INSERT INTO rental_asset_disposals(asset_id,branch_id,product_id,serial_id,disposal_type,reason,evidence_ref,disposed_by_employee_id,authorized_by_employee_id,stock_movement_id,inventory_cost_removed,cost_evidence_basis,accounting_status,journal_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:[assetId,a.branch_id,a.product_id,a.serial_id||null,type,reason,evidence,actorId,authorizer.id,movementId,cost||null,basis,accountingStatus,journalId]});const disposalId=Number(dr.lastInsertRowid);
      try{await tx.execute({sql:`INSERT INTO rental_asset_lifecycle_events(asset_id,event_type,from_status,to_status,reason,disposition,evidence_ref,employee_id) VALUES(?,?,?,?,?,?,?,?)`,args:[assetId,'disposed',a.status,'disposed',reason,type,evidence,actorId]});}catch(_){}
      await tx.commit();committed=true;
      res.status(201).json({success:true,disposal_id:disposalId,asset_id:assetId,status:'disposed',inventory_cost_removed:cost||null,cost_evidence_basis:basis,accounting_status:accountingStatus,journal_id:journalId,authorized_by_employee_id:authorizer.id});
    }catch(e){if(!committed)await tx.rollback();throw e;}
  }catch(e){res.status(e.status||409).json({error:e.message,control:e.control});}
});
module.exports=router;
module.exports.ensureSchema=ensureSchema;
