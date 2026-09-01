'use strict';
const express=require('express');
const crypto=require('crypto');
const router=express.Router();
const {db}=require('../database');
const {ensureInventoryTraceability,getTrackingProfile}=require('../lib/inventory-traceability');

let readyPromise=null;
async function ensureReturnTraceability(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await ensureInventoryTraceability();
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS inventory_return_identity_reservations(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reservation_key TEXT NOT NULL,
        original_transaction_id INTEGER NOT NULL REFERENCES transactions(id),
        product_id INTEGER NOT NULL REFERENCES products(id),
        branch_id INTEGER NOT NULL REFERENCES branches(id),
        serial_id INTEGER REFERENCES inventory_serials(id),
        lot_id INTEGER REFERENCES inventory_lots(id),
        quantity INTEGER NOT NULL,
        employee_id INTEGER REFERENCES employees(id),
        status TEXT NOT NULL DEFAULT 'active',
        expires_at DATETIME NOT NULL,
        return_id INTEGER REFERENCES returns(id),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        finalized_at DATETIME,
        released_at DATETIME
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS inventory_return_identity_allocations(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        return_id INTEGER NOT NULL REFERENCES returns(id),
        original_transaction_id INTEGER NOT NULL REFERENCES transactions(id),
        product_id INTEGER NOT NULL REFERENCES products(id),
        branch_id INTEGER NOT NULL REFERENCES branches(id),
        serial_id INTEGER REFERENCES inventory_serials(id),
        lot_id INTEGER REFERENCES inventory_lots(id),
        quantity INTEGER NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(return_id,serial_id),
        UNIQUE(return_id,lot_id)
      )`},
      {sql:'CREATE INDEX IF NOT EXISTS idx_return_identity_res_tx ON inventory_return_identity_reservations(original_transaction_id,product_id,status,expires_at)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_return_identity_alloc_tx ON inventory_return_identity_allocations(original_transaction_id,product_id)'}
    ],'write');
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
function actor(req){return req.employee?.id||null;}
async function expireStale(executor){
  const {rows:serialRows}=await executor.execute({sql:`SELECT serial_id FROM inventory_return_identity_reservations WHERE status='active' AND expires_at<=CURRENT_TIMESTAMP AND serial_id IS NOT NULL`,args:[]});
  for(const r of serialRows)await executor.execute({sql:`UPDATE inventory_serials SET status='sold',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='return_pending'`,args:[r.serial_id]});
  await executor.execute({sql:`UPDATE inventory_return_identity_reservations SET status='expired',released_at=CURRENT_TIMESTAMP WHERE status='active' AND expires_at<=CURRENT_TIMESTAMP`,args:[]});
}

async function reserveReturnIdentities(req){
  await ensureReturnTraceability();
  if(req.body?.resolution==='replacement')return null;
  const transactionId=Number(req.params.id),items=Array.isArray(req.body?.items)?req.body.items:[];
  if(!transactionId||!items.length)return null;
  const {rows:[sale]}=await db.execute({sql:'SELECT id,branch_id FROM transactions WHERE id=?',args:[transactionId]});
  if(!sale?.branch_id)return null;
  const {rows:txItems}=await db.execute({sql:'SELECT id,product_id FROM transaction_items WHERE transaction_id=?',args:[transactionId]});
  const key=`RET-ID-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const tx=await db.transaction('write');let committed=false,hasTracked=false;
  try{
    await expireStale(tx);
    for(const line of items){
      const txLine=txItems.find(x=>Number(x.id)===Number(line.transaction_item_id));
      if(!txLine?.product_id)continue;
      const productId=Number(txLine.product_id),qty=Number(line.quantity);
      if(!Number.isInteger(qty)||qty<=0)continue;
      const profile=await getTrackingProfile(tx,productId);
      if(profile.tracking_mode==='none')continue;
      hasTracked=true;
      if(profile.tracking_mode==='serial'){
        const serials=Array.isArray(line.serial_numbers)?line.serial_numbers.map(x=>String(typeof x==='string'?x:x?.serial_number||'').trim()).filter(Boolean):[];
        if(serials.length!==qty)throw Object.assign(new Error(`Serial-controlled return requires exactly ${qty} serial numbers`),{status:409});
        if(new Set(serials.map(x=>x.toLowerCase())).size!==serials.length)throw Object.assign(new Error('The same serial cannot be returned twice in one request'),{status:409});
        for(const sn of serials){
          const {rows:[s]}=await tx.execute({sql:`SELECT s.* FROM inventory_serials s WHERE lower(s.serial_number)=lower(?) AND s.product_id=? AND s.status='sold'`,args:[sn,productId]});
          if(!s)throw Object.assign(new Error(`Serial ${sn} is not currently recorded as sold for this product`),{status:409});
          const {rows:[soldEvent]}=await tx.execute({sql:`SELECT id FROM inventory_identity_events WHERE serial_id=? AND event_type='sold' AND reference_type='transaction' AND reference_id=? ORDER BY id DESC LIMIT 1`,args:[s.id,String(transactionId)]});
          if(!soldEvent)throw Object.assign(new Error(`Serial ${sn} was not sold on transaction ${transactionId}`),{status:409});
          const u=await tx.execute({sql:`UPDATE inventory_serials SET status='return_pending',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='sold'`,args:[s.id]});
          if(Number(u.rowsAffected||0)!==1)throw Object.assign(new Error(`Serial ${sn} changed before return reservation`),{status:409});
          await tx.execute({sql:`INSERT INTO inventory_return_identity_reservations(reservation_key,original_transaction_id,product_id,branch_id,serial_id,quantity,employee_id,expires_at) VALUES(?,?,?,?,?,1,?,datetime('now','+10 minutes'))`,args:[key,transactionId,productId,sale.branch_id,s.id,actor(req)]});
        }
      }else{
        const requested=Array.isArray(line.lots)?line.lots.map(x=>({lot_number:String(x?.lot_number||'').trim(),quantity:Number(x?.quantity)})).filter(x=>x.lot_number):[];
        if(!requested.length)throw Object.assign(new Error('Lot-controlled return requires the lot number(s) originally sold'),{status:409});
        if(requested.some(x=>!Number.isInteger(x.quantity)||x.quantity<=0)||requested.reduce((s,x)=>s+x.quantity,0)!==qty)throw Object.assign(new Error(`Returned lot quantities must total ${qty}`),{status:409});
        for(const r of requested){
          const {rows:[lot]}=await tx.execute({sql:`SELECT * FROM inventory_lots WHERE product_id=? AND lot_number=? ORDER BY id LIMIT 1`,args:[productId,r.lot_number]});
          if(!lot)throw Object.assign(new Error(`Lot ${r.lot_number} is not in traceability history`),{status:409});
          const {rows:[sold]}=await tx.execute({sql:`SELECT COALESCE(SUM(quantity),0) qty FROM inventory_identity_events WHERE lot_id=? AND event_type='sold' AND reference_type='transaction' AND reference_id=?`,args:[lot.id,String(transactionId)]});
          const {rows:[returned]}=await tx.execute({sql:`SELECT COALESCE(SUM(quantity),0) qty FROM inventory_return_identity_allocations WHERE original_transaction_id=? AND lot_id=?`,args:[transactionId,lot.id]});
          const {rows:[held]}=await tx.execute({sql:`SELECT COALESCE(SUM(quantity),0) qty FROM inventory_return_identity_reservations WHERE original_transaction_id=? AND lot_id=? AND status='active' AND expires_at>CURRENT_TIMESTAMP`,args:[transactionId,lot.id]});
          const remaining=Number(sold?.qty||0)-Number(returned?.qty||0)-Number(held?.qty||0);
          if(remaining<r.quantity)throw Object.assign(new Error(`Lot ${r.lot_number} has only ${remaining} unit(s) remaining returnable from this sale`),{status:409});
          await tx.execute({sql:`INSERT INTO inventory_return_identity_reservations(reservation_key,original_transaction_id,product_id,branch_id,lot_id,quantity,employee_id,expires_at) VALUES(?,?,?,?,?,?,?,datetime('now','+10 minutes'))`,args:[key,transactionId,productId,sale.branch_id,lot.id,r.quantity,actor(req)]});
        }
      }
    }
    if(!hasTracked){await tx.rollback();return null;}
    await tx.commit();committed=true;return key;
  }catch(e){if(!committed)await tx.rollback();throw e;}
}

async function release(key,status='released'){
  if(!key)return;
  const tx=await db.transaction('write');let committed=false;
  try{
    const {rows}=await tx.execute({sql:`SELECT serial_id FROM inventory_return_identity_reservations WHERE reservation_key=? AND status='active'`,args:[key]});
    for(const r of rows)if(r.serial_id)await tx.execute({sql:`UPDATE inventory_serials SET status='sold',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='return_pending'`,args:[r.serial_id]});
    await tx.execute({sql:`UPDATE inventory_return_identity_reservations SET status=?,released_at=CURRENT_TIMESTAMP WHERE reservation_key=? AND status='active'`,args:[status,key]});
    await tx.commit();committed=true;
  }catch(e){if(!committed)await tx.rollback();throw e;}
}

async function finalize(key,returnId){
  const tx=await db.transaction('write');let committed=false;
  try{
    const {rows}=await tx.execute({sql:`SELECT * FROM inventory_return_identity_reservations WHERE reservation_key=? AND status='active' AND expires_at>CURRENT_TIMESTAMP ORDER BY id`,args:[key]});
    if(!rows.length)throw new Error('Return identity reservation expired before finalization');
    for(const r of rows){
      if(r.serial_id){
        const u=await tx.execute({sql:`UPDATE inventory_serials SET status='available',branch_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='return_pending'`,args:[r.branch_id,r.serial_id]});
        if(Number(u.rowsAffected||0)!==1)throw new Error('Returned serial identity changed before finalization');
        await tx.execute({sql:`INSERT INTO inventory_return_identity_allocations(return_id,original_transaction_id,product_id,branch_id,serial_id,quantity) VALUES(?,?,?,?,?,1)`,args:[returnId,r.original_transaction_id,r.product_id,r.branch_id,r.serial_id]});
        await tx.execute({sql:`INSERT INTO inventory_identity_events(product_id,branch_id,serial_id,event_type,quantity,reference_type,reference_id,employee_id,details) VALUES(?,?,?,?,1,'return',?,?,?)`,args:[r.product_id,r.branch_id,r.serial_id,'returned',String(returnId),r.employee_id||null,'Serialized unit returned against original sale']});
      }else if(r.lot_id){
        const u=await tx.execute({sql:`UPDATE inventory_lots SET available_quantity=available_quantity+?,branch_id=? WHERE id=?`,args:[r.quantity,r.branch_id,r.lot_id]});
        if(Number(u.rowsAffected||0)!==1)throw new Error('Returned lot identity no longer exists');
        await tx.execute({sql:`INSERT INTO inventory_return_identity_allocations(return_id,original_transaction_id,product_id,branch_id,lot_id,quantity) VALUES(?,?,?,?,?,?)`,args:[returnId,r.original_transaction_id,r.product_id,r.branch_id,r.lot_id,r.quantity]});
        await tx.execute({sql:`INSERT INTO inventory_identity_events(product_id,branch_id,lot_id,event_type,quantity,reference_type,reference_id,employee_id,details) VALUES(?,?,?,?,?,'return',?,?,?)`,args:[r.product_id,r.branch_id,r.lot_id,'returned',r.quantity,String(returnId),r.employee_id||null,'Lot-controlled inventory returned against original sale']});
      }
    }
    await tx.execute({sql:`UPDATE inventory_return_identity_reservations SET status='finalized',return_id=?,finalized_at=CURRENT_TIMESTAMP WHERE reservation_key=? AND status='active'`,args:[returnId,key]});
    await tx.commit();committed=true;
  }catch(e){if(!committed)await tx.rollback();throw e;}
}

router.post('/:id/return',async(req,res,next)=>{
  let key=null,finalized=false;
  try{key=await reserveReturnIdentities(req);if(!key)return next();}catch(e){return res.status(e.status||409).json({error:e.message});}
  const originalJson=res.json.bind(res);
  res.json=function(payload){
    const success=res.statusCode>=200&&res.statusCode<300&&payload&&payload.id;
    if(success)return finalize(key,payload.id).then(()=>{finalized=true;return originalJson(payload);}).catch(async e=>{await release(key,'finalization_failed').catch(()=>{});if(!res.headersSent){res.status(500);return originalJson({error:'Return posted but inventory identity finalization failed; return requires reconciliation',return_id:payload.id,detail:e.message});}});
    release(key).catch(()=>{});return originalJson(payload);
  };
  res.on('close',()=>{if(!finalized)release(key).catch(()=>{});});
  next();
});
module.exports=router;
module.exports.ensureReturnTraceability=ensureReturnTraceability;
