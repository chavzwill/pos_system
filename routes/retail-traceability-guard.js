'use strict';
const express=require('express');
const crypto=require('crypto');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');
const {ensureInventoryTraceability,getTrackingProfile}=require('../lib/inventory-traceability');

router.use(require('./retail-uom-guard'));

let readyPromise=null;
async function ensureSaleTraceability(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await ensureInventoryTraceability();
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS inventory_identity_reservations(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reservation_key TEXT NOT NULL,
        product_id INTEGER NOT NULL REFERENCES products(id),
        branch_id INTEGER NOT NULL REFERENCES branches(id),
        serial_id INTEGER REFERENCES inventory_serials(id),
        lot_id INTEGER REFERENCES inventory_lots(id),
        quantity INTEGER NOT NULL,
        employee_id INTEGER REFERENCES employees(id),
        status TEXT NOT NULL DEFAULT 'active',
        expires_at DATETIME NOT NULL,
        transaction_id INTEGER REFERENCES transactions(id),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        finalized_at DATETIME,
        released_at DATETIME
      )`},
      {sql:'CREATE INDEX IF NOT EXISTS idx_identity_res_active ON inventory_identity_reservations(product_id,branch_id,status,expires_at)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_identity_res_key ON inventory_identity_reservations(reservation_key,status)'}
    ],'write');
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
function actor(req){return req.employee?.id||null;}
async function expireStale(executor){await executor.execute({sql:`UPDATE inventory_identity_reservations SET status='expired',released_at=CURRENT_TIMESTAMP WHERE status='active' AND expires_at<=CURRENT_TIMESTAMP`,args:[]});}

async function reserveIdentities(req){
  await ensureSaleTraceability();
  const body=req.body||{},branchId=Number(body.branch_id),items=Array.isArray(body.items)?body.items:[];
  if(!branchId||!items.length)return null;
  const key=`SALE-ID-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const tx=await db.transaction('write');let committed=false,hasTracked=false;
  try{
    await expireStale(tx);
    for(const line of items){
      const productId=Number(line.product_id),qty=Number(line.quantity);
      if(!productId||!Number.isInteger(qty)||qty<=0)continue;
      const profile=await getTrackingProfile(tx,productId);
      if(profile.tracking_mode==='none')continue;
      hasTracked=true;
      if(profile.tracking_mode==='serial'){
        const requested=Array.isArray(line.serial_numbers)?line.serial_numbers.map(x=>String(typeof x==='string'?x:x?.serial_number||'').trim()).filter(Boolean):[];
        if(requested.length!==qty)throw Object.assign(new Error(`Serial-controlled item requires exactly ${qty} serial numbers before checkout`),{status:409});
        if(new Set(requested.map(x=>x.toLowerCase())).size!==requested.length)throw Object.assign(new Error('The same serial number cannot be selected twice'),{status:409});
        for(const serialNumber of requested){
          const {rows:[s]}=await tx.execute({sql:`SELECT s.* FROM inventory_serials s WHERE lower(s.serial_number)=lower(?) AND s.product_id=? AND s.branch_id=? AND s.status='available'`,args:[serialNumber,productId,branchId]});
          if(!s)throw Object.assign(new Error(`Serial ${serialNumber} is not available at the selling branch`),{status:409});
          if(s.expiry_date&&new Date(`${s.expiry_date}T23:59:59Z`).getTime()<Date.now())throw Object.assign(new Error(`Serial ${serialNumber} is expired and cannot be sold`),{status:409});
          const {rows:[held]}=await tx.execute({sql:`SELECT id FROM inventory_identity_reservations WHERE serial_id=? AND status='active' AND expires_at>CURRENT_TIMESTAMP`,args:[s.id]});
          if(held)throw Object.assign(new Error(`Serial ${serialNumber} is already reserved by another transaction`),{status:409});
          await tx.execute({sql:`INSERT INTO inventory_identity_reservations(reservation_key,product_id,branch_id,serial_id,quantity,employee_id,expires_at) VALUES(?,?,?,?,1,?,datetime('now','+5 minutes'))`,args:[key,productId,branchId,s.id,actor(req)]});
        }
      }else if(profile.tracking_mode==='lot'){
        const requested=Array.isArray(line.lots)?line.lots.map(x=>({lot_number:String(x?.lot_number||'').trim(),quantity:Number(x?.quantity)})).filter(x=>x.lot_number):[];
        let allocations=[];
        if(requested.length){
          if(requested.some(x=>!Number.isInteger(x.quantity)||x.quantity<=0)||requested.reduce((s,x)=>s+x.quantity,0)!==qty)throw Object.assign(new Error(`Selected lot quantities must total ${qty}`),{status:409});
          for(const r of requested){
            const {rows:[lot]}=await tx.execute({sql:`SELECT * FROM inventory_lots WHERE product_id=? AND branch_id=? AND lot_number=? AND status='available' ORDER BY created_at,id LIMIT 1`,args:[productId,branchId,r.lot_number]});
            if(!lot)throw Object.assign(new Error(`Lot ${r.lot_number} is not available at the selling branch`),{status:409});
            allocations.push({lot,quantity:r.quantity});
          }
        }else{
          const {rows:lots}=await tx.execute({sql:`SELECT * FROM inventory_lots WHERE product_id=? AND branch_id=? AND status='available' AND available_quantity>0 AND (expiry_date IS NULL OR date(expiry_date)>=date('now')) ORDER BY CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END,date(expiry_date),created_at,id`,args:[productId,branchId]});
          let remaining=qty;
          for(const lot of lots){if(remaining<=0)break;const take=Math.min(remaining,Number(lot.available_quantity||0));if(take>0){allocations.push({lot,quantity:take});remaining-=take;}}
          if(remaining>0)throw Object.assign(new Error(`Insufficient non-expired lot-controlled stock; ${remaining} unit(s) cannot be allocated`),{status:409});
          line.lots=allocations.map(x=>({lot_number:x.lot.lot_number,quantity:x.quantity,expiry_date:x.lot.expiry_date||null}));
        }
        for(const a of allocations){
          const {rows:[held]}=await tx.execute({sql:`SELECT COALESCE(SUM(quantity),0) qty FROM inventory_identity_reservations WHERE lot_id=? AND status='active' AND expires_at>CURRENT_TIMESTAMP`,args:[a.lot.id]});
          const free=Number(a.lot.available_quantity||0)-Number(held?.qty||0);
          if(free<a.quantity)throw Object.assign(new Error(`Lot ${a.lot.lot_number} has only ${free} unreserved unit(s) available`),{status:409});
          await tx.execute({sql:`INSERT INTO inventory_identity_reservations(reservation_key,product_id,branch_id,lot_id,quantity,employee_id,expires_at) VALUES(?,?,?,?,?,?,datetime('now','+5 minutes'))`,args:[key,productId,branchId,a.lot.id,a.quantity,actor(req)]});
        }
      }
    }
    if(!hasTracked){await tx.rollback();return null;}
    await tx.commit();committed=true;return key;
  }catch(e){if(!committed)await tx.rollback();throw e;}
}

