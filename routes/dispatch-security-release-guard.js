'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');

let ready=null;
function ensure(){
  if(ready)return ready;
  ready=db.execute({sql:`CREATE TABLE IF NOT EXISTS dispatch_security_releases(
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
  )`,args:[]}).catch(e=>{ready=null;throw e;});
  return ready;
}
router.use(async(req,res,next)=>{try{await ensure();next();}catch(e){res.status(500).json({error:'Dispatch security release control unavailable',detail:e.message});}});

// Security release is a custody invariant, not a UI hint. The driver cannot take
// custody until security at the origin has independently checked and released
// the shipment. This applies regardless of which client invokes the field API.
router.post('/jobs/:id/stage/pickup',async(req,res,next)=>{
  try{
    const {rows:[release]}=await db.execute({sql:`SELECT id,security_employee_id,driver_employee_id,vehicle_registration,released_at,revoked_at FROM dispatch_security_releases WHERE dispatch_job_id=?`,args:[req.params.id]});
    if(!release||release.revoked_at){
      return res.status(409).json({
        error:'Security release required before driver pickup',
        code:'DISPATCH_SECURITY_RELEASE_REQUIRED',
        action:'Security personnel must inspect and sign off this shipment before custody can pass to the driver.'
      });
    }
    const {rows:[execution]}=await db.execute({sql:`SELECT driver_employee_id,dv.registration_number FROM dispatch_executions de LEFT JOIN dispatch_vehicles dv ON dv.id=de.vehicle_id WHERE de.dispatch_job_id=?`,args:[req.params.id]});
    if(!execution)return res.status(404).json({error:'Dispatch execution not found'});
    if(Number(release.driver_employee_id)!==Number(execution.driver_employee_id))return res.status(409).json({error:'Security release is stale because the assigned driver changed. Security must release the shipment again.',code:'DISPATCH_SECURITY_RELEASE_STALE'});
    if(release.vehicle_registration&&execution.registration_number&&String(release.vehicle_registration)!==String(execution.registration_number))return res.status(409).json({error:'Security release is stale because the assigned vehicle changed. Security must release the shipment again.',code:'DISPATCH_SECURITY_RELEASE_STALE'});
    req.dispatchSecurityRelease=release;
    next();
  }catch(e){res.status(500).json({error:'Unable to verify security release',detail:e.message});}
});

module.exports=router;
