'use strict';
const express=require('express');
const multer=require('multer');
const path=require('path');
const fs=require('fs');
const router=express.Router();
const {db}=require('../database');
const {requireAnyPermission}=require('../lib/permissions');
const {cloudUpload}=require('../lib/cloudinary');

const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:12*1024*1024},fileFilter:(req,file,cb)=>cb(null,['image/jpeg','image/png','image/webp'].includes(file.mimetype))});
let readyPromise=null;
async function ensureSchema(){
 if(readyPromise)return readyPromise;
 readyPromise=db.batch([
  {sql:`CREATE TABLE IF NOT EXISTS dispatch_vehicles(
   id INTEGER PRIMARY KEY AUTOINCREMENT,
   vehicle_number TEXT NOT NULL UNIQUE,
   registration_number TEXT,
   description TEXT NOT NULL,
   vehicle_type TEXT,
   capacity_kg REAL,
   capacity_volume_m3 REAL,
   status TEXT NOT NULL DEFAULT 'available',
   current_branch_id INTEGER REFERENCES branches(id),
   notes TEXT,
   active INTEGER NOT NULL DEFAULT 1,
   created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
   updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`},
  {sql:`CREATE TABLE IF NOT EXISTS dispatch_executions(
   id INTEGER PRIMARY KEY AUTOINCREMENT,
   dispatch_job_id INTEGER NOT NULL UNIQUE REFERENCES dispatch_jobs(id),
   driver_employee_id INTEGER REFERENCES employees(id),
   vehicle_id INTEGER REFERENCES dispatch_vehicles(id),
   stage TEXT NOT NULL DEFAULT 'assigned',
   assigned_at DATETIME,
   departed_for_origin_at DATETIME,
   arrived_origin_at DATETIME,
   picked_up_at DATETIME,
   arrived_destination_at DATETIME,
   completed_at DATETIME,
   failed_at DATETIME,
   failure_reason TEXT,
   rescheduled_for DATETIME,
   last_notes TEXT,
   created_by_employee_id INTEGER REFERENCES employees(id),
   updated_by_employee_id INTEGER REFERENCES employees(id),
   created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
   updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`},
  {sql:`CREATE TABLE IF NOT EXISTS dispatch_custody_events(
   id INTEGER PRIMARY KEY AUTOINCREMENT,
   dispatch_job_id INTEGER NOT NULL REFERENCES dispatch_jobs(id),
   execution_id INTEGER REFERENCES dispatch_executions(id),
   event_type TEXT NOT NULL,
   from_party TEXT,
   to_party TEXT,
   recipient_name TEXT,
   evidence_reference TEXT,
   notes TEXT,
   actor_employee_id INTEGER REFERENCES employees(id),
   created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`},
  {sql:`CREATE TABLE IF NOT EXISTS dispatch_proofs(
   id INTEGER PRIMARY KEY AUTOINCREMENT,
   dispatch_job_id INTEGER NOT NULL REFERENCES dispatch_jobs(id),
   execution_id INTEGER REFERENCES dispatch_executions(id),
   proof_type TEXT NOT NULL,
   recipient_name TEXT,
   signature_name TEXT,
   photo_url TEXT,
   evidence_reference TEXT,
   notes TEXT,
   latitude REAL,
   longitude REAL,
   captured_by_employee_id INTEGER REFERENCES employees(id),
   captured_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`},
  {sql:'CREATE INDEX IF NOT EXISTS idx_dispatch_execution_stage ON dispatch_executions(stage,updated_at)'},
  {sql:'CREATE INDEX IF NOT EXISTS idx_dispatch_custody_job ON dispatch_custody_events(dispatch_job_id,created_at)'},
  {sql:'CREATE INDEX IF NOT EXISTS idx_dispatch_proof_job ON dispatch_proofs(dispatch_job_id,captured_at)'}
 ],'write').catch(e=>{readyPromise=null;throw e;});
 return readyPromise;
}
function actor(req){return req.employee?.id||req.user?.employee_id||null;}
async function getJob(id){const {rows:[row]}=await db.execute({sql:'SELECT * FROM dispatch_jobs WHERE id=?',args:[id]});return row||null;}
async function getExecution(id){const {rows:[row]}=await db.execute({sql:`SELECT de.*,e.first_name||' '||e.last_name driver_name,dv.vehicle_number,dv.registration_number,dv.description vehicle_description,dv.status vehicle_status FROM dispatch_executions de LEFT JOIN employees e ON e.id=de.driver_employee_id LEFT JOIN dispatch_vehicles dv ON dv.id=de.vehicle_id WHERE de.dispatch_job_id=?`,args:[id]});return row||null;}
async function event(tx,jobId,type,oldStatus,newStatus,details,employeeId){await tx.execute({sql:`INSERT INTO dispatch_events(dispatch_job_id,event_type,old_status,new_status,details,actor_employee_id) VALUES(?,?,?,?,?,?)`,args:[jobId,type,oldStatus||null,newStatus||null,details||null,employeeId||null]});}
async function syncSourceEvidence(tx,job,stage){
 const text=`Dispatch ${job.job_number} reached logistics stage ${stage}`;
 if(job.source_type==='sales_invoice') await tx.execute({sql:`UPDATE transactions SET fulfillment_status=? WHERE id=?`,args:[stage==='completed'?'delivered':stage,job.source_id]}).catch(()=>{});
 if(job.source_type==='purchase_order') await event(tx,job.id,'purchase_order_logistics_sync',null,null,`${text}; PO receiving remains a separate verification control`,null);
 if(job.source_type==='rental') await event(tx,job.id,'rental_logistics_sync',null,null,`${text}; rental issue/return controls remain authoritative`,null);
}
router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Dispatch field execution schema initialization failed',detail:e.message});}});

