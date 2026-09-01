'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');
const {ensureInventoryTraceability,getTrackingProfile}=require('../lib/inventory-traceability');
const {ensureIdentityStatus}=require('../lib/inventory-identity-status');
const RESTRICTED=new Set(['inspection','blocked','quarantine','damaged','expired']);
const PHYSICAL_SERIAL_STATUSES=new Set(['available','inspection','blocked','quarantine','damaged','expired']);
let readyPromise=null;
async function ensureSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await ensureInventoryTraceability();await ensureIdentityStatus();
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS cycle_count_identity_observations(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES cycle_count_sessions(id),
        item_id INTEGER NOT NULL REFERENCES cycle_count_items(id),
        tracking_mode TEXT NOT NULL,
        serial_id INTEGER REFERENCES inventory_serials(id),
        lot_id INTEGER REFERENCES inventory_lots(id),
        stock_status TEXT NOT NULL DEFAULT 'available',
        quantity INTEGER NOT NULL DEFAULT 1,
        counted_by_employee_id INTEGER REFERENCES employees(id),
        observed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:'CREATE UNIQUE INDEX IF NOT EXISTS idx_cycle_obs_serial ON cycle_count_identity_observations(item_id,serial_id) WHERE serial_id IS NOT NULL'},
      {sql:'CREATE UNIQUE INDEX IF NOT EXISTS idx_cycle_obs_lot_status ON cycle_count_identity_observations(item_id,lot_id,stock_status) WHERE lot_id IS NOT NULL'},
      {sql:`CREATE TABLE IF NOT EXISTS cycle_count_identity_reconciliations(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES cycle_count_sessions(id),
        item_id INTEGER REFERENCES cycle_count_items(id),
        status TEXT NOT NULL,
        detail TEXT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        resolved_at DATETIME
      )`},
      {sql:'CREATE INDEX IF NOT EXISTS idx_cycle_identity_rec_session ON cycle_count_identity_reconciliations(session_id,status,created_at)'}
    ],'write');
  })().catch(e=>{readyPromise=null;throw e;});return readyPromise;
}
function actor(req){return req.employee?.id||null;}
function serials(v){return Array.isArray(v)?v.map(x=>String(typeof x==='string'?x:x?.serial_number||'').trim()).filter(Boolean):[];}
function lots(v){return Array.isArray(v)?v.map(x=>({lot_number:String(x?.lot_number||'').trim(),status:String(x?.status||'available').trim().toLowerCase(),quantity:Number(x?.quantity)})).filter(x=>x.lot_number):[];}

router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Cycle-count traceability initialization failed',detail:e.message});}});

