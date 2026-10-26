'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {can,requireAnyPermission,requirePermission}=require('../lib/permissions');

const costReader=require('../lib/rental-consumable-economics');
const rentalRevenue=require('../lib/rental-asset-revenue');
const costAccess=require('./rental-consumable-economics');
let readyPromise=null;
async function ensureSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=db.batch([
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
    {sql:'CREATE UNIQUE INDEX IF NOT EXISTS idx_rental_assets_serial ON rental_assets(serial_id) WHERE serial_id IS NOT NULL'},
    {sql:'CREATE INDEX IF NOT EXISTS idx_rental_assets_product_branch ON rental_assets(product_id,branch_id,status)'},
    {sql:`CREATE TABLE IF NOT EXISTS rental_asset_allocations(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id INTEGER NOT NULL REFERENCES rental_assets(id),
      agreement_id INTEGER NOT NULL REFERENCES rental_agreements(id),
      agreement_item_id INTEGER NOT NULL REFERENCES rental_agreement_items(id),
      quantity REAL NOT NULL DEFAULT 1,
      allocation_method TEXT NOT NULL DEFAULT 'equal_share_per_issued_unit',
      allocated_by_employee_id INTEGER REFERENCES employees(id),
      allocated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      released_at DATETIME,
      release_reason TEXT,
      UNIQUE(asset_id,agreement_item_id)
    )`},
    {sql:'CREATE INDEX IF NOT EXISTS idx_rental_asset_allocations_asset ON rental_asset_allocations(asset_id,allocated_at)'},
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
    {sql:'CREATE INDEX IF NOT EXISTS idx_rental_asset_maintenance_asset ON rental_asset_maintenance(asset_id,started_at)'},
    {sql:`CREATE TABLE IF NOT EXISTS rental_asset_economic_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id INTEGER NOT NULL REFERENCES rental_assets(id),
      event_type TEXT NOT NULL,
      amount REAL NOT NULL,
      evidence_ref TEXT NOT NULL,
      event_date DATE NOT NULL,
      notes TEXT,
      created_by_employee_id INTEGER REFERENCES employees(id),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`},
    {sql:'CREATE INDEX IF NOT EXISTS idx_rental_asset_economic_events_asset ON rental_asset_economic_events(asset_id,event_date)'}
  ],'write').catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
const money=v=>Number(Number(v||0).toFixed(2));
const positiveMoney=v=>{const n=Number(v);return Number.isFinite(n)&&n>=0?n:null;};
function assetNumber(){return `RA-${Date.now()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`;}
async function getAsset(id,executor=db){const {rows:[x]}=await executor.execute({sql:`SELECT a.*,p.name product_name,p.sku,b.name branch_name,s.serial_number FROM rental_assets a JOIN products p ON p.id=a.product_id JOIN branches b ON b.id=a.branch_id LEFT JOIN inventory_serials s ON s.id=a.serial_id WHERE a.id=?`,args:[id]});return x||null;}

router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Rental asset economics initialization failed',detail:e.message});}});

