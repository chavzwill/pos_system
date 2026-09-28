'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {can}=require('../lib/permissions');

let readyPromise=null;
async function ensureSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=db.batch([
    {sql:`CREATE TABLE IF NOT EXISTS dispatch_security_releases(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dispatch_job_id INTEGER NOT NULL UNIQUE,
      security_employee_id INTEGER NOT NULL,
      branch_id INTEGER,
      status TEXT NOT NULL DEFAULT 'released',
      package_count INTEGER,
      seal_reference TEXT,
      vehicle_registration TEXT,
      driver_employee_id INTEGER,
      notes TEXT,
      released_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_at DATETIME,
      revoked_by_employee_id INTEGER
    )`},
    {sql:'CREATE INDEX IF NOT EXISTS idx_dispatch_security_release_branch ON dispatch_security_releases(branch_id,released_at)'},
    {sql:`CREATE TABLE IF NOT EXISTS commercial_account_applications(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_number TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL DEFAULT 'website',
      application_type TEXT NOT NULL,
      customer_id INTEGER,
      business_name TEXT,
      contact_name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      registration_number TEXT,
      tax_number TEXT,
      requested_credit_limit REAL,
      requested_terms_days INTEGER,
      branch_id INTEGER,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      submitted_payload TEXT,
      submitted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reviewed_by_employee_id INTEGER,
      reviewed_at DATETIME,
      decision_notes TEXT,
      approved_credit_limit REAL,
      approved_terms_days INTEGER
    )`},
    {sql:'CREATE INDEX IF NOT EXISTS idx_commercial_applications_status ON commercial_account_applications(status,submitted_at)'}
  ],'write').catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Role dashboard schema initialization failed',detail:e.message});}});
function actor(req){return Number(req.employee?.id||req.user?.employee_id||0)||null;}
function has(req,key){return can(req.employee?.permissions||{},key);}
async function employeeFlags(id){const {rows:[e]}=await db.execute({sql:'SELECT id,is_driver,is_security,is_operator,active,default_branch_id FROM employees WHERE id=?',args:[id]});return e||null;}
function appNumber(){return `ACC-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2,6).toUpperCase()}`;}
function needsSecurityRelease(job){const type=String(job?.job_type||'').toLowerCase(),source=String(job?.source_type||'').toLowerCase();if(source==='purchase_order'||type.includes('supplier_pickup'))return false;if(type.includes('repair_pickup')||type.includes('rental_pickup')||type.includes('customer_pickup'))return false;return true;}

router.get('/role-dashboards/me',async(req,res)=>{
  if(!req.employee)return res.status(401).json({error:'Employee session required'});
  const flags=await employeeFlags(actor(req));
  res.json({driver:Boolean(flags?.is_driver),security:Boolean(flags?.is_security),dispatch:has(req,'transfers')||has(req,'dispatch')||has(req,'dispatch_view'),accounts:has(req,'accounts'),branch_id:flags?.default_branch_id||req.employee?.default_branch_id||null});
});

router.get('/role-dashboards/dispatch',async(req,res)=>{
  if(!has(req,'transfers')&&!has(req,'dispatch')&&!has(req,'dispatch_view'))return res.status(403).json({error:'Dispatch access required'});
  const {rows:drivers}=await db.execute({sql:`SELECT e.id,e.employee_number,e.first_name||' '||e.last_name name,e.default_branch_id,b.name branch_name,e.active,
    SUM(CASE WHEN de.stage NOT IN ('completed','failed','cancelled') THEN 1 ELSE 0 END) active_tasks,
    SUM(CASE WHEN de.stage='in_transit' THEN 1 ELSE 0 END) in_transit,
    MAX(de.updated_at) last_activity
    FROM employees e LEFT JOIN branches b ON b.id=e.default_branch_id LEFT JOIN dispatch_executions de ON de.driver_employee_id=e.id
    WHERE e.is_driver=1 AND e.active=1 GROUP BY e.id ORDER BY name`,args:[]});
  const {rows:jobs}=await db.execute({sql:`SELECT dj.id,dj.job_number,dj.source_type,dj.job_type,dj.priority,dj.status,dj.origin_label,dj.destination_label,dj.promised_at,dj.scheduled_for,dj.branch_id,b.name branch_name,
    de.stage execution_stage,de.driver_employee_id,e.first_name||' '||e.last_name driver_name,dv.vehicle_number,dv.registration_number,
    CASE WHEN sr.id IS NOT NULL AND sr.revoked_at IS NULL THEN 1 ELSE 0 END security_released,sr.released_at security_released_at
    FROM dispatch_jobs dj LEFT JOIN branches b ON b.id=dj.branch_id LEFT JOIN dispatch_executions de ON de.dispatch_job_id=dj.id
    LEFT JOIN employees e ON e.id=de.driver_employee_id LEFT JOIN dispatch_vehicles dv ON dv.id=de.vehicle_id LEFT JOIN dispatch_security_releases sr ON sr.dispatch_job_id=dj.id
    WHERE dj.status NOT IN ('completed','cancelled') ORDER BY COALESCE(dj.promised_at,dj.scheduled_for,dj.created_at),dj.id DESC LIMIT 300`,args:[]});
  const enriched=jobs.map(j=>({...j,security_required:needsSecurityRelease(j)}));
  res.json({summary:{drivers:drivers.length,active_drivers:drivers.filter(d=>Number(d.active_tasks)>0).length,open_jobs:enriched.length,awaiting_security:enriched.filter(j=>j.security_required&&j.execution_stage==='at_origin'&&!j.security_released).length,in_transit:enriched.filter(j=>j.execution_stage==='in_transit').length},drivers,jobs:enriched});
});

