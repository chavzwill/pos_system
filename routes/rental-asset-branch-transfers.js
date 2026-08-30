'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requireAnyPermission}=require('../lib/permissions');
const {ensureInventoryMovementValuation,removeFromPool,addComposition}=require('../lib/inventory-movement-valuation');

let readyPromise=null;
async function ensureSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await ensureInventoryMovementValuation();
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS rental_asset_branch_transfers(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id INTEGER NOT NULL REFERENCES rental_assets(id),
        product_id INTEGER NOT NULL REFERENCES products(id),
        serial_id INTEGER NOT NULL REFERENCES inventory_serials(id),
        from_branch_id INTEGER NOT NULL REFERENCES branches(id),
        to_branch_id INTEGER NOT NULL REFERENCES branches(id),
        status TEXT NOT NULL DEFAULT 'pending',
        previous_asset_status TEXT NOT NULL,
        previous_serial_status TEXT NOT NULL,
        reason TEXT NOT NULL,
        evidence_ref TEXT NOT NULL,
        requested_by_employee_id INTEGER REFERENCES employees(id),
        dispatched_by_employee_id INTEGER REFERENCES employees(id),
        received_by_employee_id INTEGER REFERENCES employees(id),
        cancelled_by_employee_id INTEGER REFERENCES employees(id),
        dispatch_stock_movement_id INTEGER REFERENCES stock_movements(id),
        receive_stock_movement_id INTEGER REFERENCES stock_movements(id),
        tracked_quantity REAL NOT NULL DEFAULT 0,
        tracked_value REAL NOT NULL DEFAULT 0,
        legacy_quantity REAL NOT NULL DEFAULT 0,
        untracked_quantity REAL NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        dispatched_at DATETIME,
        received_at DATETIME,
        cancelled_at DATETIME,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:`CREATE UNIQUE INDEX IF NOT EXISTS idx_rental_asset_branch_transfer_open ON rental_asset_branch_transfers(asset_id) WHERE status IN ('pending','in_transit')`},
      {sql:'CREATE INDEX IF NOT EXISTS idx_rental_asset_branch_transfer_route ON rental_asset_branch_transfers(from_branch_id,to_branch_id,status,created_at)'}
    ],'write');
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
async function asset(executor,id){const {rows:[a]}=await executor.execute({sql:`SELECT a.*,p.name product_name,p.sku,s.serial_number,s.branch_id serial_branch_id,s.bin_id serial_bin_id,s.status serial_status,s.unit_cost serial_unit_cost,b.name branch_name
  FROM rental_assets a JOIN products p ON p.id=a.product_id LEFT JOIN inventory_serials s ON s.id=a.serial_id LEFT JOIN branches b ON b.id=a.branch_id WHERE a.id=?`,args:[id]});return a||null;}