router.post('/assets',requirePermission('rentals'),async(req,res)=>{
  try{
    const productId=Number(req.body?.product_id),branchId=Number(req.body?.branch_id),serialId=req.body?.serial_id==null?null:Number(req.body.serial_id),cost=positiveMoney(req.body?.acquisition_cost),date=String(req.body?.acquisition_date||'').trim(),evidence=String(req.body?.acquisition_evidence_ref||'').trim(),grade=String(req.body?.acquisition_evidence_grade||'complete').toLowerCase();
    if(!productId||!branchId||cost==null||!date||!evidence)return res.status(400).json({error:'Product, branch, non-negative acquisition cost, acquisition date and evidence reference are required'});
    if(!['complete','partial'].includes(grade))return res.status(400).json({error:'Acquisition evidence grade must be complete or partial'});
    const {rows:[p]}=await db.execute({sql:'SELECT id,is_rental,active FROM products WHERE id=?',args:[productId]});
    if(!p||!p.active)return res.status(404).json({error:'Rental product not found'});
    if(!p.is_rental)return res.status(409).json({error:'Only rental products can be registered as rental assets'});
    if(serialId){const {rows:[s]}=await db.execute({sql:'SELECT id,product_id,branch_id FROM inventory_serials WHERE id=?',args:[serialId]});if(!s)return res.status(404).json({error:'Inventory serial not found'});if(Number(s.product_id)!==productId||Number(s.branch_id)!==branchId)return res.status(409).json({error:'Inventory serial does not match the rental product and branch'});}
    const number=String(req.body?.asset_number||'').trim()||assetNumber();
    const r=await db.execute({sql:`INSERT INTO rental_assets(asset_number,product_id,branch_id,serial_id,acquisition_cost,acquisition_date,acquisition_evidence_ref,acquisition_evidence_grade,created_by_employee_id) VALUES(?,?,?,?,?,?,?,?,?)`,args:[number,productId,branchId,serialId,cost,date,evidence,grade,req.employee?.id||null]});
    res.status(201).json(await getAsset(Number(r.lastInsertRowid)));
  }catch(e){res.status(409).json({error:e.message});}
});

router.post('/assets/:id/allocations',requirePermission('rentals'),async(req,res)=>{
  try{
    const assetId=Number(req.params.id),agreementItemId=Number(req.body?.agreement_item_id);if(!assetId||!agreementItemId)return res.status(400).json({error:'Asset and rental agreement item are required'});
    const tx=await db.transaction('write');let committed=false;
    try{
      const asset=await getAsset(assetId,tx);if(!asset)throw Object.assign(new Error('Rental asset not found'),{status:404});if(asset.status!=='active')throw Object.assign(new Error('Only active rental assets can be allocated'),{status:409});
      const {rows:[open]}=await tx.execute({sql:'SELECT id FROM rental_asset_allocations WHERE asset_id=? AND released_at IS NULL LIMIT 1',args:[assetId]});if(open)throw Object.assign(new Error('Rental asset is already allocated to an unresolved rental'),{status:409});
      const {rows:[item]}=await tx.execute({sql:`SELECT rai.*,ra.branch_id,ra.status agreement_status FROM rental_agreement_items rai JOIN rental_agreements ra ON ra.id=rai.agreement_id WHERE rai.id=?`,args:[agreementItemId]});
      if(!item)throw Object.assign(new Error('Rental agreement item not found'),{status:404});if(Number(item.product_id)!==Number(asset.product_id))throw Object.assign(new Error('Rental asset product does not match the rental line'),{status:409});if(Number(item.branch_id)!==Number(asset.branch_id))throw Object.assign(new Error('Rental asset must be allocated from the agreement branch'),{status:409});if(!['pending','awaiting_issue','active'].includes(String(item.agreement_status)))throw Object.assign(new Error('Rental agreement is not in an allocatable state'),{status:409});
      const issued=Math.max(1,Number(item.quantity||1));const {rows:[count]}=await tx.execute({sql:'SELECT COUNT(*) n FROM rental_asset_allocations WHERE agreement_item_id=? AND released_at IS NULL',args:[agreementItemId]});if(Number(count?.n||0)>=issued)throw Object.assign(new Error('All issued units on this rental line already have asset allocations'),{status:409});
      const r=await tx.execute({sql:`INSERT INTO rental_asset_allocations(asset_id,agreement_id,agreement_item_id,quantity,allocated_by_employee_id) VALUES(?,?,?,?,?)`,args:[assetId,item.agreement_id,agreementItemId,1,req.employee?.id||null]});
      await tx.commit();committed=true;const {rows:[row]}=await db.execute({sql:'SELECT * FROM rental_asset_allocations WHERE id=?',args:[Number(r.lastInsertRowid)]});res.status(201).json(row);
    }catch(e){if(!committed)await tx.rollback();throw e;}
  }catch(e){res.status(e.status||409).json({error:e.message});}
});