router.get('/vehicles',requireAnyPermission('transfers','rentals','purchasing','transactions'),async(req,res)=>{try{const {rows}=await db.execute({sql:`SELECT dv.*,b.name branch_name FROM dispatch_vehicles dv LEFT JOIN branches b ON b.id=dv.current_branch_id WHERE dv.active=1 ORDER BY dv.description,dv.vehicle_number`,args:[]});res.json(rows);}catch(e){res.status(500).json({error:e.message});}});
router.post('/vehicles',requireAnyPermission('transfers'),async(req,res)=>{try{const b=req.body||{};if(!b.vehicle_number||!b.description)return res.status(400).json({error:'vehicle_number and description are required'});if(!['available','assigned','maintenance','out_of_service'].includes(b.status||'available'))return res.status(400).json({error:'Invalid vehicle status'});const r=await db.execute({sql:`INSERT INTO dispatch_vehicles(vehicle_number,registration_number,description,vehicle_type,capacity_kg,capacity_volume_m3,status,current_branch_id,notes) VALUES(?,?,?,?,?,?,?,?,?)`,args:[String(b.vehicle_number).trim(),b.registration_number||null,String(b.description).trim(),b.vehicle_type||null,b.capacity_kg||null,b.capacity_volume_m3||null,b.status||'available',b.current_branch_id||null,b.notes||null]});const {rows:[row]}=await db.execute({sql:'SELECT * FROM dispatch_vehicles WHERE id=?',args:[Number(r.lastInsertRowid)]});res.status(201).json(row);}catch(e){res.status(400).json({error:e.message});}});
router.patch('/vehicles/:id',requireAnyPermission('transfers'),async(req,res)=>{try{const allowed=['registration_number','description','vehicle_type','capacity_kg','capacity_volume_m3','status','current_branch_id','notes','active'];const fields=[],args=[];for(const k of allowed)if(Object.prototype.hasOwnProperty.call(req.body||{},k)){fields.push(`${k}=?`);args.push(req.body[k]);}if(!fields.length)return res.status(400).json({error:'No supported vehicle fields supplied'});fields.push('updated_at=CURRENT_TIMESTAMP');args.push(req.params.id);await db.execute({sql:`UPDATE dispatch_vehicles SET ${fields.join(',')} WHERE id=?`,args});const {rows:[row]}=await db.execute({sql:'SELECT * FROM dispatch_vehicles WHERE id=?',args:[req.params.id]});if(!row)return res.status(404).json({error:'Vehicle not found'});res.json(row);}catch(e){res.status(400).json({error:e.message});}});

