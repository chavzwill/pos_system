'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {ensureInventoryTraceability,getTrackingProfile}=require('../lib/inventory-traceability');
const {writeoffError,sendWriteoffError,rollbackWriteoffQuietly}=require('../lib/inventory-writeoff-errors');

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
  try{selection=await prepareSelection(req);if(!selection)return next();}catch(e){return sendWriteoffError(res,e,{operation:'prepare_identity_selection'});}
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
      }catch(e){if(!committed)await rollbackWriteoffQuietly(tx,{operation:'identity_capture_rollback',writeoff_id:payload.id},e);res.status(500);return originalJson({error:'Write-off identity evidence could not be recorded. The write-off requires supervisor review before approval.',code:'WRITEOFF_INTERNAL_ERROR',writeoff_id:payload.id});}
    })();
  };
  next();
});

router.post('/:id/approve',async(req,res,next)=>{
  try{
    await ensureWriteoffTraceability();
    const {rows:[w]}=await db.execute({sql:'SELECT * FROM inventory_writeoffs WHERE id=?',args:[req.params.id]});
    if(!w||w.status!=='pending_approval')return next();
    const profile=await getTrackingProfile(db,w.product_id);
    if(profile.tracking_mode==='none'){req.writeoffIdentityApproval={trackingMode:'none',allocations:[]};return next();}
    const {rows:alloc}=await db.execute({sql:`SELECT * FROM inventory_writeoff_identity_allocations WHERE writeoff_id=? AND status='pending_approval' ORDER BY id`,args:[w.id]});
    const total=alloc.reduce((sum,row)=>sum+Number(row.quantity||0),0);
    if(total!==Number(w.quantity))throw writeoffError('WRITEOFF_IDENTITY_CHANGED');
    req.writeoffIdentityApproval={trackingMode:profile.tracking_mode,allocations:alloc.map(row=>({allocationId:Number(row.id),serialId:row.serial_id?Number(row.serial_id):null,lotId:row.lot_id?Number(row.lot_id):null,quantity:Number(row.quantity)}))};
    return next();
  }catch(e){return sendWriteoffError(res,e,{operation:'prepare_identity_approval',writeoff_id:req.params.id});}
});
module.exports=router;
