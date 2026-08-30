'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requireAnyPermission}=require('../lib/permissions');

let readyPromise=null;
async function ensureColumn(table,name,definition){const {rows}=await db.execute({sql:`PRAGMA table_info(${table})`,args:[]});if(!rows.some(r=>String(r.name)===name))await db.execute({sql:`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`,args:[]});}
async function ensureSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await ensureColumn('rental_assets','retired_at','DATETIME');
    await ensureColumn('rental_assets','retirement_reason','TEXT');
    await ensureColumn('rental_assets','retirement_disposition','TEXT');
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS rental_asset_lifecycle_events(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id INTEGER NOT NULL REFERENCES rental_assets(id),
        event_type TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT NOT NULL,
        reason TEXT NOT NULL,
        disposition TEXT,
        evidence_ref TEXT,
        employee_id INTEGER REFERENCES employees(id),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:'CREATE INDEX IF NOT EXISTS idx_rental_asset_lifecycle_asset ON rental_asset_lifecycle_events(asset_id,created_at,id)'}
    ],'write');
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
async function asset(id){const {rows:[a]}=await db.execute({sql:`SELECT a.*,p.name product_name,p.sku,s.serial_number FROM rental_assets a JOIN products p ON p.id=a.product_id LEFT JOIN inventory_serials s ON s.id=a.serial_id WHERE a.id=?`,args:[id]});return a||null;}
async function openAllocation(assetId){const {rows:[r]}=await db.execute({sql:'SELECT id,agreement_id,agreement_item_id FROM rental_asset_allocations WHERE asset_id=? AND released_at IS NULL LIMIT 1',args:[assetId]});return r||null;}
async function openMaintenance(assetId){const {rows:[r]}=await db.execute({sql:'SELECT id,maintenance_type,started_at FROM rental_asset_maintenance WHERE asset_id=? AND ended_at IS NULL LIMIT 1',args:[assetId]});return r||null;}
async function event(assetId,type,from,to,reason,disposition,evidence,employeeId){await db.execute({sql:`INSERT INTO rental_asset_lifecycle_events(asset_id,event_type,from_status,to_status,reason,disposition,evidence_ref,employee_id) VALUES(?,?,?,?,?,?,?,?)`,args:[assetId,type,from||null,to,reason,disposition||null,evidence||null,employeeId||null]});}
router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Rental asset lifecycle controls failed to initialize',detail:e.message});}});

router.get('/assets/:id/lifecycle',requireAnyPermission('rentals','reports_financial'),async(req,res)=>{
  try{const a=await asset(Number(req.params.id));if(!a)return res.status(404).json({error:'Rental asset not found'});const {rows:events}=await db.execute({sql:'SELECT * FROM rental_asset_lifecycle_events WHERE asset_id=? ORDER BY created_at,id',args:[a.id]});res.json({asset:a,events});}catch(e){res.status(500).json({error:e.message});}
});

router.post('/assets/:id/retire',requireAnyPermission('rentals_manage','reports_financial'),async(req,res)=>{
  try{
    const id=Number(req.params.id),reason=String(req.body?.reason||'').trim(),disposition=String(req.body?.disposition||'retired').trim().toLowerCase(),evidence=String(req.body?.evidence_ref||'').trim();
    const allowed=new Set(['retired','awaiting_sale','internal_use','reserve','parts_donor','long_term_storage']);
    if(reason.length<5)return res.status(400).json({error:'A meaningful retirement reason is required'});
    if(!allowed.has(disposition))return res.status(400).json({error:'Invalid retirement disposition'});
    const a=await asset(id);if(!a)return res.status(404).json({error:'Rental asset not found'});
    if(['lost','sold','disposed'].includes(String(a.status)))return res.status(409).json({error:`A ${a.status} asset cannot be retired from rental.`});
    if(await openAllocation(id))return res.status(409).json({error:'Rental asset cannot be retired while allocated to an unresolved rental.'});
    if(await openMaintenance(id))return res.status(409).json({error:'Complete or formally close maintenance before retiring this asset.'});
    if(['retired','awaiting_sale','internal_use','reserve','parts_donor','long_term_storage'].includes(String(a.status)))return res.status(409).json({error:`Rental asset is already outside active rental service (${a.status}).`});
    await db.execute({sql:`UPDATE rental_assets SET status=?,retired_at=CURRENT_TIMESTAMP,retirement_reason=?,retirement_disposition=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`,args:[disposition,reason,disposition,id]});
    await event(id,'retired_from_rental',a.status,disposition,reason,disposition,evidence,req.employee?.id||null);
    res.json(await asset(id));
  }catch(e){res.status(409).json({error:e.message});}
});

router.post('/assets/:id/reactivate',requireAnyPermission('rentals_manage','reports_financial'),async(req,res)=>{
  try{
    const id=Number(req.params.id),reason=String(req.body?.reason||'').trim(),evidence=String(req.body?.evidence_ref||'').trim();
    if(reason.length<5)return res.status(400).json({error:'A meaningful reactivation reason is required'});
    const a=await asset(id);if(!a)return res.status(404).json({error:'Rental asset not found'});
    const reactivatable=new Set(['retired','awaiting_sale','internal_use','reserve','long_term_storage']);
    if(!reactivatable.has(String(a.status)))return res.status(409).json({error:`Rental asset cannot be returned to rental service from ${a.status}.`});
    if(await openAllocation(id))return res.status(409).json({error:'Rental asset has an unresolved allocation and cannot be reactivated safely.'});
    if(await openMaintenance(id))return res.status(409).json({error:'Complete maintenance before returning this asset to rental service.'});
    await db.execute({sql:`UPDATE rental_assets SET status='active',retired_at=NULL,retirement_reason=NULL,retirement_disposition=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?`,args:[id]});
    await event(id,'reactivated_for_rental',a.status,'active',reason,null,evidence,req.employee?.id||null);
    res.json(await asset(id));
  }catch(e){res.status(409).json({error:e.message});}
});

router.post('/assets/:id/hold-for-sale',requireAnyPermission('rentals_manage','reports_financial'),async(req,res)=>{
  try{
    const id=Number(req.params.id),reason=String(req.body?.reason||'').trim(),evidence=String(req.body?.evidence_ref||'').trim();
    if(reason.length<5)return res.status(400).json({error:'A meaningful hold-for-sale reason is required'});
    const a=await asset(id);if(!a)return res.status(404).json({error:'Rental asset not found'});
    if(['lost','sold','disposed'].includes(String(a.status)))return res.status(409).json({error:`A ${a.status} asset cannot be held for sale.`});
    if(await openAllocation(id))return res.status(409).json({error:'Rental asset cannot be offered for sale while allocated to an unresolved rental.'});
    if(await openMaintenance(id))return res.status(409).json({error:'Complete or close maintenance before placing this asset on sale hold.'});
    const from=a.status;
    await db.execute({sql:`UPDATE rental_assets SET status='awaiting_sale',retired_at=COALESCE(retired_at,CURRENT_TIMESTAMP),retirement_reason=?,retirement_disposition='awaiting_sale',updated_at=CURRENT_TIMESTAMP WHERE id=?`,args:[reason,id]});
    await event(id,'held_for_sale',from,'awaiting_sale',reason,'awaiting_sale',evidence,req.employee?.id||null);
    res.json(await asset(id));
  }catch(e){res.status(409).json({error:e.message});}
});

module.exports=router;
module.exports.ensureSchema=ensureSchema;
