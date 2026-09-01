'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission,can}=require('../lib/permissions');
const {findEmployeeByPin}=require('../lib/pinAuth');
const {ensureInventoryMovementValuation,valueStockAdjustment}=require('../lib/inventory-movement-valuation');
const {getAvailableQty}=require('../lib/inventory-stock-status');
const {normalizeSignedInventoryQuantity}=require('../lib/inventory-quantity-precision');

let controlReady=null;
async function ensureAdjustmentControl(){
  if(controlReady)return controlReady;
  controlReady=db.batch([
    {sql:`CREATE TABLE IF NOT EXISTS inventory_adjustment_control_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stock_movement_id INTEGER NOT NULL UNIQUE REFERENCES stock_movements(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      branch_id INTEGER REFERENCES branches(id),
      bin_id INTEGER,
      employee_id INTEGER REFERENCES employees(id),
      authorizer_employee_id INTEGER REFERENCES employees(id),
      adjustment_quantity REAL NOT NULL,
      quantity_before REAL NOT NULL,
      quantity_after REAL NOT NULL,
      estimated_unit_cost REAL NOT NULL DEFAULT 0,
      estimated_value_change REAL NOT NULL DEFAULT 0,
      approval_required INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL,
      approval_reason TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`},
    {sql:'CREATE INDEX IF NOT EXISTS idx_adjustment_control_employee ON inventory_adjustment_control_events(employee_id,created_at)'},
    {sql:'CREATE INDEX IF NOT EXISTS idx_adjustment_control_branch ON inventory_adjustment_control_events(branch_id,created_at)'}
  ],'write').catch(e=>{controlReady=null;throw e;});
  return controlReady;
}
async function settingNumber(key,fallback){const {rows:[r]}=await db.execute({sql:'SELECT value FROM settings WHERE key=?',args:[key]});const n=Number(r?.value);return Number.isFinite(n)?n:fallback;}
async function settingBool(key,fallback=false){const {rows:[r]}=await db.execute({sql:'SELECT value FROM settings WHERE key=?',args:[key]});const v=String(r?.value??(fallback?'true':'false')).toLowerCase();return ['1','true','yes','on'].includes(v);}
async function unitCost(productId,branchId,product){
  if(branchId){
    try{const {rows:[pool]}=await db.execute({sql:'SELECT tracked_qty,tracked_value,legacy_unlayered_qty FROM inventory_cost_pools WHERE product_id=? AND branch_key=?',args:[productId,branchId]});if(pool&&Number(pool.legacy_unlayered_qty||0)<=1e-9&&Number(pool.tracked_qty||0)>0)return {value:Number(pool.tracked_value||0)/Number(pool.tracked_qty),basis:'tracked_inventory_pool'};}catch(e){}
  }
  return {value:Number(product.cost||0),basis:'catalog_cost_fallback'};
}
async function authorizeLargeReduction(req,estimatedLoss){
  const threshold=Math.max(0,await settingNumber('loss_control_inventory_adjustment_approval_value',25000));
  if(estimatedLoss<=threshold+0.01)return {required:false,threshold};
  const pin=String(req.body?.adjustment_override_pin||'').trim(),approvalReason=String(req.body?.adjustment_override_reason||'').trim();
  if(!pin)throw Object.assign(new Error(`Supervisor approval is required because this negative stock adjustment represents approximately ${estimatedLoss.toFixed(2)} of inventory value.`),{status:409});
  if(approvalReason.length<5)throw Object.assign(new Error('A meaningful supervisor approval reason is required for this high-value stock reduction.'),{status:400});
  const {rows:employees}=await db.execute({sql:`SELECT e.id,e.first_name,e.last_name,e.pin,sg.permissions FROM employees e LEFT JOIN security_groups sg ON sg.id=e.security_group_id WHERE e.active=1`,args:[]});
  const authorizer=await findEmployeeByPin(employees,pin,e=>{let p={};try{p=JSON.parse(e.permissions||'{}');}catch{}return can(p,'inventory_writeoff_approve')||can(p,'reports_financial')||can(p,'security_manage');});
  if(!authorizer)throw Object.assign(new Error('Invalid supervisor PIN or insufficient inventory-loss approval authority.'),{status:403});
  if(!await settingBool('loss_control_inventory_adjustment_allow_self_approval',false)&&req.employee&&String(req.employee.id)===String(authorizer.id))throw Object.assign(new Error('Independent supervisor authorization is required for this high-value stock reduction.'),{status:403});
  return {required:true,threshold,authorizer,approvalReason};
}