router.get('/jobs/:id/execution',requireAnyPermission('transfers','rentals','purchasing','transactions'),async(req,res)=>{try{const job=await getJob(req.params.id);if(!job)return res.status(404).json({error:'Dispatch job not found'});const execution=await getExecution(req.params.id);const {rows:custody}=await db.execute({sql:'SELECT * FROM dispatch_custody_events WHERE dispatch_job_id=? ORDER BY created_at,id',args:[req.params.id]});const {rows:proofs}=await db.execute({sql:'SELECT * FROM dispatch_proofs WHERE dispatch_job_id=? ORDER BY captured_at,id',args:[req.params.id]});res.json({job,execution,custody,proofs});}catch(e){res.status(500).json({error:e.message});}});

router.post('/jobs/:id/assign',requireAnyPermission('transfers'),async(req,res)=>{try{const job=await getJob(req.params.id);if(!job)return res.status(404).json({error:'Dispatch job not found'});if(['completed','cancelled'].includes(job.status))return res.status(409).json({error:'Closed dispatch jobs cannot be assigned'});const driverId=Number(req.body?.driver_employee_id),vehicleId=Number(req.body?.vehicle_id);if(!driverId||!vehicleId)return res.status(400).json({error:'Driver and vehicle are required'});const {rows:[driver]}=await db.execute({sql:'SELECT id,active FROM employees WHERE id=?',args:[driverId]});if(!driver||!driver.active)return res.status(409).json({error:'Selected driver is not an active employee'});const {rows:[vehicle]}=await db.execute({sql:'SELECT * FROM dispatch_vehicles WHERE id=? AND active=1',args:[vehicleId]});if(!vehicle)return res.status(404).json({error:'Vehicle not found'});if(!['available','assigned'].includes(vehicle.status))return res.status(409).json({error:`Vehicle is ${vehicle.status} and cannot be dispatched`});const {rows:[conflict]}=await db.execute({sql:`SELECT de.id,dj.job_number FROM dispatch_executions de JOIN dispatch_jobs dj ON dj.id=de.dispatch_job_id WHERE (de.driver_employee_id=? OR de.vehicle_id=?) AND de.stage NOT IN ('completed','failed','cancelled') AND de.dispatch_job_id!=? LIMIT 1`,args:[driverId,vehicleId,job.id]});if(conflict)return res.status(409).json({error:`Driver or vehicle is already committed to ${conflict.job_number}`});const tx=await db.transaction('write');try{const existing=await getExecution(job.id);if(existing)await tx.execute({sql:`UPDATE dispatch_executions SET driver_employee_id=?,vehicle_id=?,stage='assigned',assigned_at=CURRENT_TIMESTAMP,updated_by_employee_id=?,updated_at=CURRENT_TIMESTAMP WHERE dispatch_job_id=?`,args:[driverId,vehicleId,actor(req),job.id]});else await tx.execute({sql:`INSERT INTO dispatch_executions(dispatch_job_id,driver_employee_id,vehicle_id,stage,assigned_at,created_by_employee_id,updated_by_employee_id) VALUES(?,?,?,'assigned',CURRENT_TIMESTAMP,?,?)`,args:[job.id,driverId,vehicleId,actor(req),actor(req)]});await tx.execute({sql:`UPDATE dispatch_jobs SET assignee_employee_id=?,vehicle_label=?,status='scheduled',updated_at=CURRENT_TIMESTAMP WHERE id=?`,args:[driverId,vehicle.registration_number||vehicle.vehicle_number,job.id]});await tx.execute({sql:`UPDATE dispatch_vehicles SET status='assigned',updated_at=CURRENT_TIMESTAMP WHERE id=?`,args:[vehicleId]});await event(tx,job.id,'field_assignment',job.status,'scheduled',`Driver ${driverId} assigned with vehicle ${vehicle.vehicle_number}`,actor(req));await tx.commit();}catch(e){await tx.rollback();throw e;}res.json(await getExecution(job.id));}catch(e){res.status(400).json({error:e.message});}});

