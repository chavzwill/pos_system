'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requireAnyPermission,requirePermission}=require('../lib/permissions');
const {ensureCostAllocationSchema}=require('../lib/cost-allocations');

let readyPromise=null;
async function ensureSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await ensureCostAllocationSchema();
    return db.batch([
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
    {sql:'CREATE INDEX IF NOT EXISTS idx_rental_asset_economic_events_asset ON rental_asset_economic_events(asset_id,event_date)'},
    {sql:`CREATE TABLE IF NOT EXISTS rental_asset_replacement_assessments(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id INTEGER NOT NULL REFERENCES rental_assets(id),
      repair_estimate REAL NOT NULL,
      replacement_cost REAL NOT NULL,
      replacement_expected_annual_revenue REAL NOT NULL,
      replacement_expected_annual_maintenance REAL NOT NULL,
      trade_in_or_residual_value REAL NOT NULL DEFAULT 0,
      evidence_ref TEXT NOT NULL,
      notes TEXT,
      created_by_employee_id INTEGER REFERENCES employees(id),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`}
    ],'write');
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
const money=v=>Number(Number(v||0).toFixed(2));
const positiveMoney=v=>{const n=Number(v);return Number.isFinite(n)&&n>=0?n:null;};
function economicHealth({revenue,maintenance,allocatedCost,contribution,utilizationPct,downtimeHours,ageDays}){
  const operatingCost=maintenance+allocatedCost;
  const costToRevenue=revenue>0?100*operatingCost/revenue:null;
  const reasons=[];let state='healthy';
  if(contribution<0){state='economically_stressed';reasons.push('lifetime contribution is negative');}
  if(costToRevenue!=null&&costToRevenue>=65){state='economically_stressed';reasons.push('maintenance and allocated operating cost consume at least 65% of rental revenue');}
  else if(state==='healthy'&&costToRevenue!=null&&costToRevenue>=35){state='watch';reasons.push('maintenance and allocated operating cost exceed 35% of rental revenue');}
  if(ageDays>=180&&utilizationPct<10){if(state==='healthy')state='underutilized';reasons.push('observed utilization is below 10% after at least 180 days in service');}
  if(downtimeHours>=720){if(state==='healthy')state='watch';reasons.push('recorded maintenance downtime exceeds 720 hours');}
  if(!reasons.length)reasons.push('no current economic threshold is breached');
  return {state,cost_to_revenue_pct:costToRevenue==null?null:money(costToRevenue),reasons,thresholds:{watch_cost_to_revenue_pct:35,stressed_cost_to_revenue_pct:65,underutilized_pct:10,underutilized_min_age_days:180,downtime_watch_hours:720}};
}
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

