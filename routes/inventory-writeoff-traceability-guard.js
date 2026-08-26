'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {ensureInventoryTraceability,getTrackingProfile}=require('../lib/inventory-traceability');

let readyPromise=null;
async function ensureWriteoffTraceability(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await ensureInventoryTraceability();
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS inventory_writeoff_identity_allocations(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        writeoff_id INTEGER NOT NULL REFERENCES inventory_writeoffs(id),
        product_id INTEGER NOT NULL REFERENCES products(id),
        branch_id INTEGER NOT NULL REFERENCES branches(id),
        serial_id INTEGER REFERENCES inventory_serials(id),
        lot_id INTEGER REFERENCES inventory_lots(id),
        quantity INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending_approval',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        finalized_at DATETIME,
        UNIQUE(writeoff_id,serial_id),
        UNIQUE(writeoff_id,lot_id)
      )`},
      {sql:'CREATE INDEX IF NOT EXISTS idx_writeoff_identity_alloc ON inventory_writeoff_identity_allocations(writeoff_id,status)'}
    ],'write');
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
function actor(req){return req.employee?.id||null;}

async function prepareSelection(req){
  await ensureWriteoffTraceability();
  const productId=Number(req.body?.product_id),branchId=Number(req.body?.branch_id),qty=Number(req.body?.quantity),binId=req.body?.bin_id?Number(req.body.bin_id):null;
  if(!productId||!branchId||!Number.isInteger(qty)||qty<=0)return null;
  const profile=await getTrackingProfile(db,productId);
  if(profile.tracking_mode==='none')return null;
  if(String(req.body?.source_status||'available')!=='available')throw Object.assign(new Error('Serial/lot write-offs from restricted stock require identity-level disposition first; move the exact identity back to an auditable available state or use the dedicated disposition workflow'),{status:409});
  if(profile.tracking_mode==='serial'){
    const sns=Array.isArray(req.body?.serial_numbers)?req.body.serial_numbers.map(x=>String(typeof x==='string'?x:x?.serial_number||'').trim()).filter(Boolean):[];
    if(sns.length!==qty)throw Object.assign(new Error(`Serial-controlled write-off requires exactly ${qty} serial numbers`),{status:409});
    if(new Set(sns.map(x=>x.toLowerCase())).size!==sns.length)throw Object.assign(new Error('Duplicate serial selected for write-off'),{status:409});
    const selected=[];
    for(const sn of sns){
      const {rows:[s]}=await db.execute({sql:`SELECT * FROM inventory_serials WHERE lower(serial_number)=lower(?) AND product_id=? AND branch_id=? AND status='available'`,args:[sn,productId,branchId]});
      if(!s)throw Object.assign(new Error(`Serial ${sn} is not available at the write-off branch`),{status:409});
      if(binId&&s.bin_id&&Number(s.bin_id)!==binId)throw Object.assign(new Error(`Serial ${sn} is not in the selected bin`),{status:409});
      selected.push({serial_id:s.id,quantity:1});
    }
    return {profile,productId,branchId,rows:selected};
  }
  const lots=Array.isArray(req.body?.lots)?req.body.lots.map(x=>({lot_number:String(x?.lot_number||'').trim(),quantity:Number(x?.quantity)})).filter(x=>x.lot_number):[];
  if(!lots.length)throw Object.assign(new Error('Lot-controlled write-off requires exact lot allocation'),{status:409});
  if(lots.some(x=>!Number.isInteger(x.quantity)||x.quantity<=0)||lots.reduce((s,x)=>s+x.quantity,0)!==qty)throw Object.assign(new Error(`Write-off lot quantities must total ${qty}`),{status:409});
  const selected=[];
  for(const x of lots){
    const {rows:[lot]}=await db.execute({sql:`SELECT * FROM inventory_lots WHERE product_id=? AND branch_id=? AND lot_number=? AND status='available' ORDER BY id LIMIT 1`,args:[productId,branchId,x.lot_number]});
    if(!lot||Number(lot.available_quantity||0)<x.quantity)throw Object.assign(new Error(`Lot ${x.lot_number} does not have ${x.quantity} available unit(s) at this branch`),{status:409});
    if(binId&&lot.bin_id&&Number(lot.bin_id)!==binId)throw Object.assign(new Error(`Lot ${x.lot_number} is not in the selected bin`),{status:409});
    selected.push({lot_id:lot.id,quantity:x.quantity});
  }
  return {profile,productId,branchId,rows:selected};
}

router.post('/',async(req,res,next)=>{
  let selection=null;
  try{selection=await prepareSelection(req);if(!selection)return next();}catch(e){return res.status(e.status||409).json({error:e.message});}
  const originalJson=res.json.bind(res);
  res.json=function(payload){
    const success=res.statusCode>=200&&res.statusCode<300&&payload&&payload.id;
    if(!success)return originalJson(payload);
    return (async()=>{
      const tx=await db.transaction('write');let committed=false;
      try{
        for(const r of selection.rows)await tx.execute({sql:`INSERT INTO inventory_writeoff_identity_allocations(writeoff_id,product_id,branch_id,serial_id,lot_id,quantity) VALUES(?,?,?,?,?,?)`,args:[payload.id,selection.productId,selection.branchId,r.serial_id||null,r.lot_id||null,r.quantity]});
        await tx.execute({sql:`INSERT INTO inventory_writeoff_events(writeoff_id,event_type,employee_id,details) VALUES(?,?,?,?)`,args:[payload.id,'identity_captured',actor(req),`${selection.profile.tracking_mode} identity captured for approval`]});
        await tx.commit();committed=true;return originalJson(payload);
      }catch(e){if(!committed)await tx.rollback();res.status(500);return originalJson({error:'Write-off created but identity capture failed; write-off requires reconciliation',writeoff_id:payload.id,detail:e.message});}
    })();
  };
  next();
});

async function reserveApproval(writeoffId){
  await ensureWriteoffTraceability();
  const tx=await db.transaction('write');let committed=false;
  try{
    const {rows:[w]}=await tx.execute({sql:'SELECT * FROM inventory_writeoffs WHERE id=?',args:[writeoffId]});
    if(!w)return null;
    const profile=await getTrackingProfile(tx,w.product_id);
    if(profile.tracking_mode==='none'){await tx.rollback();return null;}
    const {rows:alloc}=await tx.execute({sql:`SELECT * FROM inventory_writeoff_identity_allocations WHERE writeoff_id=? AND status='pending_approval' ORDER BY id`,args:[writeoffId]});
    const total=alloc.reduce((s,x)=>s+Number(x.quantity||0),0);
    if(total!==Number(w.quantity))throw Object.assign(new Error(`Tracked identity allocation (${total}) no longer matches write-off quantity (${w.quantity})`),{status:409});
    for(const a of alloc){
      if(a.serial_id){
        const u=await tx.execute({sql:`UPDATE inventory_serials SET status='writeoff_pending',updated_at=CURRENT_TIMESTAMP WHERE id=? AND product_id=? AND branch_id=? AND status='available'`,args:[a.serial_id,w.product_id,w.branch_id]});
        if(Number(u.rowsAffected||0)!==1)throw Object.assign(new Error('A selected serial is no longer available for write-off'),{status:409});
      }else if(a.lot_id){
        const {rows:[lot]}=await tx.execute({sql:`SELECT available_quantity FROM inventory_lots WHERE id=? AND product_id=? AND branch_id=? AND status='available'`,args:[a.lot_id,w.product_id,w.branch_id]});
        if(!lot||Number(lot.available_quantity||0)<Number(a.quantity))throw Object.assign(new Error('A selected lot no longer has enough available quantity for write-off'),{status:409});
      }
    }
    await tx.execute({sql:`UPDATE inventory_writeoff_identity_allocations SET status='approval_reserved' WHERE writeoff_id=? AND status='pending_approval'`,args:[writeoffId]});
    await tx.commit();committed=true;return true;
  }catch(e){if(!committed)await tx.rollback();throw e;}
}
async function releaseApproval(writeoffId){
  const tx=await db.transaction('write');let committed=false;
  try{
    const {rows}=await tx.execute({sql:`SELECT * FROM inventory_writeoff_identity_allocations WHERE writeoff_id=? AND status='approval_reserved'`,args:[writeoffId]});
    for(const a of rows)if(a.serial_id)await tx.execute({sql:`UPDATE inventory_serials SET status='available',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='writeoff_pending'`,args:[a.serial_id]});
    await tx.execute({sql:`UPDATE inventory_writeoff_identity_allocations SET status='pending_approval' WHERE writeoff_id=? AND status='approval_reserved'`,args:[writeoffId]});
    await tx.commit();committed=true;
  }catch(e){if(!committed)await tx.rollback();throw e;}
}
async function finalizeApproval(writeoffId){
  const tx=await db.transaction('write');let committed=false;
  try{
    const {rows:[w]}=await tx.execute({sql:'SELECT * FROM inventory_writeoffs WHERE id=?',args:[writeoffId]});
    const {rows}=await tx.execute({sql:`SELECT * FROM inventory_writeoff_identity_allocations WHERE writeoff_id=? AND status='approval_reserved'`,args:[writeoffId]});
    for(const a of rows){
      if(a.serial_id){
        const u=await tx.execute({sql:`UPDATE inventory_serials SET status='written_off',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='writeoff_pending'`,args:[a.serial_id]});
        if(Number(u.rowsAffected||0)!==1)throw new Error('Serialized write-off identity changed before finalization');
        await tx.execute({sql:`INSERT INTO inventory_identity_events(product_id,branch_id,serial_id,event_type,quantity,reference_type,reference_id,employee_id,details) VALUES(?,?,?,?,1,'inventory_writeoff',?,?,?)`,args:[w.product_id,w.branch_id,a.serial_id,'written_off',String(writeoffId),w.approved_by_employee_id||null,`${w.reason_code}: ${w.reason_detail}`]});
      }else if(a.lot_id){
        const u=await tx.execute({sql:`UPDATE inventory_lots SET available_quantity=available_quantity-? WHERE id=? AND status='available' AND available_quantity>=?`,args:[a.quantity,a.lot_id,a.quantity]});
        if(Number(u.rowsAffected||0)!==1)throw new Error('Lot write-off identity changed before finalization');
        await tx.execute({sql:`INSERT INTO inventory_identity_events(product_id,branch_id,lot_id,event_type,quantity,reference_type,reference_id,employee_id,details) VALUES(?,?,?,?,?,'inventory_writeoff',?,?,?)`,args:[w.product_id,w.branch_id,a.lot_id,'written_off',a.quantity,String(writeoffId),w.approved_by_employee_id||null,`${w.reason_code}: ${w.reason_detail}`]});
      }
    }
    await tx.execute({sql:`UPDATE inventory_writeoff_identity_allocations SET status='finalized',finalized_at=CURRENT_TIMESTAMP WHERE writeoff_id=? AND status='approval_reserved'`,args:[writeoffId]});
    await tx.commit();committed=true;
  }catch(e){if(!committed)await tx.rollback();throw e;}
}

router.post('/:id/approve',async(req,res,next)=>{
  let reserved=false,finalized=false;
  try{reserved=!!(await reserveApproval(req.params.id));if(!reserved)return next();}catch(e){return res.status(e.status||409).json({error:e.message});}
  const originalJson=res.json.bind(res);
  res.json=function(payload){
    const success=res.statusCode>=200&&res.statusCode<300&&payload;
    if(success)return finalizeApproval(req.params.id).then(()=>{finalized=true;return originalJson(payload);}).catch(async e=>{await releaseApproval(req.params.id).catch(()=>{});res.status(500);return originalJson({error:'Write-off approved but inventory identity finalization failed; write-off requires reconciliation',writeoff_id:Number(req.params.id),detail:e.message});});
    releaseApproval(req.params.id).catch(()=>{});return originalJson(payload);
  };
  res.on('close',()=>{if(reserved&&!finalized)releaseApproval(req.params.id).catch(()=>{});});
  next();
});
module.exports=router;