router.post('/assets/:id/allocations/:allocationId/release',requirePermission('rentals'),async(req,res)=>{
  try{const assetId=Number(req.params.id),allocationId=Number(req.params.allocationId),reason=String(req.body?.reason||'Rental resolved').trim();const r=await db.execute({sql:`UPDATE rental_asset_allocations SET released_at=CURRENT_TIMESTAMP,release_reason=? WHERE id=? AND asset_id=? AND released_at IS NULL`,args:[reason,allocationId,assetId]});if(Number(r.rowsAffected||0)!==1)return res.status(409).json({error:'Active allocation not found'});res.json({success:true});}catch(e){res.status(409).json({error:e.message});}
});

router.post('/assets/:id/maintenance',requirePermission('rentals'),async(req,res)=>{
  try{
    const assetId=Number(req.params.id),type=String(req.body?.maintenance_type||'maintenance').trim(),started=String(req.body?.started_at||new Date().toISOString()).trim(),ended=req.body?.ended_at?String(req.body.ended_at):null,cost=positiveMoney(req.body?.direct_cost??0),evidence=String(req.body?.evidence_ref||'').trim(),notes=String(req.body?.notes||'').trim();
    const asset=await getAsset(assetId);if(!asset)return res.status(404).json({error:'Rental asset not found'});if(asset.status==='disposed'||asset.status==='lost')return res.status(409).json({error:'Disposed/lost assets cannot enter maintenance'});if(cost==null)return res.status(400).json({error:'Maintenance direct cost must be non-negative'});if(cost>0&&!evidence)return res.status(400).json({error:'Cost evidence reference is required when maintenance has a direct cost'});
    const {rows:[open]}=await db.execute({sql:'SELECT id FROM rental_asset_allocations WHERE asset_id=? AND released_at IS NULL LIMIT 1',args:[assetId]});if(open)return res.status(409).json({error:'Release the active rental allocation before putting the asset into maintenance'});
    const r=await db.execute({sql:`INSERT INTO rental_asset_maintenance(asset_id,maintenance_type,started_at,ended_at,direct_cost,evidence_ref,notes,created_by_employee_id) VALUES(?,?,?,?,?,?,?,?)`,args:[assetId,type,started,ended,cost,evidence||null,notes||null,req.employee?.id||null]});
    await db.execute({sql:`UPDATE rental_assets SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`,args:[ended?'active':'maintenance',assetId]});const {rows:[row]}=await db.execute({sql:'SELECT * FROM rental_asset_maintenance WHERE id=?',args:[Number(r.lastInsertRowid)]});res.status(201).json(row);
  }catch(e){res.status(409).json({error:e.message});}
});

router.post('/assets/:id/maintenance/:maintenanceId/complete',requirePermission('rentals'),async(req,res)=>{
  try{const assetId=Number(req.params.id),mid=Number(req.params.maintenanceId),ended=String(req.body?.ended_at||new Date().toISOString()),addCost=positiveMoney(req.body?.additional_cost??0),evidence=String(req.body?.evidence_ref||'').trim();if(addCost==null)return res.status(400).json({error:'Additional cost must be non-negative'});if(addCost>0&&!evidence)return res.status(400).json({error:'Evidence reference is required for additional maintenance cost'});const {rows:[m]}=await db.execute({sql:'SELECT * FROM rental_asset_maintenance WHERE id=? AND asset_id=? AND ended_at IS NULL',args:[mid,assetId]});if(!m)return res.status(404).json({error:'Open maintenance event not found'});await db.execute({sql:`UPDATE rental_asset_maintenance SET ended_at=?,direct_cost=direct_cost+?,evidence_ref=CASE WHEN ?!='' THEN ? ELSE evidence_ref END WHERE id=?`,args:[ended,addCost,evidence,evidence,mid]});await db.execute({sql:`UPDATE rental_assets SET status='active',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='maintenance'`,args:[assetId]});res.json({success:true});}catch(e){res.status(409).json({error:e.message});}
});