router.post('/cycle-counts/:id/import',requirePermission('cyclecounts_create'),async(req,res,next)=>{
  try{
    const {rows:[session]}=await db.execute({sql:'SELECT * FROM cycle_count_sessions WHERE id=?',args:[req.params.id]});
    if(!session)return next();
    const entries=Array.isArray(req.body?.items)?req.body.items:[];const prepared=[];
    for(const entry of entries){
      const itemId=Number(entry.item_id),counted=Number(entry.counted_qty);
      const {rows:[item]}=await db.execute({sql:'SELECT * FROM cycle_count_items WHERE id=? AND session_id=?',args:[itemId,session.id]});
      if(!item||!item.product_id)continue;
      const profile=await getTrackingProfile(db,item.product_id);if(profile.tracking_mode==='none')continue;
      if(profile.tracking_mode==='serial'){
        const selected=serials(entry.serial_numbers);
        if(selected.length!==counted)return res.status(409).json({error:`Serial-controlled count for ${item.product_name} requires exactly ${counted} scanned serial numbers`});
        if(new Set(selected.map(x=>x.toLowerCase())).size!==selected.length)return res.status(409).json({error:`Duplicate serial scanned for ${item.product_name}`});
        const observations=[];
        for(const sn of selected){
          const {rows:[s]}=await db.execute({sql:'SELECT * FROM inventory_serials WHERE lower(serial_number)=lower(?) AND product_id=?',args:[sn,item.product_id]});
          if(!s)return res.status(409).json({error:`Serial ${sn} is unknown. Create an identity-reconciliation record before approving this count.`});
          if(String(s.branch_id)!==String(session.branch_id))return res.status(409).json({error:`Serial ${sn} belongs to another branch; use transfer/identity reconciliation instead of a cycle-count gain.`});
          if(!PHYSICAL_SERIAL_STATUSES.has(String(s.status)))return res.status(409).json({error:`Serial ${sn} is recorded as ${s.status} and cannot be counted as physical branch stock without reconciliation.`});
          observations.push({serial_id:s.id,status:s.status,quantity:1});
        }
        prepared.push({item,mode:'serial',observations});
      }else{
        const selected=lots(entry.lots);
        if(!selected.length)return res.status(409).json({error:`Lot-controlled count for ${item.product_name} requires lot and stock-status quantities`});
        if(selected.some(x=>!Number.isInteger(x.quantity)||x.quantity<0||!(x.status==='available'||RESTRICTED.has(x.status))))return res.status(409).json({error:`Invalid lot/status quantity for ${item.product_name}`});
        if(selected.reduce((s,x)=>s+x.quantity,0)!==counted)return res.status(409).json({error:`Lot/status observations for ${item.product_name} must total counted quantity ${counted}`});
        const keys=new Set();const observations=[];
        for(const a of selected){
          const key=`${a.lot_number.toLowerCase()}|${a.status}`;if(keys.has(key))return res.status(409).json({error:`Lot ${a.lot_number} / ${a.status} appears more than once`});keys.add(key);
          const {rows:[lot]}=await db.execute({sql:'SELECT * FROM inventory_lots WHERE product_id=? AND branch_id=? AND lot_number=? ORDER BY created_at,id LIMIT 1',args:[item.product_id,session.branch_id,a.lot_number]});
          if(!lot)return res.status(409).json({error:`Lot ${a.lot_number} is not registered at this branch; identity reconciliation is required before approval.`});
          observations.push({lot_id:lot.id,status:a.status,quantity:a.quantity});
        }
        prepared.push({item,mode:'lot',observations});
      }
    }
    if(!prepared.length)return next();
    const originalJson=res.json.bind(res);let persisted=false;
    res.json=function(payload){
      const success=res.statusCode>=200&&res.statusCode<300&&!payload?.error;
      if(!success)return originalJson(payload);
      return (async()=>{
        const tx=await db.transaction('write');let committed=false;
        try{
          for(const p of prepared){
            await tx.execute({sql:'DELETE FROM cycle_count_identity_observations WHERE item_id=?',args:[p.item.id]});
            for(const o of p.observations)await tx.execute({sql:`INSERT INTO cycle_count_identity_observations(session_id,item_id,tracking_mode,serial_id,lot_id,stock_status,quantity,counted_by_employee_id) VALUES(?,?,?,?,?,?,?,?)`,args:[session.id,p.item.id,p.mode,o.serial_id||null,o.lot_id||null,o.status,o.quantity,actor(req)]});
          }
          await tx.commit();committed=true;persisted=true;return originalJson(payload);
        }catch(e){if(!committed)await tx.rollback();res.status(500);return originalJson({error:'Count quantities were captured but identity observations failed to persist; cycle count requires reconciliation',detail:e.message});}
      })();
    };
    next();
  }catch(e){res.status(500).json({error:e.message});}
});

