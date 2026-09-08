'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requireAnyPermission}=require('../lib/permissions');
const fieldExecution=require('./logistics-field-execution');

router.use(async(req,res,next)=>{try{await fieldExecution.ensureSchema();next();}catch(e){res.status(500).json({error:'Protected dispatch execution initialization failed',detail:e.message});}});
function actor(req){return req.employee?.id||req.user?.employee_id||null;}
function problem(status,message){const e=new Error(message);e.status=status;throw e;}
async function job(id,executor=db){const {rows:[row]}=await executor.execute({sql:'SELECT * FROM dispatch_jobs WHERE id=?',args:[id]});return row||null;}
async function execution(id,executor=db){const {rows:[row]}=await executor.execute({sql:'SELECT * FROM dispatch_executions WHERE dispatch_job_id=?',args:[id]});return row||null;}
async function event(tx,jobId,type,oldStatus,newStatus,details,employeeId){await tx.execute({sql:'INSERT INTO dispatch_events(dispatch_job_id,event_type,old_status,new_status,details,actor_employee_id) VALUES(?,?,?,?,?,?)',args:[jobId,type,oldStatus||null,newStatus||null,details||null,employeeId||null]});}
async function releaseVehicle(tx,vehicleId,jobId){if(!vehicleId)return;await tx.execute({sql:`UPDATE dispatch_vehicles SET status='available',updated_at=CURRENT_TIMESTAMP WHERE id=? AND NOT EXISTS (SELECT 1 FROM dispatch_executions de WHERE de.vehicle_id=? AND de.dispatch_job_id<>? AND de.stage NOT IN ('completed','failed','cancelled'))`,args:[vehicleId,vehicleId,jobId]});}

async function cancel(req,res){
 const reason=String(req.body?.reason||req.body?.details||'').trim();
 if(!reason)return res.status(400).json({error:'Cancellation reason is required'});
 const tx=await db.transaction('write');
 try{
  const current=await job(req.params.id,tx);if(!current)problem(404,'Dispatch job not found');
  if(['completed','cancelled'].includes(current.status))problem(409,`Dispatch job is already ${current.status}`);
  const x=await execution(current.id,tx);
  const cancellable=['assigned','rescheduled','en_route_to_origin','at_origin','failed'];
  if(x&&!cancellable.includes(x.stage))problem(409,'Dispatch cannot be cancelled after custody pickup. Record a failed attempt or complete the custody handoff instead.');
  if(x){await tx.execute({sql:`UPDATE dispatch_executions SET stage='cancelled',last_notes=?,updated_by_employee_id=?,updated_at=CURRENT_TIMESTAMP WHERE dispatch_job_id=?`,args:[reason,actor(req),current.id]});await releaseVehicle(tx,x.vehicle_id,current.id);}
  await tx.execute({sql:`UPDATE dispatch_jobs SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE id=?`,args:[current.id]});
  await event(tx,current.id,'field_cancelled',current.status,'cancelled',reason,actor(req));
  await tx.commit();
  res.json({job:await job(current.id),execution:await execution(current.id)});
 }catch(e){await tx.rollback().catch(()=>{});res.status(e.status||400).json({error:e.message});}
}

router.post('/jobs/:id/assign',requireAnyPermission('transfers'),async(req,res,next)=>{try{const x=await execution(req.params.id);if(!x)return next();return res.status(409).json({error:'This dispatch already has an execution record. Use the controlled reassignment workflow instead of overwriting the assignment.'});}catch(e){res.status(400).json({error:e.message});}});
router.post('/jobs/:id/cancel',requireAnyPermission('transfers'),cancel);
router.post('/jobs/:id/status',requireAnyPermission('transfers'),async(req,res,next)=>{
 const status=String(req.body?.status||'');
 if(status==='cancelled')return cancel(req,res);
 if(status==='completed')return res.status(409).json({error:'Use the controlled dispatch completion workflow; delivery proof is required before completion'});
 if(status==='in_transit')return res.status(409).json({error:'Use the controlled pickup/custody workflow before marking a dispatch in transit'});
 return next();
});

router.post('/jobs/:id/reassign',requireAnyPermission('transfers'),async(req,res)=>{
 const driverId=Number(req.body?.driver_employee_id),vehicleId=Number(req.body?.vehicle_id);
 if(!driverId||!vehicleId)return res.status(400).json({error:'Driver and vehicle are required'});
 const tx=await db.transaction('write');
 try{
  const current=await job(req.params.id,tx);if(!current)problem(404,'Dispatch job not found');
  if(['completed','cancelled'].includes(current.status))problem(409,'Closed dispatch jobs cannot be reassigned');
  const x=await execution(current.id,tx);if(!x)problem(409,'Assign the dispatch before using reassignment');
  if(!['assigned','rescheduled','failed'].includes(x.stage))problem(409,`Dispatch cannot be reassigned while execution is ${x.stage}`);
  const {rows:[driver]}=await tx.execute({sql:'SELECT id,active,is_driver FROM employees WHERE id=?',args:[driverId]});if(!driver||!driver.active||!driver.is_driver)problem(409,'Selected employee is not an active dispatch driver');
  const {rows:[vehicle]}=await tx.execute({sql:'SELECT * FROM dispatch_vehicles WHERE id=? AND active=1',args:[vehicleId]});if(!vehicle)problem(404,'Vehicle not found');
  if(!['available','assigned'].includes(vehicle.status))problem(409,`Vehicle is ${vehicle.status} and cannot be dispatched`);
  if(x.stage==='failed'&&vehicle.status!=='available')problem(409,'A failed dispatch can only be reassigned to a currently available vehicle before rescheduling');
  const {rows:[conflict]}=await tx.execute({sql:`SELECT dj.job_number FROM dispatch_executions de JOIN dispatch_jobs dj ON dj.id=de.dispatch_job_id WHERE (de.driver_employee_id=? OR de.vehicle_id=?) AND de.stage NOT IN ('completed','failed','cancelled') AND de.dispatch_job_id!=? LIMIT 1`,args:[driverId,vehicleId,current.id]});if(conflict)problem(409,`Driver or vehicle is already committed to ${conflict.job_number}`);
  const failed=x.stage==='failed',nextStatus=failed?'delayed':'scheduled';
  if(x.vehicle_id&&Number(x.vehicle_id)!==vehicleId)await releaseVehicle(tx,x.vehicle_id,current.id);
  await tx.execute({sql:`UPDATE dispatch_executions SET driver_employee_id=?,vehicle_id=?,assigned_at=CURRENT_TIMESTAMP,last_notes=?,updated_by_employee_id=?,updated_at=CURRENT_TIMESTAMP WHERE dispatch_job_id=?`,args:[driverId,vehicleId,req.body?.notes||null,actor(req),current.id]});
  await tx.execute({sql:`UPDATE dispatch_jobs SET assignee_employee_id=?,vehicle_label=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`,args:[driverId,vehicle.registration_number||vehicle.vehicle_number,nextStatus,current.id]});
  if(!failed)await tx.execute({sql:`UPDATE dispatch_vehicles SET status='assigned',updated_at=CURRENT_TIMESTAMP WHERE id=?`,args:[vehicleId]});
  await event(tx,current.id,'field_reassigned',current.status,nextStatus,`Driver ${driverId} / vehicle ${vehicle.vehicle_number} reassigned${failed?' after failed attempt; reschedule still required':''}`,actor(req));
  await tx.commit();
  res.json({job:await job(current.id),execution:await execution(current.id)});
 }catch(e){await tx.rollback().catch(()=>{});res.status(e.status||400).json({error:e.message});}
});

module.exports=router;