router.post('/assets/:id/economic-events',requireAnyPermission('reports_financial','rentals'),async(req,res)=>{
  try{const assetId=Number(req.params.id),type=String(req.body?.event_type||'').trim(),amount=positiveMoney(req.body?.amount),evidence=String(req.body?.evidence_ref||'').trim(),date=String(req.body?.event_date||new Date().toISOString().slice(0,10)),notes=String(req.body?.notes||'').trim();const allowed=new Set(['damage_recovery','other_recovery','unrecovered_damage_loss','other_direct_cost']);if(!allowed.has(type)||amount==null||!evidence)return res.status(400).json({error:'Valid event type, non-negative amount and evidence reference are required'});if(!(await getAsset(assetId)))return res.status(404).json({error:'Rental asset not found'});const r=await db.execute({sql:`INSERT INTO rental_asset_economic_events(asset_id,event_type,amount,evidence_ref,event_date,notes,created_by_employee_id) VALUES(?,?,?,?,?,?,?)`,args:[assetId,type,amount,evidence,date,notes||null,req.employee?.id||null]});const {rows:[row]}=await db.execute({sql:'SELECT * FROM rental_asset_economic_events WHERE id=?',args:[Number(r.lastInsertRowid)]});res.status(201).json(row);}catch(e){res.status(409).json({error:e.message});}
});

router.post('/assets/:id/dispose',requireAnyPermission('reports_financial','inventory_writeoff_approve'),async(req,res)=>{
  try{const assetId=Number(req.params.id),value=positiveMoney(req.body?.disposal_value??0),date=String(req.body?.disposal_date||new Date().toISOString().slice(0,10)),reason=String(req.body?.reason||'').trim(),evidence=String(req.body?.evidence_ref||'').trim();if(value==null||!reason||!evidence)return res.status(400).json({error:'Disposal value, reason and evidence reference are required'});const {rows:[open]}=await db.execute({sql:'SELECT id FROM rental_asset_allocations WHERE asset_id=? AND released_at IS NULL LIMIT 1',args:[assetId]});if(open)return res.status(409).json({error:'Rental asset cannot be disposed while allocated to an unresolved rental'});const asset=await getAsset(assetId);if(!asset)return res.status(404).json({error:'Rental asset not found'});if(asset.status==='disposed')return res.status(409).json({error:'Rental asset is already disposed'});await db.execute({sql:`UPDATE rental_assets SET status='disposed',disposal_date=?,disposal_value=?,disposal_reason=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`,args:[date,value,`${reason} | evidence:${evidence}`,assetId]});res.json(await getAsset(assetId));}catch(e){res.status(409).json({error:e.message});}
});