async function openTransfer(executor,assetId){const {rows:[r]}=await executor.execute({sql:`SELECT t.*,fb.name from_branch_name,tb.name to_branch_name FROM rental_asset_branch_transfers t LEFT JOIN branches fb ON fb.id=t.from_branch_id LEFT JOIN branches tb ON tb.id=t.to_branch_id WHERE t.asset_id=? AND t.status IN ('pending','in_transit') ORDER BY t.id DESC LIMIT 1`,args:[assetId]});return r||null;}
async function openAllocation(executor,assetId){const {rows:[r]}=await executor.execute({sql:'SELECT id,agreement_id,agreement_item_id FROM rental_asset_allocations WHERE asset_id=? AND released_at IS NULL LIMIT 1',args:[assetId]});return r||null;}
async function openMaintenance(executor,assetId){const {rows:[r]}=await executor.execute({sql:'SELECT id,maintenance_type,started_at FROM rental_asset_maintenance WHERE asset_id=? AND ended_at IS NULL LIMIT 1',args:[assetId]});return r||null;}
async function branchQty(executor,productId,branchId){const {rows:[r]}=await executor.execute({sql:'SELECT stock_qty FROM branch_inventory WHERE product_id=? AND branch_id=?',args:[productId,branchId]});return Number(r?.stock_qty||0);}
async function reconcileGlobal(executor,productId){const {rows:[r]}=await executor.execute({sql:'SELECT COALESCE(SUM(stock_qty),0) qty FROM branch_inventory WHERE product_id=?',args:[productId]});const qty=Number(r?.qty||0);await executor.execute({sql:'UPDATE products SET stock_qty=? WHERE id=?',args:[qty,productId]});return qty;}
async function lifecycleEvent(executor,{assetId,type,from,to,reason,evidence,employeeId,disposition}){await executor.execute({sql:`INSERT INTO rental_asset_lifecycle_events(asset_id,event_type,from_status,to_status,reason,disposition,evidence_ref,employee_id) VALUES(?,?,?,?,?,?,?,?)`,args:[assetId,type,from||null,to,reason,disposition||null,evidence||null,employeeId||null]});}
async function identityEvent(executor,{asset,branchId,type,transferId,employeeId,details}){await executor.execute({sql:`INSERT INTO inventory_identity_events(product_id,branch_id,serial_id,event_type,quantity,reference_type,reference_id,employee_id,details) VALUES(?,?,?,?,1,'rental_asset_branch_transfer',?,?,?,?)`,args:[asset.product_id,branchId,asset.serial_id,type,String(transferId),employeeId||null,details]});}
async function readiness(assetId){
  await ensureSchema();
  const a=await asset(db,assetId);if(!a)return null;
  const transfer=await openTransfer(db,assetId),allocation=await openAllocation(db,assetId),maintenance=await openMaintenance(db,assetId);
  const {rows:branches}=await db.execute({sql:'SELECT id,name FROM branches WHERE active=1 AND id<>? ORDER BY name',args:[a.branch_id]});
  const eligible=new Set(['active','retired','awaiting_sale','internal_use','reserve','parts_donor','long_term_storage']);
  return {asset:a,open_transfer:transfer,open_allocation:allocation,open_maintenance:maintenance,destination_branches:branches,ready:!transfer&&!allocation&&!maintenance&&eligible.has(String(a.status))&&!!a.serial_id&&Number(a.serial_branch_id)===Number(a.branch_id),policy:'Rental fleet relocation moves one exact serialized company asset. Pending/in-transit assets are unavailable for rental; source stock leaves at dispatch and destination stock returns only at receipt.'};
}

router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Rental asset branch-transfer controls failed to initialize',detail:e.message});}});

router.get('/assets/:id/branch-transfer-readiness',requireAnyPermission('rentals','transfers','reports_financial'),async(req,res)=>{
  try{const r=await readiness(Number(req.params.id));if(!r)return res.status(404).json({error:'Rental asset not found'});res.json(r);}catch(e){res.status(500).json({error:e.message});}
});

