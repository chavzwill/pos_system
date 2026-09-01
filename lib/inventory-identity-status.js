'use strict';
const { db } = require('../database');
const { ensureInventoryTraceability, getTrackingProfile } = require('./inventory-traceability');
const { STATUSES } = require('./inventory-stock-status');
let readyPromise=null;
async function ensureIdentityStatus(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await ensureInventoryTraceability();
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS inventory_lot_status_balances(
        lot_id INTEGER NOT NULL REFERENCES inventory_lots(id),
        status TEXT NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 0,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(lot_id,status)
      )`},
      {sql:'CREATE INDEX IF NOT EXISTS idx_lot_status_balance ON inventory_lot_status_balances(lot_id,status)'}
    ],'write');
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
function cleanSerials(v){return Array.isArray(v)?v.map(x=>String(typeof x==='string'?x:x?.serial_number||'').trim()).filter(Boolean):[];}
function cleanLots(v){return Array.isArray(v)?v.map(x=>({lot_number:String(x?.lot_number||'').trim(),quantity:Number(x?.quantity)})).filter(x=>x.lot_number):[];}
async function moveIdentityStatus(executor,{productId,branchId,fromStatus='available',toStatus,quantity,serialNumbers,lots,employeeId,reason,reference}){
  await ensureIdentityStatus();
  const profile=await getTrackingProfile(executor,productId);
  if(profile.tracking_mode==='none')return {tracking_mode:'none'};
  const qty=Number(quantity);
  if(profile.tracking_mode==='serial'){
    const selected=cleanSerials(serialNumbers);
    if(selected.length!==qty)throw new Error(`Serial-controlled disposition requires exactly ${qty} serial numbers`);
    if(new Set(selected.map(x=>x.toLowerCase())).size!==selected.length)throw new Error('The same serial number cannot be selected twice');
    for(const serial of selected){
      const {rows:[s]}=await executor.execute({sql:`SELECT * FROM inventory_serials WHERE lower(serial_number)=lower(?) AND product_id=? AND branch_id=?`,args:[serial,productId,branchId]});
      if(!s)throw new Error(`Serial ${serial} does not belong to this product and branch`);
      if(String(s.status)!==String(fromStatus))throw new Error(`Serial ${serial} is ${s.status}, not ${fromStatus}`);
      const u=await executor.execute({sql:`UPDATE inventory_serials SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status=?`,args:[toStatus,s.id,fromStatus]});
      if(Number(u.rowsAffected||0)!==1)throw new Error(`Serial ${serial} changed during disposition; reload and retry`);
      await executor.execute({sql:`INSERT INTO inventory_identity_events(product_id,branch_id,serial_id,event_type,quantity,reference_type,reference_id,employee_id,details) VALUES(?,?,?,?,1,'stock_status',?,?,?)`,args:[productId,branchId,s.id,'status_changed',String(reference||''),employeeId||null,`${fromStatus} -> ${toStatus}: ${String(reason||'').trim()}`]});
    }
    return {tracking_mode:'serial',serial_numbers:selected};
  }
  const allocations=cleanLots(lots);
  if(!allocations.length)throw new Error('Lot-controlled disposition requires exact lot allocation');
  if(allocations.some(x=>!Number.isInteger(x.quantity)||x.quantity<=0)||allocations.reduce((s,x)=>s+x.quantity,0)!==qty)throw new Error(`Lot-controlled disposition allocations must total ${qty}`);
  for(const a of allocations){
    const {rows:[lot]}=await executor.execute({sql:`SELECT * FROM inventory_lots WHERE product_id=? AND branch_id=? AND lot_number=? ORDER BY created_at,id LIMIT 1`,args:[productId,branchId,a.lot_number]});
    if(!lot)throw new Error(`Lot ${a.lot_number} does not belong to this product and branch`);
    if(fromStatus==='available'){
      const u=await executor.execute({sql:`UPDATE inventory_lots SET available_quantity=available_quantity-? WHERE id=? AND available_quantity>=?`,args:[a.quantity,lot.id,a.quantity]});
      if(Number(u.rowsAffected||0)!==1)throw new Error(`Lot ${a.lot_number} no longer has ${a.quantity} available units`);
    }else{
      const {rows:[bal]}=await executor.execute({sql:'SELECT quantity FROM inventory_lot_status_balances WHERE lot_id=? AND status=?',args:[lot.id,fromStatus]});
      if(Number(bal?.quantity||0)<a.quantity)throw new Error(`Lot ${a.lot_number} has only ${Number(bal?.quantity||0)} units in ${fromStatus}`);
      await executor.execute({sql:'UPDATE inventory_lot_status_balances SET quantity=quantity-?,updated_at=CURRENT_TIMESTAMP WHERE lot_id=? AND status=?',args:[a.quantity,lot.id,fromStatus]});
    }
    if(toStatus==='available'){
      await executor.execute({sql:'UPDATE inventory_lots SET available_quantity=available_quantity+? WHERE id=?',args:[a.quantity,lot.id]});
    }else{
      if(!STATUSES.has(toStatus))throw new Error('Invalid destination lot stock status');
      await executor.execute({sql:`INSERT INTO inventory_lot_status_balances(lot_id,status,quantity) VALUES(?,?,?) ON CONFLICT(lot_id,status) DO UPDATE SET quantity=quantity+excluded.quantity,updated_at=CURRENT_TIMESTAMP`,args:[lot.id,toStatus,a.quantity]});
    }
    await executor.execute({sql:`INSERT INTO inventory_identity_events(product_id,branch_id,lot_id,event_type,quantity,reference_type,reference_id,employee_id,details) VALUES(?,?,?,?,?,'stock_status',?,?,?)`,args:[productId,branchId,lot.id,'status_changed',a.quantity,String(reference||''),employeeId||null,`${fromStatus} -> ${toStatus}: ${String(reason||'').trim()}`]});
  }
  return {tracking_mode:'lot',lots:allocations};
}
module.exports={ensureIdentityStatus,moveIdentityStatus};