async function release(key,status='released'){
  if(!key)return;
  await db.execute({sql:`UPDATE inventory_identity_reservations SET status=?,released_at=CURRENT_TIMESTAMP WHERE reservation_key=? AND status='active'`,args:[status,key]});
}
async function finalize(key,transactionId){
  if(!key||!transactionId)return;
  const tx=await db.transaction('write');let committed=false;
  try{
    const {rows:rows}=await tx.execute({sql:`SELECT * FROM inventory_identity_reservations WHERE reservation_key=? AND status='active' AND expires_at>CURRENT_TIMESTAMP ORDER BY id`,args:[key]});
    if(!rows.length)throw new Error('Inventory identity reservation expired before sale finalization');
    for(const r of rows){
      if(r.serial_id){
        const u=await tx.execute({sql:`UPDATE inventory_serials SET status='sold',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='available'`,args:[r.serial_id]});
        if(Number(u.rowsAffected||0)!==1)throw new Error('Reserved serial identity changed before sale finalization');
        await tx.execute({sql:`INSERT INTO inventory_identity_events(product_id,branch_id,serial_id,event_type,quantity,reference_type,reference_id,employee_id,details) VALUES(?,?,?,?,1,'transaction',?,?,?)`,args:[r.product_id,r.branch_id,r.serial_id,'sold',String(transactionId),r.employee_id||null,'Serialized unit sold through POS']});
      }else if(r.lot_id){
        const u=await tx.execute({sql:`UPDATE inventory_lots SET available_quantity=available_quantity-? WHERE id=? AND status='available' AND available_quantity>=?`,args:[r.quantity,r.lot_id,r.quantity]});
        if(Number(u.rowsAffected||0)!==1)throw new Error('Reserved lot quantity changed before sale finalization');
        await tx.execute({sql:`INSERT INTO inventory_identity_events(product_id,branch_id,lot_id,event_type,quantity,reference_type,reference_id,employee_id,details) VALUES(?,?,?,?,?,'transaction',?,?,?)`,args:[r.product_id,r.branch_id,r.lot_id,'sold',r.quantity,String(transactionId),r.employee_id||null,'Lot-controlled units sold through POS']});
      }
    }
    await tx.execute({sql:`UPDATE inventory_identity_reservations SET status='finalized',transaction_id=?,finalized_at=CURRENT_TIMESTAMP WHERE reservation_key=? AND status='active'`,args:[transactionId,key]});
    await tx.commit();committed=true;
  }catch(e){if(!committed)await tx.rollback();throw e;}
}

router.post('/',requirePermission('pos'),async(req,res,next)=>{
  let key=null,finalized=false;
  try{key=await reserveIdentities(req);if(!key)return next();req.inventoryIdentityReservationKey=key;}catch(e){return res.status(e.status||409).json({error:e.message});}
  const originalJson=res.json.bind(res);
  res.json=function(payload){
    const success=res.statusCode>=200&&res.statusCode<300&&payload&&payload.id;
    if(success){
      return finalize(key,payload.id).then(()=>{finalized=true;return originalJson(payload);}).catch(async e=>{await release(key,'finalization_failed').catch(()=>{});if(!res.headersSent){res.status(500);return originalJson({error:'Sale posted but inventory identity finalization failed; transaction requires reconciliation',transaction_id:payload.id,detail:e.message});}});
    }
    release(key).catch(()=>{});return originalJson(payload);
  };
  res.on('close',()=>{if(!finalized)release(key).catch(()=>{});});
  next();
});

module.exports=router;
