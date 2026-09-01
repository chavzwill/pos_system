'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');

let readyPromise=null;
async function tableExists(name){const {rows:[r]}=await db.execute({sql:"SELECT name FROM sqlite_master WHERE type='table' AND name=?",args:[name]});return !!r;}
async function ensureSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS rental_assets(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_number TEXT NOT NULL UNIQUE,
        product_id INTEGER NOT NULL REFERENCES products(id),
        branch_id INTEGER NOT NULL REFERENCES branches(id),
        serial_id INTEGER REFERENCES inventory_serials(id),
        acquisition_cost REAL NOT NULL,
        acquisition_date DATE NOT NULL,
        acquisition_evidence_ref TEXT NOT NULL,
        acquisition_evidence_grade TEXT NOT NULL DEFAULT 'complete',
        status TEXT NOT NULL DEFAULT 'active',
        disposal_date DATE,
        disposal_value REAL NOT NULL DEFAULT 0,
        disposal_reason TEXT,
        created_by_employee_id INTEGER REFERENCES employees(id),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS rental_asset_allocations(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id INTEGER NOT NULL REFERENCES rental_assets(id),
        agreement_id INTEGER NOT NULL REFERENCES rental_agreements(id),
        agreement_item_id INTEGER NOT NULL REFERENCES rental_agreement_items(id),
        quantity REAL NOT NULL DEFAULT 1,
        allocation_method TEXT NOT NULL DEFAULT 'explicit_asset_assignment',
        allocated_by_employee_id INTEGER REFERENCES employees(id),
        allocated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        released_at DATETIME,
        release_reason TEXT,
        UNIQUE(asset_id,agreement_item_id)
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS rental_asset_maintenance(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id INTEGER NOT NULL REFERENCES rental_assets(id),
        maintenance_type TEXT NOT NULL,
        started_at DATETIME NOT NULL,
        ended_at DATETIME,
        direct_cost REAL NOT NULL DEFAULT 0,
        evidence_ref TEXT,
        notes TEXT,
        created_by_employee_id INTEGER REFERENCES employees(id),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:'CREATE INDEX IF NOT EXISTS idx_rental_asset_alloc_open ON rental_asset_allocations(agreement_id,agreement_item_id,released_at)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_rental_asset_status ON rental_assets(product_id,branch_id,status)'}
    ],'write');
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
async function ensureMissingAssetLink(){
  if(!(await tableExists('rental_missing_asset_dispositions')))return false;
  const {rows}=await db.execute({sql:'PRAGMA table_info(rental_missing_asset_dispositions)',args:[]});
  if(!rows.some(r=>String(r.name)==='rental_asset_id'))await db.execute({sql:'ALTER TABLE rental_missing_asset_dispositions ADD COLUMN rental_asset_id INTEGER REFERENCES rental_assets(id)',args:[]});
  return true;
}
async function agreementItems(id){
  const {rows}=await db.execute({sql:`SELECT rai.*,ra.branch_id,ra.status agreement_status,p.name product_name,p.sku
    FROM rental_agreement_items rai JOIN rental_agreements ra ON ra.id=rai.agreement_id LEFT JOIN products p ON p.id=rai.product_id WHERE rai.agreement_id=? ORDER BY rai.id`,args:[id]});
  return rows;
}
async function assignmentView(agreementId){
  await ensureSchema();
  const items=await agreementItems(agreementId),out=[];
  for(const item of items){
    const {rows:allocations}=await db.execute({sql:`SELECT aa.*,a.asset_number,a.status asset_status,a.serial_id,s.serial_number
      FROM rental_asset_allocations aa JOIN rental_assets a ON a.id=aa.asset_id LEFT JOIN inventory_serials s ON s.id=a.serial_id
      WHERE aa.agreement_item_id=? AND aa.released_at IS NULL ORDER BY aa.id`,args:[item.id]});
    const {rows:candidates}=await db.execute({sql:`SELECT a.id,a.asset_number,a.product_id,a.branch_id,a.serial_id,a.status,s.serial_number
      FROM rental_assets a LEFT JOIN inventory_serials s ON s.id=a.serial_id
      WHERE a.product_id=? AND a.branch_id=? AND a.status='active'
      AND NOT EXISTS(SELECT 1 FROM rental_asset_allocations aa WHERE aa.asset_id=a.id AND aa.released_at IS NULL)
      ORDER BY a.asset_number LIMIT 250`,args:[item.product_id,item.branch_id]});
    const {rows:[registered]}=await db.execute({sql:`SELECT COUNT(*) n FROM rental_assets WHERE product_id=? AND branch_id=? AND status IN ('active','maintenance')`,args:[item.product_id,item.branch_id]});
    out.push({...item,registered_asset_count:Number(registered?.n||0),assigned_assets:allocations,available_assets:candidates,assignment_required:Number(registered?.n||0)>0,assignment_complete:Number(registered?.n||0)===0||allocations.length>=Number(item.quantity||0)});
  }
  return out;
}