router.get('/role-dashboards/driver',async(req,res)=>{
  if(!req.employee)return res.status(401).json({error:'Employee session required'});
  const flags=await employeeFlags(actor(req));
  if(!flags?.is_driver&&!has(req,'transfers'))return res.status(403).json({error:'Driver access required'});
  const driverId=flags?.is_driver?actor(req):Number(req.query.driver_id||actor(req));
  const {rows:jobs}=await db.execute({sql:`SELECT dj.*,de.stage execution_stage,de.vehicle_id,dv.vehicle_number,dv.registration_number,
    CASE WHEN sr.id IS NOT NULL AND sr.revoked_at IS NULL THEN 1 ELSE 0 END security_released,sr.released_at security_released_at
    FROM dispatch_executions de JOIN dispatch_jobs dj ON dj.id=de.dispatch_job_id LEFT JOIN dispatch_vehicles dv ON dv.id=de.vehicle_id
    LEFT JOIN dispatch_security_releases sr ON sr.dispatch_job_id=dj.id
    WHERE de.driver_employee_id=? AND de.stage NOT IN ('completed','cancelled') ORDER BY COALESCE(dj.scheduled_for,dj.promised_at,dj.created_at),dj.id`,args:[driverId]});
  const enriched=jobs.map(j=>({...j,security_required:needsSecurityRelease(j)}));
  res.json({driver_id:driverId,summary:{tasks:enriched.length,ready_for_pickup:enriched.filter(j=>j.execution_stage==='at_origin'&&(!j.security_required||j.security_released)).length,awaiting_security:enriched.filter(j=>j.security_required&&j.execution_stage==='at_origin'&&!j.security_released).length,in_transit:enriched.filter(j=>j.execution_stage==='in_transit').length},jobs:enriched});
});

router.get('/role-dashboards/security',async(req,res)=>{
  if(!req.employee)return res.status(401).json({error:'Employee session required'});
  const flags=await employeeFlags(actor(req));
  if(!flags?.is_security&&!has(req,'security_manage'))return res.status(403).json({error:'Security personnel access required'});
  const branchId=req.query.branch_id||flags.default_branch_id||null,args=[];
  let where=`WHERE dj.status NOT IN ('completed','cancelled') AND de.stage IN ('assigned','en_route_to_origin','at_origin','in_transit','at_destination')`;
  if(branchId){where+=' AND dj.branch_id=?';args.push(branchId);}
  const {rows:rows}=await db.execute({sql:`SELECT dj.id,dj.job_number,dj.source_type,dj.job_type,dj.origin_label,dj.destination_label,dj.priority,dj.status,dj.branch_id,b.name branch_name,
    de.stage execution_stage,de.driver_employee_id,e.first_name||' '||e.last_name driver_name,dv.vehicle_number,dv.registration_number,
    sr.id release_id,sr.status release_status,sr.package_count,sr.seal_reference,sr.released_at,sr.security_employee_id
    FROM dispatch_jobs dj JOIN dispatch_executions de ON de.dispatch_job_id=dj.id LEFT JOIN branches b ON b.id=dj.branch_id
    LEFT JOIN employees e ON e.id=de.driver_employee_id LEFT JOIN dispatch_vehicles dv ON dv.id=de.vehicle_id
    LEFT JOIN dispatch_security_releases sr ON sr.dispatch_job_id=dj.id AND sr.revoked_at IS NULL ${where}
    ORDER BY CASE WHEN de.stage='at_origin' AND sr.id IS NULL THEN 0 ELSE 1 END,COALESCE(dj.promised_at,dj.scheduled_for,dj.created_at)`,args});
  const jobs=rows.filter(needsSecurityRelease);
  res.json({branch_id:branchId,summary:{shipments:jobs.length,awaiting_release:jobs.filter(j=>j.execution_stage==='at_origin'&&!j.release_id).length,released:jobs.filter(j=>j.release_id).length,in_transit:jobs.filter(j=>j.execution_stage==='in_transit').length},jobs});
});