router.patch('/cycle-counts/:id/commit',requirePermission('cyclecounts_approve'),async(req,res,next)=>{
  try{
    const {rows:[session]}=await db.execute({sql:'SELECT * FROM cycle_count_sessions WHERE id=?',args:[req.params.id]});
    if(!session||session.status==='committed')return next();
    const {rows:items}=await db.execute({sql:'SELECT * FROM cycle_count_items WHERE session_id=? AND counted_qty IS NOT NULL ORDER BY id',args:[session.id]});
    const plans=[];
    for(const item of items){
      if(!item.product_id)continue;const profile=await getTrackingProfile(db,item.product_id);if(profile.tracking_mode==='none')continue;
      const {rows:obs}=await db.execute({sql:'SELECT * FROM cycle_count_identity_observations WHERE item_id=? ORDER BY id',args:[item.id]});
      if(profile.tracking_mode==='serial'){
        if(obs.length!==Number(item.counted_qty))return res.status(409).json({error:`Serial identity observations for ${item.product_name} do not match the counted quantity`});
        const {rows:expected}=await db.execute({sql:`SELECT * FROM inventory_serials WHERE product_id=? AND branch_id=? AND status IN ('available','inspection','blocked','quarantine','damaged','expired') ORDER BY id`,args:[item.product_id,session.branch_id]});
        const observed=new Set(obs.map(x=>Number(x.serial_id)));const missing=expected.filter(x=>!observed.has(Number(x.id)));
        if(Number(item.variance)!==-missing.length)return res.status(409).json({error:`Serial identity variance for ${item.product_name} is ${-missing.length}, but quantity variance is ${item.variance}. Recount or reconcile identities.`});
        plans.push({item,mode:'serial',missing});
      }else{
        const expected=[];
        const {rows:lotRows}=await db.execute({sql:'SELECT * FROM inventory_lots WHERE product_id=? AND branch_id=? ORDER BY id',args:[item.product_id,session.branch_id]});
        for(const lot of lotRows){
          expected.push({lot_id:lot.id,status:'available',quantity:Number(lot.available_quantity||0)});
          const {rows:rs}=await db.execute({sql:'SELECT status,quantity FROM inventory_lot_status_balances WHERE lot_id=? AND quantity!=0',args:[lot.id]});
          for(const r of rs)expected.push({lot_id:lot.id,status:r.status,quantity:Number(r.quantity||0)});
        }
        const obsMap=new Map(obs.map(x=>[`${x.lot_id}|${x.stock_status}`,Number(x.quantity||0)]));
        const keys=new Set([...expected.map(x=>`${x.lot_id}|${x.status}`),...obs.map(x=>`${x.lot_id}|${x.stock_status}`)]);const deltas=[];
        for(const k of keys){const [lotId,status]=k.split('|');const before=expected.find(x=>String(x.lot_id)===lotId&&x.status===status)?.quantity||0;const after=obsMap.get(k)||0;const delta=after-before;if(delta)deltas.push({lot_id:Number(lotId),status,delta});}
        const identityVariance=deltas.reduce((s,x)=>s+x.delta,0);
        if(identityVariance!==Number(item.variance))return res.status(409).json({error:`Lot/status identity variance for ${item.product_name} is ${identityVariance}, but quantity variance is ${item.variance}. Recount or reconcile identities.`});
        plans.push({item,mode:'lot',deltas});
      }
    }
    if(!plans.length)return next();
    const originalJson=res.json.bind(res);let finalized=false;
    res.json=function(payload){
      const success=res.statusCode>=200&&res.statusCode<300&&payload&&!payload.error;
      if(!success)return originalJson(payload);
      return (async()=>{
        const tx=await db.transaction('write');let committed=false;
        try{
          for(const p of plans){
            if(p.mode==='serial')for(const s of p.missing){
              const u=await tx.execute({sql:`UPDATE inventory_serials SET status='count_missing',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status=?`,args:[s.id,s.status]});
              if(Number(u.rowsAffected||0)!==1)throw new Error(`Serial ${s.serial_number} changed during count approval`);
              if(RESTRICTED.has(String(s.status)))await tx.execute({sql:'UPDATE inventory_stock_status_balances SET quantity=quantity-1,updated_at=CURRENT_TIMESTAMP WHERE product_id=? AND branch_id=? AND status=? AND quantity>=1',args:[p.item.product_id,session.branch_id,s.status]});
              await tx.execute({sql:`INSERT INTO inventory_identity_events(product_id,branch_id,serial_id,event_type,quantity,reference_type,reference_id,employee_id,details) VALUES(?,?,?,?,1,'cycle_count',?,?,?)`,args:[p.item.product_id,session.branch_id,s.id,'count_missing',String(session.id),actor(req),`Serial missing during cycle count ${session.session_number}`]});
            }
            if(p.mode==='lot')for(const d of p.deltas){
              if(d.status==='available'){
                const u=await tx.execute({sql:'UPDATE inventory_lots SET available_quantity=available_quantity+? WHERE id=? AND available_quantity+?>=0',args:[d.delta,d.lot_id,d.delta]});if(Number(u.rowsAffected||0)!==1)throw new Error('Lot available quantity changed during count approval');
              }else{
                const {rows:[bal]}=await tx.execute({sql:'SELECT quantity FROM inventory_lot_status_balances WHERE lot_id=? AND status=?',args:[d.lot_id,d.status]});if(Number(bal?.quantity||0)+d.delta<0)throw new Error('Lot restricted quantity changed during count approval');
                await tx.execute({sql:`INSERT INTO inventory_lot_status_balances(lot_id,status,quantity) VALUES(?,?,?) ON CONFLICT(lot_id,status) DO UPDATE SET quantity=quantity+excluded.quantity,updated_at=CURRENT_TIMESTAMP`,args:[d.lot_id,d.status,d.delta]});
                await tx.execute({sql:`INSERT INTO inventory_stock_status_balances(product_id,branch_id,status,quantity) VALUES(?,?,?,?) ON CONFLICT(product_id,branch_id,status) DO UPDATE SET quantity=quantity+excluded.quantity,updated_at=CURRENT_TIMESTAMP`,args:[p.item.product_id,session.branch_id,d.status,d.delta]});
              }
              await tx.execute({sql:`INSERT INTO inventory_identity_events(product_id,branch_id,lot_id,event_type,quantity,reference_type,reference_id,employee_id,details) VALUES(?,?,?,?,?,'cycle_count',?,?,?)`,args:[p.item.product_id,session.branch_id,d.lot_id,'count_adjustment',d.delta,String(session.id),actor(req),`Lot/status ${d.status} adjusted by cycle count ${session.session_number}`]});
            }
          }
          await tx.commit();committed=true;finalized=true;return originalJson(payload);
        }catch(e){if(!committed)await tx.rollback();await db.execute({sql:`INSERT INTO cycle_count_identity_reconciliations(session_id,status,detail) VALUES(?,'open',?)`,args:[session.id,e.message]}).catch(()=>{});res.status(500);return originalJson({error:'Cycle count posted quantity changes but identity finalization failed; cycle count requires reconciliation',session_id:session.id,detail:e.message});}
      })();
    };
    next();
  }catch(e){res.status(500).json({error:e.message});}
});

module.exports=router;