router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Rental asset workflow integration failed to initialize',detail:e.message});}});

router.get('/agreements/:id/asset-candidates',requirePermission('rentals'),async(req,res)=>{
  try{const items=await assignmentView(Number(req.params.id));if(!items.length)return res.status(404).json({error:'Rental agreement not found'});res.json({agreement_id:Number(req.params.id),items,policy:'Registered physical rental assets must be explicitly assigned before issue. Unregistered pooled rental stock remains supported.'});}catch(e){res.status(500).json({error:e.message});}
});

router.post('/agreements/:id/asset-assignments',requirePermission('rentals'),async(req,res)=>{
  try{
    const agreementId=Number(req.params.id),assignments=Array.isArray(req.body?.assignments)?req.body.assignments:[];
    if(!agreementId||!assignments.length)return res.status(400).json({error:'Agreement and at least one item-to-asset assignment are required'});
    const tx=await db.transaction('write');let committed=false;
    try{
      const {rows:[agreement]}=await tx.execute({sql:'SELECT id,branch_id,status FROM rental_agreements WHERE id=?',args:[agreementId]});
      if(!agreement)throw Object.assign(new Error('Rental agreement not found'),{status:404});
      if(!['pending','awaiting_issue','active'].includes(String(agreement.status)))throw Object.assign(new Error(`Assets cannot be assigned while rental is ${agreement.status}`),{status:409});
      for(const entry of assignments){
        const itemId=Number(entry.item_id),assetIds=[...new Set((Array.isArray(entry.asset_ids)?entry.asset_ids:[]).map(Number).filter(Boolean))];
        if(!itemId||!assetIds.length)throw Object.assign(new Error('Each assignment requires item_id and asset_ids'),{status:400});
        const {rows:[item]}=await tx.execute({sql:'SELECT id,agreement_id,product_id,quantity FROM rental_agreement_items WHERE id=? AND agreement_id=?',args:[itemId,agreementId]});
        if(!item)throw Object.assign(new Error(`Rental item ${itemId} not found`),{status:404});
        const {rows:[existing]}=await tx.execute({sql:'SELECT COUNT(*) n FROM rental_asset_allocations WHERE agreement_item_id=? AND released_at IS NULL',args:[itemId]});
        if(Number(existing?.n||0)+assetIds.length>Number(item.quantity||0))throw Object.assign(new Error('Asset assignments exceed the rental line quantity'),{status:409});
        for(const assetId of assetIds){
          const {rows:[asset]}=await tx.execute({sql:'SELECT * FROM rental_assets WHERE id=?',args:[assetId]});
          if(!asset||asset.status!=='active')throw Object.assign(new Error(`Rental asset ${assetId} is not active`),{status:409});
          if(Number(asset.product_id)!==Number(item.product_id)||Number(asset.branch_id)!==Number(agreement.branch_id))throw Object.assign(new Error(`Rental asset ${asset.asset_number||assetId} does not match the rental product and branch`),{status:409});
          const {rows:[open]}=await tx.execute({sql:'SELECT id FROM rental_asset_allocations WHERE asset_id=? AND released_at IS NULL LIMIT 1',args:[assetId]});
          if(open)throw Object.assign(new Error(`Rental asset ${asset.asset_number||assetId} is already assigned to another unresolved rental`),{status:409});
          await tx.execute({sql:`INSERT INTO rental_asset_allocations(asset_id,agreement_id,agreement_item_id,quantity,allocation_method,allocated_by_employee_id) VALUES(?,?,?,?,?,?)`,args:[assetId,agreementId,itemId,1,'explicit_asset_assignment',req.employee?.id||null]});
        }
      }
      await tx.commit();committed=true;
    }catch(e){if(!committed)await tx.rollback();throw e;}
    res.status(201).json({agreement_id:agreementId,items:await assignmentView(agreementId)});
  }catch(e){res.status(e.status||409).json({error:e.message});}
});