async function replacementComparison(assetId,input){
  const repairEstimate=positiveMoney(input.repair_estimate),replacementCost=positiveMoney(input.replacement_cost),
    expectedRevenue=positiveMoney(input.replacement_expected_annual_revenue),
    expectedMaintenance=positiveMoney(input.replacement_expected_annual_maintenance),
    residual=positiveMoney(input.trade_in_or_residual_value??0);
  if([repairEstimate,replacementCost,expectedRevenue,expectedMaintenance,residual].some(v=>v==null))throw new Error('Replacement comparison values must be non-negative');
  const {rows:[trailingRent]}=await db.execute({sql:`SELECT ROUND(COALESCE(SUM(CASE WHEN COALESCE(rai.quantity,0)>0 THEN COALESCE(rai.rental_fee,0)*(aa.quantity/rai.quantity) ELSE 0 END),0),2) revenue
    FROM rental_asset_allocations aa JOIN rental_agreement_items rai ON rai.id=aa.agreement_item_id
    WHERE aa.asset_id=? AND datetime(aa.allocated_at)>=datetime('now','-365 days')`,args:[assetId]});
  const {rows:[trailingMaint]}=await db.execute({sql:`SELECT ROUND(COALESCE(SUM(direct_cost),0),2) maintenance
    FROM rental_asset_maintenance WHERE asset_id=? AND datetime(started_at)>=datetime('now','-365 days')`,args:[assetId]});
  const {rows:[trailingAllocated]}=await db.execute({sql:`SELECT ROUND(COALESCE(SUM(allocation_amount),0),2) allocated
    FROM cost_allocations WHERE target_type='rental_asset' AND target_id=?
      AND source_type IN ('internal_consumption','purchase_receipt')
      AND datetime(created_at)>=datetime('now','-365 days')`,args:[String(assetId)]});
  const currentRevenue=money(trailingRent?.revenue),currentMaint=money(trailingMaint?.maintenance),currentAllocated=money(trailingAllocated?.allocated);
  const repairCase=money(currentRevenue-currentMaint-currentAllocated-repairEstimate);
  const replacementCase=money(expectedRevenue-expectedMaintenance-replacementCost+residual);
  const delta=money(replacementCase-repairCase);
  const threshold=Math.max(1000,Math.abs(repairCase)*0.05);
  const signal=Math.abs(delta)<=threshold?'close_call':delta>0?'replacement_case_stronger':'repair_case_stronger';
  return {signal,advisory:true,comparison_horizon_months:12,
    current_trailing_evidence:{rental_revenue:currentRevenue,maintenance_cost:currentMaint,allocated_operating_cost:currentAllocated},
    repair_case:{repair_estimate:repairEstimate,projected_12m_contribution:repairCase},
    replacement_case:{replacement_cost:replacementCost,expected_annual_revenue:expectedRevenue,expected_annual_maintenance:expectedMaintenance,trade_in_or_residual_value:residual,projected_12m_contribution:replacementCase},
    contribution_delta:delta,close_call_threshold:money(threshold),
    limitations:['Current-case economics use trailing 365-day recorded evidence.','Replacement revenue and maintenance are management estimates tied to supplied evidence, not AI forecasts.','No repair, sale, disposal or purchase action is automatic.']};
}

router.post('/assets/:id/replacement-assessments',requireAnyPermission('reports_financial','rentals'),async(req,res)=>{
  try{
    const assetId=Number(req.params.id),asset=await getAsset(assetId);if(!asset)return res.status(404).json({error:'Rental asset not found'});
    const evidence=String(req.body?.evidence_ref||'').trim();if(!evidence)return res.status(400).json({error:'Evidence reference is required for repair/replacement comparison'});
    const comparison=await replacementComparison(assetId,req.body||{});
    const r=await db.execute({sql:`INSERT INTO rental_asset_replacement_assessments(
      asset_id,repair_estimate,replacement_cost,replacement_expected_annual_revenue,
      replacement_expected_annual_maintenance,trade_in_or_residual_value,evidence_ref,notes,created_by_employee_id
    ) VALUES(?,?,?,?,?,?,?,?,?)`,args:[assetId,Number(req.body.repair_estimate),Number(req.body.replacement_cost),
      Number(req.body.replacement_expected_annual_revenue),Number(req.body.replacement_expected_annual_maintenance),
      Number(req.body.trade_in_or_residual_value||0),evidence,String(req.body.notes||'')||null,req.employee?.id||null]});
    res.status(201).json({id:Number(r.lastInsertRowid),asset_id:assetId,evidence_ref:evidence,...comparison});
  }catch(e){res.status(400).json({error:e.message});}
});

router.get('/assets/:id/replacement-assessments/latest',requireAnyPermission('reports','rentals'),async(req,res)=>{
  try{
    const assetId=Number(req.params.id);
    const {rows:[row]}=await db.execute({sql:'SELECT * FROM rental_asset_replacement_assessments WHERE asset_id=? ORDER BY id DESC LIMIT 1',args:[assetId]});
    if(!row)return res.status(404).json({error:'No replacement assessment found'});
    const comparison=await replacementComparison(assetId,row);
    res.json({...row,...comparison});
  }catch(e){res.status(400).json({error:e.message});}
});