router.post('/assets/:id/branch-transfers',requireAnyPermission('rentals_manage','transfers_create'),async(req,res)=>{
  try{
    const id=Number(req.params.id),toBranch=Number(req.body?.to_branch_id),reason=String(req.body?.reason||'').trim(),evidence=String(req.body?.evidence_ref||'').trim();
    if(!toBranch)return res.status(400).json({error:'Destination branch is required'});if(reason.length<5)return res.status(400).json({error:'A meaningful transfer reason is required'});if(evidence.length<3)return res.status(400).json({error:'A supporting transfer evidence/reference is required'});
    const tx=await db.transaction('write');let committed=false;
    try{
      const a=await asset(tx,id);if(!a)throw Object.assign(new Error('Rental asset not found'),{status:404});
      const eligible=new Set(['active','retired','awaiting_sale','internal_use','reserve','parts_donor','long_term_storage']);if(!eligible.has(String(a.status)))throw Object.assign(new Error(`Rental asset cannot enter branch transfer from ${a.status}.`),{status:409});
      if(!a.serial_id)throw Object.assign(new Error('Exact rental fleet branch transfer requires a serialized physical asset identity.'),{status:409});
      if(Number(a.serial_branch_id)!==Number(a.branch_id))throw Object.assign(new Error('Rental asset and serial branch identity are already inconsistent; reconcile them before transfer.'),{status:409});
      if(Number(a.branch_id)===toBranch)throw Object.assign(new Error('Destination branch must be different from the current branch.'),{status:400});
      const {rows:[destination]}=await tx.execute({sql:'SELECT id,name FROM branches WHERE id=? AND active=1',args:[toBranch]});if(!destination)throw Object.assign(new Error('Destination branch is not active or does not exist.'),{status:400});
      if(await openAllocation(tx,id))throw Object.assign(new Error('Rental asset cannot transfer branches while allocated to an unresolved rental.'),{status:409});
      if(await openMaintenance(tx,id))throw Object.assign(new Error('Complete or formally close maintenance before transferring this rental asset.'),{status:409});
      if(await openTransfer(tx,id))throw Object.assign(new Error('Rental asset already has an open branch transfer.'),{status:409});
      const r=await tx.execute({sql:`INSERT INTO rental_asset_branch_transfers(asset_id,product_id,serial_id,from_branch_id,to_branch_id,previous_asset_status,previous_serial_status,reason,evidence_ref,requested_by_employee_id) VALUES(?,?,?,?,?,?,?,?,?,?)`,args:[id,a.product_id,a.serial_id,a.branch_id,toBranch,String(a.status),String(a.serial_status||'available'),reason,evidence,req.employee?.id||null]});
      const transferId=Number(r.lastInsertRowid);
      await tx.execute({sql:`UPDATE rental_assets SET status='transfer_pending',updated_at=CURRENT_TIMESTAMP WHERE id=?`,args:[id]});
      await tx.execute({sql:`UPDATE inventory_serials SET status='transfer_pending',updated_at=CURRENT_TIMESTAMP WHERE id=?`,args:[a.serial_id]});
      await lifecycleEvent(tx,{assetId:id,type:'branch_transfer_requested',from:a.status,to:'transfer_pending',reason,evidence,employeeId:req.employee?.id||null,disposition:`branch:${a.branch_id}->${toBranch}`});
      await identityEvent(tx,{asset:a,branchId:a.branch_id,type:'rental_transfer_requested',transferId,employeeId:req.employee?.id||null,details:`Rental asset ${a.asset_number} reserved for transfer from branch ${a.branch_id} to ${toBranch}`});
      await tx.commit();committed=true;res.status(201).json({transfer_id:transferId,status:'pending',asset_id:id,from_branch_id:Number(a.branch_id),to_branch_id:toBranch});
    }catch(e){if(!committed)await tx.rollback();throw e;}
  }catch(e){res.status(e.status||409).json({error:e.message});}
});

router.post('/branch-transfers/:id/dispatch',requireAnyPermission('rentals_manage','transfers_pickup'),async(req,res)=>{
  try{
    const transferId=Number(req.params.id),tx=await db.transaction('write');let committed=false;
    try{
      const {rows:[t]}=await tx.execute({sql:'SELECT * FROM rental_asset_branch_transfers WHERE id=?',args:[transferId]});if(!t)throw Object.assign(new Error('Rental asset branch transfer not found'),{status:404});if(String(t.status)!=='pending')throw Object.assign(new Error('Only a pending rental asset transfer can be dispatched.'),{status:409});
      const a=await asset(tx,t.asset_id);if(!a||String(a.status)!=='transfer_pending'||Number(a.branch_id)!==Number(t.from_branch_id)||Number(a.serial_branch_id)!==Number(t.from_branch_id))throw Object.assign(new Error('Rental asset identity no longer matches the pending transfer source; reconcile before dispatch.'),{status:409});
      if(await openAllocation(tx,a.id))throw Object.assign(new Error('Rental asset became allocated and cannot be dispatched.'),{status:409});if(await openMaintenance(tx,a.id))throw Object.assign(new Error('Rental asset entered maintenance and cannot be dispatched.'),{status:409});
      const qty=await branchQty(tx,a.product_id,t.from_branch_id);if(qty<1)throw Object.assign(new Error('Source branch does not have one physical unit available for this rental asset.'),{status:409});
      await tx.execute({sql:'UPDATE branch_inventory SET stock_qty=stock_qty-1,updated_at=CURRENT_TIMESTAMP WHERE product_id=? AND branch_id=?',args:[a.product_id,t.from_branch_id]});
      if(a.serial_bin_id){const {rows:[bin]}=await tx.execute({sql:'SELECT id,quantity FROM product_bin_assignments WHERE product_id=? AND branch_id=? AND bin_id=?',args:[a.product_id,t.from_branch_id,a.serial_bin_id]});if(bin&&Number(bin.quantity||0)<1)throw Object.assign(new Error('Source serial bin does not contain the physical unit required for dispatch.'),{status:409});if(bin)await tx.execute({sql:'UPDATE product_bin_assignments SET quantity=quantity-1,updated_at=CURRENT_TIMESTAMP WHERE id=?',args:[bin.id]});}
      const global=await reconcileGlobal(tx,a.product_id);
      const mov=await tx.execute({sql:`INSERT INTO stock_movements(product_id,branch_id,quantity_change,type,reason,reference) VALUES(?,?,?,?,?,?)`,args:[a.product_id,t.from_branch_id,-1,'rental_asset_transfer_dispatch',t.reason,`RAT-${transferId}`]});
      const movementId=Number(mov.lastInsertRowid),comp=await removeFromPool(tx,a.product_id,Number(t.from_branch_id),1,'rental_asset_branch_transfer',transferId);
      await tx.execute({sql:`UPDATE rental_asset_branch_transfers SET status='in_transit',dispatched_by_employee_id=?,dispatch_stock_movement_id=?,tracked_quantity=?,tracked_value=?,legacy_quantity=?,untracked_quantity=?,dispatched_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?`,args:[req.employee?.id||null,movementId,comp.tracked,comp.value,comp.legacy,comp.shortage,transferId]});
      await tx.execute({sql:`UPDATE rental_assets SET status='in_transit',updated_at=CURRENT_TIMESTAMP WHERE id=?`,args:[a.id]});
      await tx.execute({sql:`UPDATE inventory_serials SET status='in_transit',bin_id=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?`,args:[a.serial_id]});
      await lifecycleEvent(tx,{assetId:a.id,type:'branch_transfer_dispatched',from:'transfer_pending',to:'in_transit',reason:t.reason,evidence:t.evidence_ref,employeeId:req.employee?.id||null,disposition:`branch:${t.from_branch_id}->${t.to_branch_id}`});
      await identityEvent(tx,{asset:a,branchId:t.from_branch_id,type:'rental_transfer_dispatched',transferId,employeeId:req.employee?.id||null,details:`Rental asset ${a.asset_number} dispatched to branch ${t.to_branch_id}`});
      await tx.commit();committed=true;res.json({transfer_id:transferId,status:'in_transit',dispatch_stock_movement_id:movementId,global_available_stock:global});
    }catch(e){if(!committed)await tx.rollback();throw e;}
  }catch(e){res.status(e.status||409).json({error:e.message});}
});