router.post('/role-dashboards/security/:jobId/release',async(req,res)=>{
  if(!req.employee)return res.status(401).json({error:'Employee session required'});
  const flags=await employeeFlags(actor(req));
  if(!flags?.is_security&&!has(req,'security_manage'))return res.status(403).json({error:'Security personnel access required'});
  const {rows:[job]}=await db.execute({sql:`SELECT dj.*,de.stage,de.driver_employee_id,dv.registration_number FROM dispatch_jobs dj JOIN dispatch_executions de ON de.dispatch_job_id=dj.id LEFT JOIN dispatch_vehicles dv ON dv.id=de.vehicle_id WHERE dj.id=?`,args:[req.params.jobId]});
  if(!job)return res.status(404).json({error:'Dispatch shipment not found'});
  if(!needsSecurityRelease(job))return res.status(409).json({error:'This is an external-origin collection and does not require Total Tools security release'});
  if(job.stage!=='at_origin')return res.status(409).json({error:`Shipment can only be released after driver arrival at origin. Current stage: ${job.stage}`});
  if(!job.driver_employee_id)return res.status(409).json({error:'Shipment must have an assigned driver before security release'});
  const body=req.body||{},count=body.package_count==null?null:Number(body.package_count);
  if(count!=null&&(!Number.isInteger(count)||count<1))return res.status(400).json({error:'package_count must be a positive whole number'});
  const tx=await db.transaction('write');
  try{
    await tx.execute({sql:`INSERT INTO dispatch_security_releases(dispatch_job_id,security_employee_id,branch_id,status,package_count,seal_reference,vehicle_registration,driver_employee_id,notes,released_at,revoked_at,revoked_by_employee_id)
      VALUES(?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,NULL,NULL)
      ON CONFLICT(dispatch_job_id) DO UPDATE SET security_employee_id=excluded.security_employee_id,branch_id=excluded.branch_id,status='released',package_count=excluded.package_count,seal_reference=excluded.seal_reference,vehicle_registration=excluded.vehicle_registration,driver_employee_id=excluded.driver_employee_id,notes=excluded.notes,released_at=CURRENT_TIMESTAMP,revoked_at=NULL,revoked_by_employee_id=NULL`,args:[job.id,actor(req),job.branch_id,'released',count,body.seal_reference||null,job.registration_number||null,job.driver_employee_id,body.notes||null]});
    await tx.execute({sql:`INSERT INTO dispatch_events(dispatch_job_id,event_type,old_status,new_status,details,actor_employee_id) VALUES(?,?,?,?,?,?)`,args:[job.id,'security_release',job.status,job.status,`Security released shipment${count?` · ${count} package(s)`:''}${body.seal_reference?` · seal ${body.seal_reference}`:''}`,actor(req)]});
    await tx.commit();
  }catch(e){await tx.rollback().catch(()=>{});throw e;}
  const {rows:[release]}=await db.execute({sql:'SELECT * FROM dispatch_security_releases WHERE dispatch_job_id=?',args:[job.id]});
  res.json(release);
});