const stages={
 depart_origin:{from:['assigned','rescheduled'],to:'en_route_to_origin',job:'scheduled',stamp:'departed_for_origin_at'},
 arrive_origin:{from:['en_route_to_origin'],to:'at_origin',job:'ready',stamp:'arrived_origin_at'},
 pickup:{from:['at_origin'],to:'in_transit',job:'in_transit',stamp:'picked_up_at'},
 arrive_destination:{from:['in_transit'],to:'at_destination',job:'in_transit',stamp:'arrived_destination_at'}
};
router.post('/jobs/:id/stage/:action',requireAnyPermission('transfers'),async(req,res)=>{try{const job=await getJob(req.params.id);const execution=await getExecution(req.params.id);if(!job||!execution)return res.status(404).json({error:'Assigned dispatch execution not found'});const rule=stages[req.params.action];if(!rule)return res.status(400).json({error:'Unsupported execution action'});if(!rule.from.includes(execution.stage))return res.status(409).json({error:`Cannot ${req.params.action} while execution is ${execution.stage}`});const tx=await db.transaction('write');try{await tx.execute({sql:`UPDATE dispatch_executions SET stage=?,${rule.stamp}=CURRENT_TIMESTAMP,last_notes=?,updated_by_employee_id=?,updated_at=CURRENT_TIMESTAMP WHERE dispatch_job_id=?`,args:[rule.to,req.body?.notes||null,actor(req),job.id]});await tx.execute({sql:`UPDATE dispatch_jobs SET status=?,${rule.to==='in_transit'?'actual_departed_at=COALESCE(actual_departed_at,CURRENT_TIMESTAMP),':''}updated_at=CURRENT_TIMESTAMP WHERE id=?`,args:[rule.job,job.id]});if(req.params.action==='pickup')await tx.execute({sql:`INSERT INTO dispatch_custody_events(dispatch_job_id,execution_id,event_type,from_party,to_party,recipient_name,evidence_reference,notes,actor_employee_id) VALUES(?,?, 'pickup_custody','origin party','company driver',?,?,?,?)`,args:[job.id,execution.id,req.body?.released_by||null,req.body?.evidence_reference||null,req.body?.notes||null,actor(req)]});await event(tx,job.id,`field_${req.params.action}`,job.status,rule.job,req.body?.notes||rule.to,actor(req));await syncSourceEvidence(tx,job,rule.to);await tx.commit();}catch(e){await tx.rollback();throw e;}res.json(await getExecution(job.id));}catch(e){res.status(400).json({error:e.message});}});