function attentionBand(econ,replacementSignal){
  const reasons=[...(econ.economic_health?.reasons||[])];
  let band='routine';
  if(econ.economic_health?.state==='economically_stressed'||Number(econ.lifetime?.evidenced_contribution||0)<0)band='urgent_review';
  else if(replacementSignal==='replacement_case_stronger'||econ.economic_health?.state==='watch')band='review';
  else if(econ.economic_health?.state==='underutilized')band='optimize';
  if(replacementSignal)reasons.push('latest replacement assessment: '+replacementSignal.replace(/_/g,' '));
  return {band,reasons};
}

async function latestReplacementSignal(assetId){
  const {rows:[row]}=await db.execute({sql:'SELECT * FROM rental_asset_replacement_assessments WHERE asset_id=? ORDER BY id DESC LIMIT 1',args:[assetId]});
  if(!row)return null;
  const comparison=await replacementComparison(assetId,row);
  return {id:row.id,created_at:row.created_at,evidence_ref:row.evidence_ref,signal:comparison.signal,contribution_delta:comparison.contribution_delta};
}

router.get('/portfolio',requireAnyPermission('reports','rentals'),async(req,res)=>{
  try{
    const args=[];let sql=`SELECT a.*,p.name product_name,p.sku,b.name branch_name,s.serial_number FROM rental_assets a JOIN products p ON p.id=a.product_id JOIN branches b ON b.id=a.branch_id LEFT JOIN inventory_serials s ON s.id=a.serial_id WHERE a.status NOT IN ('sold','disposed','lost')`;
    if(req.query.branch_id){sql+=' AND a.branch_id=?';args.push(req.query.branch_id);}
    sql+=' ORDER BY a.created_at DESC LIMIT 500';
    const {rows}=await db.execute({sql,args});
    const assets=[];
    for(const asset of rows){
      const econ=await economics(asset);
      const latest=await latestReplacementSignal(asset.id);
      const attention=attentionBand(econ,latest?.signal||null);
      assets.push({...econ,attention,latest_replacement_assessment:latest});
    }
    const order={urgent_review:0,review:1,optimize:2,routine:3};
    assets.sort((a,b)=>(order[a.attention.band]-order[b.attention.band])||Number(a.lifetime.evidenced_contribution)-Number(b.lifetime.evidenced_contribution));
    const summary={
      total:assets.length,
      urgent_review:assets.filter(x=>x.attention.band==='urgent_review').length,
      review:assets.filter(x=>x.attention.band==='review').length,
      optimize:assets.filter(x=>x.attention.band==='optimize').length,
      routine:assets.filter(x=>x.attention.band==='routine').length,
      total_lifetime_contribution:money(assets.reduce((s,x)=>s+Number(x.lifetime.evidenced_contribution||0),0)),
      total_rental_revenue:money(assets.reduce((s,x)=>s+Number(x.rentals.core_rental_revenue||0),0)),
      total_operating_cost:money(assets.reduce((s,x)=>s+Number(x.maintenance.direct_cost||0)+Number(x.allocated_costs.actual_operating_cost||0),0))
    };
    res.json({summary,assets,methodology:{ranking:'Deterministic attention bands from economic health, contribution and latest evidence-backed replacement signal.',automatic_actions:false}});
  }catch(e){res.status(500).json({error:e.message});}
});