router.post('/role-dashboards/account-applications/intake',async(req,res)=>{
  if(!req.apiKey&&!req.employee)return res.status(401).json({error:'Authenticated website integration or employee session required'});
  if(req.employee&&!has(req,'accounts'))return res.status(403).json({error:'Accounts access required'});
  const b=req.body||{},type=String(b.application_type||'').toLowerCase();
  if(!['credit','commercial'].includes(type))return res.status(400).json({error:'application_type must be credit or commercial'});
  if(!String(b.contact_name||'').trim())return res.status(400).json({error:'contact_name is required'});
  if(!b.email&&!b.phone)return res.status(400).json({error:'email or phone is required'});
  const number=appNumber();
  const r=await db.execute({sql:`INSERT INTO commercial_account_applications(application_number,source,application_type,customer_id,business_name,contact_name,email,phone,registration_number,tax_number,requested_credit_limit,requested_terms_days,branch_id,notes,status,submitted_payload) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending',?)`,args:[number,b.source||'website',type,b.customer_id||null,b.business_name||null,String(b.contact_name).trim(),b.email||null,b.phone||null,b.registration_number||null,b.tax_number||null,b.requested_credit_limit==null?null:Number(b.requested_credit_limit),b.requested_terms_days==null?null:Number(b.requested_terms_days),b.branch_id||null,b.notes||null,JSON.stringify(b)]});
  const {rows:[row]}=await db.execute({sql:'SELECT * FROM commercial_account_applications WHERE id=?',args:[Number(r.lastInsertRowid)]});
  res.status(201).json(row);
});

router.get('/role-dashboards/accounts',async(req,res)=>{
  if(!has(req,'accounts'))return res.status(403).json({error:'Accounts access required'});
  const {rows:applications}=await db.execute({sql:`SELECT a.*,e.first_name||' '||e.last_name reviewer_name,b.name branch_name FROM commercial_account_applications a LEFT JOIN employees e ON e.id=a.reviewed_by_employee_id LEFT JOIN branches b ON b.id=a.branch_id ORDER BY CASE a.status WHEN 'pending' THEN 0 WHEN 'under_review' THEN 1 ELSE 2 END,a.submitted_at DESC LIMIT 300`,args:[]});
  res.json({summary:{pending:applications.filter(a=>a.status==='pending').length,under_review:applications.filter(a=>a.status==='under_review').length,approved:applications.filter(a=>a.status==='approved').length,rejected:applications.filter(a=>a.status==='rejected').length},applications});
});

router.post('/role-dashboards/accounts/:id/decision',async(req,res)=>{
  if(!req.employee||!has(req,'accounts'))return res.status(403).json({error:'Accounts employee access required'});
  const b=req.body||{},decision=String(b.decision||'').toLowerCase();
  if(!['under_review','approved','rejected'].includes(decision))return res.status(400).json({error:'decision must be under_review, approved, or rejected'});
  const {rows:[app]}=await db.execute({sql:'SELECT * FROM commercial_account_applications WHERE id=?',args:[req.params.id]});
  if(!app)return res.status(404).json({error:'Application not found'});
  if(['approved','rejected'].includes(app.status))return res.status(409).json({error:`Application is already ${app.status}`});
  const limit=b.approved_credit_limit==null?app.requested_credit_limit:Number(b.approved_credit_limit),terms=b.approved_terms_days==null?app.requested_terms_days:Number(b.approved_terms_days);
  if(decision==='approved'&&(!Number.isFinite(limit)||limit<0))return res.status(400).json({error:'Approved credit limit must be zero or greater'});
  if(decision==='approved'&&terms!=null&&(!Number.isFinite(terms)||terms<0))return res.status(400).json({error:'Approved terms must be zero or greater'});
  const tx=await db.transaction('write');
  try{
    await tx.execute({sql:`UPDATE commercial_account_applications SET status=?,reviewed_by_employee_id=?,reviewed_at=CURRENT_TIMESTAMP,decision_notes=?,approved_credit_limit=?,approved_terms_days=? WHERE id=?`,args:[decision,actor(req),b.decision_notes||null,decision==='approved'?limit:null,decision==='approved'?terms:null,app.id]});
    if(decision==='approved'&&app.customer_id){await tx.execute({sql:'UPDATE customers SET credit_enabled=1,credit_limit=? WHERE id=?',args:[Number(limit||0),app.customer_id]});}
    await tx.commit();
  }catch(e){await tx.rollback().catch(()=>{});throw e;}
  const {rows:[row]}=await db.execute({sql:'SELECT * FROM commercial_account_applications WHERE id=?',args:[app.id]});
  res.json(row);
});

module.exports=router;