// Fail closed at physical issue: once a product/branch uses asset-level tracking,
// every issued unit on that line must have an explicit physical asset assignment.
router.use(async(req,res,next)=>{
  try{
    const m=String(req.path||'').match(/^\/agreements\/(\d+)\/issue\/?$/);
    if(!m||!['POST','PATCH','PUT'].includes(req.method))return next();
    const items=await assignmentView(Number(m[1]));
    const incomplete=items.filter(x=>x.assignment_required&&!x.assignment_complete);
    if(incomplete.length)return res.status(409).json({error:'Physical rental asset assignment is incomplete. Select the exact tracked asset(s) before issue.',control:'rental_asset_assignment_required',items:incomplete.map(x=>({item_id:x.id,product_name:x.product_name,quantity:Number(x.quantity||0),assigned:x.assigned_assets.length,registered_assets:x.registered_asset_count}))});
    next();
  }catch(e){res.status(500).json({error:e.message});}
});

// A missing declaration must identify the actual allocated asset whenever this
// rental line is asset-tracked. After the downstream disposition is created,
// the physical asset identity is attached to the financial loss case.
router.use(async(req,res,next)=>{
  const m=String(req.path||'').match(/^\/agreements\/(\d+)\/missing-assets\/?$/);
  if(!m||req.method!=='POST')return next();
  try{
    const itemId=Number(req.body?.item_id),assetId=req.body?.rental_asset_id==null?null:Number(req.body.rental_asset_id);
    if(itemId){
      const {rows:open}=await db.execute({sql:`SELECT aa.asset_id,a.asset_number FROM rental_asset_allocations aa JOIN rental_assets a ON a.id=aa.asset_id WHERE aa.agreement_item_id=? AND aa.agreement_id=? AND aa.released_at IS NULL`,args:[itemId,Number(m[1])]});
      if(open.length&&!assetId)return res.status(409).json({error:'Select the exact missing rental asset before creating the missing-asset disposition.',control:'rental_asset_identity_required',available_allocated_assets:open});
      if(assetId&&!open.some(x=>Number(x.asset_id)===assetId))return res.status(409).json({error:'Selected rental asset is not allocated to this rental item.'});
      req.rentalAssetMissingIdentity=assetId;
    }
    if(!req.rentalAssetMissingIdentity)return next();
    const originalJson=res.json.bind(res);let handled=false;
    res.json=function(payload){
      if(handled)return originalJson(payload);handled=true;
      if(res.statusCode>=200&&res.statusCode<300&&payload?.id){
        return ensureMissingAssetLink().then(async()=>{await db.execute({sql:'UPDATE rental_missing_asset_dispositions SET rental_asset_id=? WHERE id=?',args:[req.rentalAssetMissingIdentity,payload.id]});payload.rental_asset_id=req.rentalAssetMissingIdentity;return originalJson(payload);}).catch(e=>{res.status(500);return originalJson({error:'Missing-asset case created but asset identity finalization failed; reconciliation required',disposition_id:payload.id,detail:e.message});});
      }
      return originalJson(payload);
    };
    next();
  }catch(e){res.status(409).json({error:e.message});}
});