async function economics(asset){
  const {rows:[rent]}=await db.execute({sql:`SELECT COUNT(DISTINCT aa.agreement_id) rental_count,MIN(aa.allocated_at) first_rental_at,MAX(aa.allocated_at) last_rental_at,
    ROUND(COALESCE(SUM(CASE WHEN COALESCE(rai.quantity,0)>0 THEN COALESCE(rai.rental_fee,0)*(aa.quantity/rai.quantity) ELSE 0 END),0),2) core_rental_revenue,
    ROUND(COALESCE(SUM((julianday(COALESCE(aa.released_at,CURRENT_TIMESTAMP))-julianday(aa.allocated_at))*24),0),2) rented_hours
    FROM rental_asset_allocations aa JOIN rental_agreement_items rai ON rai.id=aa.agreement_item_id WHERE aa.asset_id=?`,args:[asset.id]});
  const {rows:[maint]}=await db.execute({sql:`SELECT COUNT(*) maintenance_events,ROUND(COALESCE(SUM(direct_cost),0),2) maintenance_cost,
    ROUND(COALESCE(SUM((julianday(COALESCE(ended_at,CURRENT_TIMESTAMP))-julianday(started_at))*24),0),2) downtime_hours
    FROM rental_asset_maintenance WHERE asset_id=?`,args:[asset.id]});
  const {rows:events}=await db.execute({sql:`SELECT event_type,ROUND(SUM(amount),2) amount,COUNT(*) events FROM rental_asset_economic_events WHERE asset_id=? GROUP BY event_type`,args:[asset.id]});
  const {rows:[allocated]}=await db.execute({sql:`SELECT
    ROUND(COALESCE(SUM(CASE WHEN source_type IN ('internal_consumption','purchase_receipt') THEN allocation_amount ELSE 0 END),0),2) actual_operating_cost,
    ROUND(COALESCE(SUM(CASE WHEN source_type='internal_consumption' THEN allocation_amount ELSE 0 END),0),2) internal_consumed_cost,
    ROUND(COALESCE(SUM(CASE WHEN source_type='purchase_receipt' THEN allocation_amount ELSE 0 END),0),2) direct_received_cost,
    ROUND(COALESCE(SUM(CASE WHEN source_type='purchase_request' THEN allocation_amount ELSE 0 END),0),2) requested_allocated_cost,
    COUNT(CASE WHEN source_type IN ('internal_consumption','purchase_receipt') THEN 1 END) actual_allocation_lines,
    COUNT(CASE WHEN source_type='purchase_request' THEN 1 END) requested_allocation_lines,
    COUNT(CASE WHEN source_type IN ('internal_consumption','purchase_receipt') AND valuation_status NOT IN ('fully_valued','actual') THEN 1 END) incomplete_valuation_lines
    FROM cost_allocations WHERE target_type='rental_asset' AND target_id=?`,args:[String(asset.id)]});
  const byType=Object.fromEntries(events.map(x=>[x.event_type,money(x.amount)])),recoveries=money((byType.damage_recovery||0)+(byType.other_recovery||0)),otherCosts=money((byType.unrecovered_damage_loss||0)+(byType.other_direct_cost||0)),acq=money(asset.acquisition_cost),maintenance=money(maint?.maintenance_cost),allocatedConsumption=money(allocated?.actual_operating_cost),internalConsumed=money(allocated?.internal_consumed_cost),directReceived=money(allocated?.direct_received_cost),requestedAllocated=money(allocated?.requested_allocated_cost),disposal=['disposed','sold'].includes(String(asset.status))?money(asset.disposal_value):0,revenue=money(rent?.core_rental_revenue),contribution=money(revenue+recoveries+disposal-acq-maintenance-allocatedConsumption-otherCosts),roi=acq>0?money(100*contribution/acq):null;
  const ageDays=Math.max(1,Math.floor((Date.now()-new Date(asset.acquisition_date+'T00:00:00Z').getTime())/86400000));
  const rentedHours=Math.max(0,Number(rent?.rented_hours||0));
  const utilizationPct=money(Math.min(100,100*rentedHours/(ageDays*24)));
  const health=economicHealth({revenue,maintenance,allocatedCost:allocatedConsumption,contribution,utilizationPct,downtimeHours:Number(maint?.downtime_hours||0),ageDays});
  const evidenceGrade=asset.acquisition_evidence_grade==='complete'?'complete':'partial';
  return {asset_id:asset.id,asset_number:asset.asset_number,product_id:asset.product_id,product_name:asset.product_name,sku:asset.sku,serial_number:asset.serial_number||null,branch_id:asset.branch_id,branch_name:asset.branch_name,status:asset.status,evidence_grade:evidenceGrade,acquisition:{cost:acq,date:asset.acquisition_date,evidence_ref:asset.acquisition_evidence_ref,grade:asset.acquisition_evidence_grade},rentals:{rental_count:Number(rent?.rental_count||0),core_rental_revenue:revenue,first_rental_at:rent?.first_rental_at||null,last_rental_at:rent?.last_rental_at||null,rented_hours:money(rentedHours),observed_utilization_pct:utilizationPct,observed_age_days:ageDays},maintenance:{events:Number(maint?.maintenance_events||0),direct_cost:maintenance,downtime_hours:money(maint?.downtime_hours)},allocated_costs:{actual_operating_cost:allocatedConsumption,internal_consumed_cost:internalConsumed,direct_received_cost:directReceived,requested_allocated_cost:requestedAllocated,actual_allocation_lines:Number(allocated?.actual_allocation_lines||0),requested_allocation_lines:Number(allocated?.requested_allocation_lines||0),incomplete_valuation_lines:Number(allocated?.incomplete_valuation_lines||0)},economic_health:health,other_economics:{recoveries,unrecovered_or_other_direct_costs:otherCosts,event_breakdown:events,disposal_value:disposal},lifetime:{evidenced_contribution:contribution,return_on_acquisition_cost_pct:roi,formula:'core rental revenue + evidenced recoveries + sale/disposal value - acquisition cost - evidenced maintenance - actual allocated consumables/parts - evidenced unrecovered/other direct costs'},limitations:['Rental revenue is allocated equally per issued unit from the authoritative rental-line fee when multiple identical units share one rental line.','Unrecorded maintenance, downtime, insurance, financing, depreciation and overhead are not invented.','Damage/service charges are included only when explicitly linked to this asset through an economic event.','Allocated direct-use receipts and issued internal consumables/parts reduce lifetime contribution only when evidenced; purchase requests remain requested spend until actual receipt/consumption evidence exists.']};
}