router.patch('/:id/stock',requirePermission('inventory_adjust'),async(req,res)=>{
  try{
    await ensureInventoryMovementValuation();await ensureAdjustmentControl();
    const productId=Number(req.params.id);
    if(!productId)return res.status(400).json({error:'Valid product id required'});
    const branchId=req.body?.branch_id?Number(req.body.branch_id):0;
    const binId=req.body?.bin_id?Number(req.body.bin_id):null;
    const reason=String(req.body?.reason||'').trim();
    if(reason.length<5)return res.status(400).json({error:'A meaningful stock-adjustment reason is required'});
    const {rows:[product]}=await db.execute({sql:'SELECT * FROM products WHERE id=?',args:[productId]});
    if(!product)return res.status(404).json({error:'Product not found'});
    if(product.is_service||product.is_non_inventory)return res.status(409).json({error:'This item does not support physical stock adjustments'});
    const normalized=await normalizeSignedInventoryQuantity(db,productId,req.body?.adjustment,{label:'Stock adjustment'});
    const adjustment=normalized.quantity;
    const costEvidence=await unitCost(productId,branchId,product),estimatedValueChange=Number((adjustment*Number(costEvidence.value||0)).toFixed(2));
    const approval=adjustment<0?await authorizeLargeReduction(req,Math.abs(estimatedValueChange)):{required:false,threshold:await settingNumber('loss_control_inventory_adjustment_approval_value',25000)};
    delete req.body.adjustment_override_pin;delete req.body.adjustment_override_reason;

    const tx=await db.transaction('write');let committed=false;
    try{
      let currentQty;let selectedBin=null;
      const {rows:branchRows}=await tx.execute({sql:'SELECT * FROM branch_inventory WHERE product_id=?',args:[productId]});
      if(!branchId&&branchRows.length)throw Object.assign(new Error('Select the branch whose physical stock is being adjusted; global stock cannot be edited independently of branch inventory'),{status:409});
      if(branchId){
        const {rows:[branch]}=await tx.execute({sql:'SELECT id FROM branches WHERE id=? AND active=1',args:[branchId]});
        if(!branch)throw Object.assign(new Error('Branch not found'),{status:400});
        const {rows:[existing]}=await tx.execute({sql:'SELECT * FROM branch_inventory WHERE product_id=? AND branch_id=?',args:[productId,branchId]});
        currentQty=Number(existing?.stock_qty||0);
        if(adjustment<0){const state=await getAvailableQty(tx,productId,branchId);if(state.available+1e-9<Math.abs(adjustment))throw Object.assign(new Error(`Only ${state.available} ${normalized.base_uom} of unrestricted, unreserved stock can be reduced; ${state.restricted} restricted and ${state.reserved||0} reserved ${normalized.base_uom} are protected`),{status:409});}
        const {rows:bins}=await tx.execute({sql:'SELECT * FROM product_bin_assignments WHERE product_id=? AND branch_id=? ORDER BY is_primary DESC,id',args:[productId,branchId]});
        if(bins.length){if(binId)selectedBin=bins.find(x=>String(x.bin_id)===String(binId));else if(bins.length===1)selectedBin=bins[0];else throw Object.assign(new Error('This product is stored in multiple bins; select the exact bin being adjusted'),{status:409});if(!selectedBin)throw Object.assign(new Error('Selected bin does not contain this product at the branch'),{status:409});if(Number(selectedBin.quantity||0)+adjustment<-1e-9)throw Object.assign(new Error(`Adjustment would make the selected bin negative (${Number(selectedBin.quantity||0)} ${normalized.base_uom} in bin)`),{status:409});}
        else if(binId)throw Object.assign(new Error('Selected product is not assigned to that bin'),{status:409});
        const newQty=currentQty+adjustment;if(newQty<-1e-9)throw Object.assign(new Error(`Adjustment would make branch stock negative (${currentQty} ${normalized.base_uom} on hand)`),{status:409});
        await tx.execute({sql:`INSERT INTO branch_inventory(product_id,branch_id,stock_qty,min_stock,updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(product_id,branch_id) DO UPDATE SET stock_qty=?,updated_at=CURRENT_TIMESTAMP`,args:[productId,branchId,newQty,existing?.min_stock??product.min_stock,newQty]});
        if(selectedBin)await tx.execute({sql:'UPDATE product_bin_assignments SET quantity=quantity+?,updated_at=CURRENT_TIMESTAMP WHERE id=?',args:[adjustment,selectedBin.id]});
      }else{currentQty=Number(product.stock_qty||0);if(currentQty+adjustment<-1e-9)throw Object.assign(new Error(`Adjustment would make global stock negative (${currentQty} ${normalized.base_uom} available)`),{status:409});}
      const {rows:[sum]}=await tx.execute({sql:'SELECT COALESCE(SUM(stock_qty),0) qty FROM branch_inventory WHERE product_id=?',args:[productId]});
      const newGlobal=branchId?Number(sum?.qty||0):currentQty+adjustment;
      await tx.execute({sql:'UPDATE products SET stock_qty=? WHERE id=?',args:[newGlobal,productId]});
      const mov=await tx.execute({sql:`INSERT INTO stock_movements(product_id,branch_id,quantity_change,type,reason,reference) VALUES(?,?,?,?,?,?)`,args:[productId,branchId||null,adjustment,'adjustment',reason,`ADJ-${Date.now()}`]});
      const movementId=Number(mov.lastInsertRowid);
      await valueStockAdjustment(tx,{stockMovementId:movementId,productId,branchKey:branchId,quantityChange:adjustment,reason,physicalBefore:currentQty});
      await tx.execute({sql:`INSERT INTO inventory_adjustment_control_events(stock_movement_id,product_id,branch_id,bin_id,employee_id,authorizer_employee_id,adjustment_quantity,quantity_before,quantity_after,estimated_unit_cost,estimated_value_change,approval_required,reason,approval_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:[movementId,productId,branchId||null,selectedBin?.bin_id||null,req.employee?.id||null,approval.authorizer?.id||null,adjustment,currentQty,currentQty+adjustment,Number(costEvidence.value||0),estimatedValueChange,approval.required?1:0,reason,approval.approvalReason||null]});
      await tx.commit();committed=true;
      res.json({stock_qty:branchId?currentQty+adjustment:newGlobal,global_stock_qty:newGlobal,branch_id:branchId||null,bin_id:selectedBin?.bin_id||null,movement_id:movementId,base_uom:normalized.base_uom,precision:normalized.precision,estimated_value_change:estimatedValueChange,cost_basis:costEvidence.basis,supervisor_approval_recorded:!!approval.required});
    }catch(e){if(!committed)await tx.rollback();res.status(e.status||400).json({error:e.message});}
  }catch(e){res.status(e.status||500).json({error:e.message});}
});

module.exports=router;
module.exports.ensureAdjustmentControl=ensureAdjustmentControl;