router.post('/branch-transfers/:id/receive',requireAnyPermission('rentals_manage','transfers_dropoff'),async(req,res)=>{
  try{
    const transferId=Number(req.params.id),tx=await db.transaction('write');let committed=false;
    try{
      const {rows:[t]}=await tx.execute({sql:'SELECT * FROM rental_asset_branch_transfers WHERE id=?',args:[transferId]});if(!t)throw Object.assign(new Error('Rental asset branch transfer not found'),{status:404});if(String(t.status)!=='in_transit')throw Object.assign(new Error('Only an in-transit rental asset transfer can be received.'),{status:409});
      const a=await asset(tx,t.asset_id);if(!a||String(a.status)!=='in_transit'||Number(a.branch_id)!==Number(t.from_branch_id)||Number(a.serial_branch_id)!==Number(t.from_branch_id))throw Object.assign(new Error('Rental asset identity no longer matches the in-transit transfer; reconcile before receipt.'),{status:409});
      const {rows:[destination]}=await tx.execute({sql:'SELECT id,name FROM branches WHERE id=? AND active=1',args:[t.to_branch_id]});if(!destination)throw Object.assign(new Error('Destination branch is no longer active.'),{status:409});
      await tx.execute({sql:`INSERT INTO branch_inventory(product_id,branch_id,stock_qty,min_stock,updated_at) VALUES(?,?,1,(SELECT min_stock FROM products WHERE id=?),CURRENT_TIMESTAMP) ON CONFLICT(product_id,branch_id) DO UPDATE SET stock_qty=stock_qty+1,updated_at=CURRENT_TIMESTAMP`,args:[a.product_id,t.to_branch_id,a.product_id]});
      const global=await reconcileGlobal(tx,a.product_id);
      const mov=await tx.execute({sql:`INSERT INTO stock_movements(product_id,branch_id,quantity_change,type,reason,reference) VALUES(?,?,?,?,?,?)`,args:[a.product_id,t.to_branch_id,1,'rental_asset_transfer_receive',t.reason,`RAT-${transferId}`]});
      const movementId=Number(mov.lastInsertRowid);
      await addComposition(tx,a.product_id,Number(t.to_branch_id),{legacy:Number(t.legacy_quantity||0),tracked:Number(t.tracked_quantity||0),value:Number(t.tracked_value||0),shortage:Number(t.untracked_quantity||0)},'rental_asset_branch_transfer_receive',transferId);
      await tx.execute({sql:`UPDATE rental_assets SET branch_id=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`,args:[t.to_branch_id,t.previous_asset_status,a.id]});
      await tx.execute({sql:`UPDATE inventory_serials SET branch_id=?,status=?,bin_id=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?`,args:[t.to_branch_id,t.previous_serial_status,a.serial_id]});
      await tx.execute({sql:`UPDATE rental_asset_branch_transfers SET status='received',received_by_employee_id=?,receive_stock_movement_id=?,received_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?`,args:[req.employee?.id||null,movementId,transferId]});
      await lifecycleEvent(tx,{assetId:a.id,type:'branch_transfer_received',from:'in_transit',to:t.previous_asset_status,reason:t.reason,evidence:t.evidence_ref,employeeId:req.employee?.id||null,disposition:`branch:${t.from_branch_id}->${t.to_branch_id}`});
      const moved={...a,branch_id:t.to_branch_id,serial_id:a.serial_id};await identityEvent(tx,{asset:moved,branchId:t.to_branch_id,type:'rental_transfer_received',transferId,employeeId:req.employee?.id||null,details:`Rental asset ${a.asset_number} received at branch ${t.to_branch_id}; destination bin assignment intentionally requires local placement.`});
      await tx.commit();committed=true;res.json({transfer_id:transferId,status:'received',asset_id:a.id,branch_id:Number(t.to_branch_id),receive_stock_movement_id:movementId,global_available_stock:global,bin_assignment_required:true});
    }catch(e){if(!committed)await tx.rollback();throw e;}
  }catch(e){res.status(e.status||409).json({error:e.message});}
});