router.get('/assets/:id/economics',requireAnyPermission('reports','rentals'),async(req,res)=>{try{const asset=await getAsset(Number(req.params.id));if(!asset)return res.status(404).json({error:'Rental asset not found'});res.json(await economics(asset));}catch(e){res.status(500).json({error:e.message});}});
router.get('/asset-economics',requireAnyPermission('reports','rentals'),async(req,res)=>{try{const args=[];let sql=`SELECT a.*,p.name product_name,p.sku,b.name branch_name,s.serial_number FROM rental_assets a JOIN products p ON p.id=a.product_id JOIN branches b ON b.id=a.branch_id LEFT JOIN inventory_serials s ON s.id=a.serial_id WHERE 1=1`;if(req.query.branch_id){sql+=' AND a.branch_id=?';args.push(req.query.branch_id);}if(req.query.product_id){sql+=' AND a.product_id=?';args.push(req.query.product_id);}if(req.query.status){sql+=' AND a.status=?';args.push(req.query.status);}sql+=' ORDER BY a.created_at DESC LIMIT 500';const {rows}=await db.execute({sql,args});const out=[];for(const x of rows)out.push(await economics(x));out.sort((a,b)=>Number(b.lifetime.evidenced_contribution)-Number(a.lifetime.evidenced_contribution));res.json({assets:out,methodology:{evidence_boundary:'Lifetime economics use registered acquisition cost, linked rental-line revenue, explicit maintenance costs, explicit asset-level recovery/loss events and actual sale/disposal value only.',current_catalog_cost_forbidden:true,automatic_actions:false}});}catch(e){res.status(500).json({error:e.message});}});

module.exports={router,ensureSchema};