async function economics(asset,costs,rentalFields){
  costs=costs||(await costReader.readAssetCosts(db,asset)).get(Number(asset.id));
  const rent=await rentalRevenue.read(db,asset.id,rentalFields||await rentalRevenue.schema(db));
  const {rows:[maint]}=await db.execute({sql:`SELECT COUNT(*) maintenance_events,ROUND(COALESCE(SUM(direct_cost),0),2) maintenance_cost,
    ROUND(COALESCE(SUM((julianday(COALESCE(ended_at,CURRENT_TIMESTAMP))-julianday(started_at))*24),0),2) downtime_hours
    FROM rental_asset_maintenance WHERE asset_id=?`,args:[asset.id]});
  const {rows:events}=await db.execute({sql:`SELECT event_type,ROUND(SUM(amount),2) amount,COUNT(*) events FROM rental_asset_economic_events WHERE asset_id=? GROUP BY event_type`,args:[asset.id]});
  const byType=Object.fromEntries(events.map(x=>[x.event_type,money(x.amount)])),recoveries=money((byType.damage_recovery||0)+(byType.other_recovery||0)),otherCosts=money((byType.unrecovered_damage_loss||0)+(byType.other_direct_cost||0)),acq=money(asset.acquisition_cost),maintenance=money(maint?.maintenance_cost),disposal=['disposed','sold'].includes(String(asset.status))?money(asset.disposal_value):0,revenue=rent.core_rental_revenue==null?null:money(rent.core_rental_revenue),baseContribution=revenue==null?null:money(revenue+recoveries+disposal-acq-maintenance-otherCosts),external=costs.maintenance.non_consumable_cost_cents,net=costs.consumables.net_cost_cents,externalOther=costs.other_costs.non_consumable_direct_cost_cents,contribution=revenue==null||external==null||net==null||externalOther==null?null:money(revenue+recoveries+disposal-acq-external/100-net/100-externalOther/100),roi=acq>0&&contribution!=null?money(100*contribution/acq):null;
  if(contribution!=null&&!Number.isSafeInteger(Math.round(contribution*100)))throw costReader.fail('UNSAFE_CONTRIBUTION','Recorded contribution exceeds safe cents');
  const evidenceGrade=asset.acquisition_evidence_grade==='complete'&&!costs.coverage.partial&&!rent.revenue_review_required&&rent.source!=='legacy_original_fee_only'?'complete':'partial';
  return {asset_id:asset.id,asset_number:asset.asset_number,product_id:asset.product_id,product_name:asset.product_name,sku:asset.sku,serial_number:asset.serial_number||null,branch_id:asset.branch_id,branch_name:asset.branch_name,status:asset.status,evidence_grade:evidenceGrade,acquisition:{cost:acq,date:asset.acquisition_date,evidence_ref:asset.acquisition_evidence_ref,grade:asset.acquisition_evidence_grade},rentals:{...rent,core_rental_revenue:revenue},maintenance:{events:Number(maint?.maintenance_events||0),direct_cost:maintenance,non_consumable_cost:external==null?null:external/100,...costs.maintenance,downtime_hours:money(maint?.downtime_hours)},consumables:costs.consumables,cost_coverage:costs.coverage,other_economics:{recoveries,non_consumable_direct_costs:externalOther==null?null:externalOther/100,unrecovered_or_other_direct_costs:otherCosts,event_breakdown:events,disposal_value:disposal},lifetime:{evidenced_contribution:contribution,contribution_before_consumables_and_review:baseContribution,return_on_acquisition_cost_pct:roi,cost_review_required:costs.coverage.pending_cost_reviews>0,formula:'core rental revenue + evidenced recoveries + sale/disposal value - acquisition cost - external maintenance excluding consumables - net consumables issued - evidenced unrecovered/other direct costs'},limitations:['Rental-line revenue uses settled final fees for fully returned or bought-out assets; unresolved agreement-level overrides withhold contribution. Active rentals show provisional booked fees, not collected cash.','Recorded lifetime contribution is not cash profit; tax, financing, depreciation and overhead remain outside this calculation.','Unresolved maintenance cost overlap with consumables withholds contribution until Finance reviews the external portion.','Rental revenue is allocated equally per issued unit from the authoritative rental-line fee when multiple identical units share one rental line.','Unrecorded maintenance, downtime, insurance, financing, depreciation and overhead are not invented.','Damage/service charges are included only when explicitly linked to this asset through an economic event.']};
}

