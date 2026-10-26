'use strict';
const router=require('express').Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');
// The shared permission boundary maps these read operations to Dispatch View.
router.use(requirePermission('transfers'));
router.get('/board-resources',async(req,res)=>{
 try{
  const {rows:drivers}=await db.execute({sql:`SELECT e.id,e.first_name,e.last_name,
   (SELECT COUNT(*) FROM dispatch_executions x JOIN dispatch_jobs j ON j.id=x.dispatch_job_id WHERE x.driver_employee_id=e.id AND j.status NOT IN ('completed','cancelled') AND x.stage NOT IN ('completed','failed','cancelled')) active_jobs
   FROM employees e WHERE e.active=1 AND e.is_driver=1 ORDER BY e.first_name,e.last_name,e.id`,args:[]});
  res.json({drivers});
 }catch(e){res.status(500).json({error:'Unable to load dispatch drivers'});}
});
router.get('/delivered',async(req,res)=>{
 try{
  const cursor=req.query.before==null?null:Number(req.query.before);
  if(cursor!==null&&(!Number.isSafeInteger(cursor)||cursor<1))return res.status(400).json({error:'Invalid delivery history cursor'});
  // ID-based paging is stable even when two deliveries share a completion timestamp.
  const {rows}=await db.execute({sql:`SELECT j.id,j.job_number,j.origin_label,j.destination_label,j.job_type,j.completed_at,j.source_type,j.source_id,
   e.first_name||' '||e.last_name driver_name,j.vehicle_label,
   (SELECT COUNT(*) FROM dispatch_proofs p WHERE p.dispatch_job_id=j.id AND p.proof_type='delivery') delivery_proof_count
   FROM dispatch_jobs j LEFT JOIN employees e ON e.id=j.assignee_employee_id
   WHERE j.status='completed' ${cursor===null?'':'AND j.id<?'} ORDER BY j.id DESC LIMIT 51`,args:cursor===null?[]:[cursor]});
  const jobs=rows.slice(0,50);res.json({jobs,next_cursor:rows.length>50?jobs[jobs.length-1].id:null});
 }catch(e){res.status(500).json({error:'Unable to load delivered jobs'});}
});
module.exports=router;