router.post('/jobs/:id/proof',requireAnyPermission('transfers'),upload.single('photo'),async(req,res)=>{try{const job=await getJob(req.params.id),execution=await getExecution(req.params.id);if(!job||!execution)return res.status(404).json({error:'Assigned dispatch execution not found'});const proofType=String(req.body?.proof_type||'').trim();if(!['pickup','delivery'].includes(proofType))return res.status(400).json({error:'proof_type must be pickup or delivery'});if(proofType==='delivery'&&execution.stage!=='at_destination')return res.status(409).json({error:'Delivery proof can only be captured after arrival at destination'});if(proofType==='pickup'&&!['at_origin','in_transit','at_destination'].includes(execution.stage))return res.status(409).json({error:'Pickup proof requires arrival at origin first'});if(!req.body?.recipient_name&&!req.body?.signature_name&&!req.body?.evidence_reference&&!req.file)return res.status(400).json({error:'Proof requires recipient, signature, evidence reference or photo'});let photoUrl=null;if(req.file){const cloud=await cloudUpload(req.file.buffer,{folder:'pos-system/dispatch-proofs',public_id:`dispatch-${job.id}-${Date.now()}`,overwrite:true,resource_type:'image'});if(cloud)photoUrl=cloud.secure_url;else{const dir=path.join(__dirname,'../uploads/dispatch-proofs');fs.mkdirSync(dir,{recursive:true});const ext=req.file.mimetype==='image/png'?'png':req.file.mimetype==='image/webp'?'webp':'jpg';const name=`dispatch-${job.id}-${Date.now()}.${ext}`;fs.writeFileSync(path.join(dir,name),req.file.buffer);photoUrl=`/uploads/dispatch-proofs/${name}`;}}
 const lat=req.body?.latitude===''?null:Number(req.body?.latitude),lng=req.body?.longitude===''?null:Number(req.body?.longitude);if((lat!=null&&!Number.isFinite(lat))||(lng!=null&&!Number.isFinite(lng)))return res.status(400).json({error:'Invalid location coordinates'});const r=await db.execute({sql:`INSERT INTO dispatch_proofs(dispatch_job_id,execution_id,proof_type,recipient_name,signature_name,photo_url,evidence_reference,notes,latitude,longitude,captured_by_employee_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,args:[job.id,execution.id,proofType,req.body?.recipient_name||null,req.body?.signature_name||null,photoUrl,req.body?.evidence_reference||null,req.body?.notes||null,lat,lng,actor(req)]});await db.execute({sql:`INSERT INTO dispatch_custody_events(dispatch_job_id,execution_id,event_type,from_party,to_party,recipient_name,evidence_reference,notes,actor_employee_id) VALUES(?,?,?,?,?,?,?,?,?)`,args:[job.id,execution.id,proofType==='delivery'?'delivery_evidence':'pickup_evidence',proofType==='delivery'?'company driver':'origin party',proofType==='delivery'?'destination recipient':'company driver',req.body?.recipient_name||null,req.body?.evidence_reference||photoUrl||null,req.body?.notes||null,actor(req)]});const {rows:[row]}=await db.execute({sql:'SELECT * FROM dispatch_proofs WHERE id=?',args:[Number(r.lastInsertRowid)]});res.status(201).json(row);}catch(e){res.status(400).json({error:e.message});}});

router.post('/jobs/:id/complete',requireAnyPermission('transfers'),async(req,res)=>{try{const job=await getJob(req.params.id),execution=await getExecution(req.params.id);if(!job||!execution)return res.status(404).json({error:'Assigned dispatch execution not found'});if(execution.stage!=='at_destination')return res.status(409).json({error:'Dispatch can only complete after arrival at destination'});const {rows:[proof]}=await db.execute({sql:`SELECT id FROM dispatch_proofs WHERE dispatch_job_id=? AND proof_type='delivery' ORDER BY id DESC LIMIT 1`,args:[job.id]});if(!proof)return res.status(409).json({error:'Delivery/receipt proof is required before dispatch completion'});const tx=await db.transaction('write');try{await tx.execute({sql:`UPDATE dispatch_executions SET stage='completed',completed_at=CURRENT_TIMESTAMP,last_notes=?,updated_by_employee_id=?,updated_at=CURRENT_TIMESTAMP WHERE dispatch_job_id=?`,args:[req.body?.notes||null,actor(req),job.id]});await tx.execute({sql:`UPDATE dispatch_jobs SET status='completed',completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?`,args:[job.id]});await tx.execute({sql:`UPDATE dispatch_vehicles SET status='available',updated_at=CURRENT_TIMESTAMP WHERE id=?`,args:[execution.vehicle_id]});await tx.execute({sql:`INSERT INTO dispatch_custody_events(dispatch_job_id,execution_id,event_type,from_party,to_party,recipient_name,evidence_reference,notes,actor_employee_id) VALUES(?,?,'custody_released','company driver','destination recipient',?,?,?,?)`,args:[job.id,execution.id,req.body?.recipient_name||null,req.body?.evidence_reference||null,req.body?.notes||null,actor(req)]});await event(tx,job.id,'field_completed',job.status,'completed',req.body?.notes||'Dispatch completed with delivery evidence',actor(req));await syncSourceEvidence(tx,job,'completed');await tx.commit();}catch(e){await tx.rollback();throw e;}res.json({job:await getJob(job.id),execution:await getExecution(job.id)});}catch(e){res.status(400).json({error:e.message});}});

router.post('/jobs/:id/fail',requireAnyPermission('transfers'),async(req,res)=>{try{const job=await getJob(req.params.id),execution=await getExecution(req.params.id);if(!job||!execution)return res.status(404).json({error:'Assigned dispatch execution not found'});const reason=String(req.body?.reason||'').trim();if(!reason)return res.status(400).json({error:'Failure reason is required'});const tx=await db.transaction('write');try{await tx.execute({sql:`UPDATE dispatch_executions SET stage='failed',failed_at=CURRENT_TIMESTAMP,failure_reason=?,last_notes=?,updated_by_employee_id=?,updated_at=CURRENT_TIMESTAMP WHERE dispatch_job_id=?`,args:[reason,req.body?.notes||null,actor(req),job.id]});await tx.execute({sql:`UPDATE dispatch_jobs SET status='delayed',updated_at=CURRENT_TIMESTAMP WHERE id=?`,args:[job.id]});await tx.execute({sql:`UPDATE dispatch_vehicles SET status='available',updated_at=CURRENT_TIMESTAMP WHERE id=?`,args:[execution.vehicle_id]});await event(tx,job.id,'field_failed',job.status,'delayed',reason,actor(req));await syncSourceEvidence(tx,job,'failed_attempt');await tx.commit();}catch(e){await tx.rollback();throw e;}res.json(await getExecution(job.id));}catch(e){res.status(400).json({error:e.message});}});

router.post('/jobs/:id/reschedule',requireAnyPermission('transfers'),async(req,res)=>{try{const job=await getJob(req.params.id),execution=await getExecution(req.params.id);if(!job||!execution)return res.status(404).json({error:'Dispatch execution not found'});if(execution.stage!=='failed')return res.status(409).json({error:'Only a failed attempt can be rescheduled'});if(!req.body?.scheduled_for)return res.status(400).json({error:'scheduled_for is required'});const tx=await db.transaction('write');try{await tx.execute({sql:`UPDATE dispatch_executions SET stage='rescheduled',rescheduled_for=?,failure_reason=NULL,updated_by_employee_id=?,updated_at=CURRENT_TIMESTAMP WHERE dispatch_job_id=?`,args:[req.body.scheduled_for,actor(req),job.id]});await tx.execute({sql:`UPDATE dispatch_jobs SET status='scheduled',scheduled_for=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`,args:[req.body.scheduled_for,job.id]});await tx.execute({sql:`UPDATE dispatch_vehicles SET status='assigned',updated_at=CURRENT_TIMESTAMP WHERE id=?`,args:[execution.vehicle_id]});await event(tx,job.id,'field_rescheduled',job.status,'scheduled',`Rescheduled for ${req.body.scheduled_for}`,actor(req));await tx.commit();}catch(e){await tx.rollback();throw e;}res.json(await getExecution(job.id));}catch(e){res.status(400).json({error:e.message});}});

module.exports=router;
module.exports.ensureSchema=ensureSchema;