// When an approved missing-asset case succeeds downstream, close the asset's
// rental allocation and mark the physical asset lost. Do not fabricate an
// extra economic loss event: acquisition cost and the missing-asset accounting
// already provide separate evidence and double-counting is explicitly avoided.
router.use(async(req,res,next)=>{
  const m=String(req.path||'').match(/^\/missing-assets\/(\d+)\/approve\/?$/);
  if(!m||req.method!=='POST')return next();
  const dispositionId=Number(m[1]);
  const originalJson=res.json.bind(res);let handled=false;
  res.json=function(payload){
    if(handled)return originalJson(payload);handled=true;
    if(res.statusCode>=200&&res.statusCode<300){
      return ensureMissingAssetLink().then(async()=>{
        const {rows:[d]}=await db.execute({sql:'SELECT rental_asset_id,agreement_id,agreement_item_id,id FROM rental_missing_asset_dispositions WHERE id=?',args:[dispositionId]});
        if(d?.rental_asset_id){
          await db.execute({sql:`UPDATE rental_asset_allocations SET released_at=COALESCE(released_at,CURRENT_TIMESTAMP),release_reason=COALESCE(release_reason,?) WHERE asset_id=? AND agreement_id=? AND agreement_item_id=? AND released_at IS NULL`,args:[`Missing asset disposition RMA-${d.id}`,d.rental_asset_id,d.agreement_id,d.agreement_item_id]});
          await db.execute({sql:`UPDATE rental_assets SET status='lost',disposal_date=COALESCE(disposal_date,date('now')),disposal_value=0,disposal_reason=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status!='disposed'`,args:[`Approved missing asset disposition RMA-${d.id}`,d.rental_asset_id]});
        }
        return originalJson(payload);
      }).catch(e=>{res.status(500);return originalJson({error:'Missing-asset financial disposition succeeded but rental asset lifecycle finalization failed; reconciliation required',disposition_id:dispositionId,detail:e.message});});
    }
    return originalJson(payload);
  };
  next();
});

// A completed full return automatically releases the physical asset assignments.
// Optional asset_conditions can send a returned unit straight into maintenance
// without asking staff to separately maintain the economics ledger.
router.use(async(req,res,next)=>{
  const m=String(req.path||'').match(/^\/agreements\/(\d+)\/return\/?$/);
  if(!m||!['POST','PATCH','PUT'].includes(req.method))return next();
  const agreementId=Number(m[1]),conditions=Array.isArray(req.body?.asset_conditions)?req.body.asset_conditions:[];
  const originalJson=res.json.bind(res);let handled=false;
  res.json=function(payload){
    if(handled)return originalJson(payload);handled=true;
    if(res.statusCode>=200&&res.statusCode<300){
      return (async()=>{
        const {rows:[agreement]}=await db.execute({sql:'SELECT status FROM rental_agreements WHERE id=?',args:[agreementId]});
        if(String(agreement?.status)==='returned'){
          const {rows:open}=await db.execute({sql:'SELECT * FROM rental_asset_allocations WHERE agreement_id=? AND released_at IS NULL',args:[agreementId]});
          for(const a of open){
            await db.execute({sql:`UPDATE rental_asset_allocations SET released_at=CURRENT_TIMESTAMP,release_reason='Physical rental returned' WHERE id=? AND released_at IS NULL`,args:[a.id]});
            const c=conditions.find(x=>Number(x.asset_id)===Number(a.asset_id));
            const maintenance=!!c&&(c.maintenance_required===true||['damaged','poor','broken','repair'].includes(String(c.condition||'').toLowerCase()));
            if(maintenance){
              const evidence=String(c.evidence_ref||c.evidence_reference||'').trim();
              await db.execute({sql:`INSERT INTO rental_asset_maintenance(asset_id,maintenance_type,started_at,direct_cost,evidence_ref,notes,created_by_employee_id) VALUES(?,?,?,?,?,?,?)`,args:[a.asset_id,String(c.maintenance_type||'return_inspection'),new Date().toISOString(),0,evidence||null,String(c.notes||c.condition||'Return inspection requires maintenance'),req.employee?.id||null]});
              await db.execute({sql:`UPDATE rental_assets SET status='maintenance',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='active'`,args:[a.asset_id]});
            }
          }
        }
        return originalJson(payload);
      })().catch(e=>{res.status(500);return originalJson({error:'Rental return succeeded but physical asset lifecycle finalization failed; reconciliation required',agreement_id:agreementId,detail:e.message});});
    }
    return originalJson(payload);
  };
  next();
});

module.exports=router;