function reportError(res,e){res.status(e.status||500).json({error:e.status?e.message:'Unable to load rental asset economics',code:e.code||'ASSET_ECONOMICS_FAILED'});}
function fleetCursor(raw){
 if(!raw)return null;
 try{
  if(typeof raw!=='string'||raw.length>256||!/^[A-Za-z0-9_-]+$/.test(raw))throw new Error('bad cursor');
  const decoded=JSON.parse(Buffer.from(raw,'base64url').toString('utf8'));
  if(!Array.isArray(decoded)||decoded.length!==2||typeof decoded[0]!=='string'||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(decoded[0])||!Number.isSafeInteger(decoded[1])||decoded[1]<1)throw new Error('bad cursor');
  if(Buffer.from(JSON.stringify(decoded)).toString('base64url')!==raw)throw new Error('noncanonical cursor');
  return decoded;
 }catch(_){throw costReader.fail('INVALID_CURSOR','Refresh the fleet list; its page position is invalid',400);}
}
router.get('/assets/:id/economics',async(req,res)=>{try{costAccess.authorizeRead(req);const n=Number(req.params.id);if(!Number.isSafeInteger(n)||n<1)throw costReader.fail('INVALID_ID','Select a valid asset',400);const asset=await getAsset(n);if(!asset)return res.status(404).json({error:'Rental asset not found'});costAccess.assertBranch(req,asset);res.json(await economics(asset));}catch(e){reportError(res,e);}});
router.get('/asset-economics',async(req,res)=>{try{
 costAccess.authorizeRead(req);const args=[];let query=`SELECT a.*,p.name product_name,p.sku,b.name branch_name,s.serial_number FROM rental_assets a JOIN products p ON p.id=a.product_id JOIN branches b ON b.id=a.branch_id LEFT JOIN inventory_serials s ON s.id=a.serial_id WHERE 1=1`;
 const cross=can(req.employee.permissions,'branches')||can(req.employee.permissions,'security_manage');
 const branch=req.query.branch_id==null?(cross?null:Number(req.employee.default_branch_id)):Number(req.query.branch_id);
 if(branch!=null){if(!Number.isSafeInteger(branch)||branch<1)throw costReader.fail('INVALID_BRANCH','Select a valid assigned branch',req.query.branch_id==null?403:400);costAccess.assertBranch(req,{branch_id:branch});query+=' AND a.branch_id=?';args.push(branch);}
 if(req.query.product_id){const p=Number(req.query.product_id);if(!Number.isSafeInteger(p)||p<1)throw costReader.fail('INVALID_PRODUCT','Select a valid product',400);query+=' AND a.product_id=?';args.push(p);}
 if(req.query.status){query+=' AND a.status=?';args.push(String(req.query.status));}
 const search=String(req.query.search||'').trim();
 if(search.length>120)throw costReader.fail('INVALID_SEARCH','Fleet search must be 120 characters or fewer',400);
 if(search){
  const match='%'+search.toLowerCase().replace(/[\\%_]/g,'\\$&')+'%';
  query+=" AND (LOWER(a.asset_number) LIKE ? ESCAPE '\\' OR LOWER(p.name) LIKE ? ESCAPE '\\' OR LOWER(p.sku) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(s.serial_number,'')) LIKE ? ESCAPE '\\')";
  args.push(match,match,match,match);
 }
 const size=req.query.limit==null?100:Number(req.query.limit);
 if(!Number.isSafeInteger(size)||size<1||size>500)throw costReader.fail('INVALID_LIMIT','Fleet page size must be from 1 to 500',400);
 const cursor=fleetCursor(req.query.cursor);
 if(cursor){query+=' AND (a.created_at < ? OR (a.created_at = ? AND a.id < ?))';args.push(cursor[0],cursor[0],cursor[1]);}
 query+=' ORDER BY a.created_at DESC,a.id DESC LIMIT ?';args.push(size+1);
 const {rows:page}=await db.execute({sql:query,args});
 const hasMore=page.length>size,rows=page.slice(0,size),last=rows[rows.length-1];
 const nextCursor=hasMore&&last?Buffer.from(JSON.stringify([last.created_at,Number(last.id)])).toString('base64url'):null;
 const costs=await costReader.readAssetCosts(db,rows),rentalFields=await rentalRevenue.schema(db),out=[];for(const x of rows)out.push(await economics(x,costs.get(Number(x.id)),rentalFields));
 out.sort((a,b)=>a.lifetime.evidenced_contribution==null?(b.lifetime.evidenced_contribution==null?0:1):b.lifetime.evidenced_contribution==null?-1:b.lifetime.evidenced_contribution-a.lifetime.evidenced_contribution);
 res.json({assets:out,has_more:hasMore,next_cursor:nextCursor,page_size:size,order:'acquisition_newest_first; contribution_ranked_within_loaded_page',methodology:{evidence_boundary:'Lifetime economics use registered acquisition cost, linked rental-line revenue, reviewed external maintenance, net original-cost consumables, explicit asset-level recovery/loss events and actual sale/disposal value only.',maintenance_overlap:'Contribution is withheld when recorded maintenance may include issued consumables until Finance reviews its external portion.',current_catalog_cost_forbidden:true,automatic_actions:false}});
 }catch(e){reportError(res,e);}});

module.exports={router,ensureSchema};