router.post('/branch-transfers/:id/cancel',requireAnyPermission('rentals_manage','transfers_create'),async(req,res)=>{
  try{
    const transferId=Number(req.params.id),reason=String(req.body?.reason||'').trim();if(reason.length<5)return res.status(400).json({error:'A meaningful cancellation reason is required'});
    const tx=await db.transaction('write');let committed=false;
    try{
      const {rows:[t]}=await tx.execute({sql:'SELECT * FROM rental_asset_branch_transfers WHERE id=?',args:[transferId]});if(!t)throw Object.assign(new Error('Rental asset branch transfer not found'),{status:404});if(String(t.status)!=='pending')throw Object.assign(new Error('Only a transfer that has not been physically dispatched can be cancelled.'),{status:409});
      const a=await asset(tx,t.asset_id);if(!a||String(a.status)!=='transfer_pending'||Number(a.branch_id)!==Number(t.from_branch_id)||Number(a.serial_branch_id)!==Number(t.from_branch_id))throw Object.assign(new Error('Rental asset identity no longer matches the pending transfer; reconcile before cancellation.'),{status:409});
      await tx.execute({sql:'UPDATE rental_assets SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',args:[t.previous_asset_status,a.id]});
      await tx.execute({sql:'UPDATE inventory_serials SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',args:[t.previous_serial_status,a.serial_id]});
      await tx.execute({sql:`UPDATE rental_asset_branch_transfers SET status='cancelled',cancelled_by_employee_id=?,cancelled_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP,reason=reason||' | CANCELLED: '||? WHERE id=?`,args:[req.employee?.id||null,reason,transferId]});
      await lifecycleEvent(tx,{assetId:a.id,type:'branch_transfer_cancelled',from:'transfer_pending',to:t.previous_asset_status,reason,evidence:t.evidence_ref,employeeId:req.employee?.id||null,disposition:`branch:${t.from_branch_id}->${t.to_branch_id}`});
      await identityEvent(tx,{asset:a,branchId:t.from_branch_id,type:'rental_transfer_cancelled',transferId,employeeId:req.employee?.id||null,details:`Rental asset ${a.asset_number} transfer cancelled before dispatch: ${reason}`});
      await tx.commit();committed=true;res.json({transfer_id:transferId,status:'cancelled',asset_id:a.id,restored_status:t.previous_asset_status});
    }catch(e){if(!committed)await tx.rollback();throw e;}
  }catch(e){res.status(e.status||409).json({error:e.message});}
});

module.exports=router;
module.exports.ensureSchema=ensureSchema;
