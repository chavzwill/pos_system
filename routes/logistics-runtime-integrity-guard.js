'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');

// Runtime compatibility guard for the legacy Logistics endpoints. The modern
// field-execution lifecycle owns physical movement. The generic status route
// remains useful for administrative states, but it may not impersonate
// departure/arrival/completion and thereby bypass custody/proof controls.
router.post('/jobs/:id/status',async(req,res,next)=>{
  try{
    const requested=String(req.body?.status||'').trim();
    if(['ready','in_transit','completed'].includes(requested)){
      return res.status(409).json({
        error:'Physical dispatch movement must use the controlled field/route execution workflow.',
        control:'dispatch_field_execution_required',
        requested_status:requested
      });
    }
    next();
  }catch(e){res.status(500).json({error:'Unable to enforce dispatch execution boundary',detail:e.message});}
});

// Standalone assignment must use the same driver eligibility rule already
// enforced by route planning: an active employee explicitly flagged is_driver.
router.post('/jobs/:id/assign',async(req,res,next)=>{
  try{
    const driverId=Number(req.body?.driver_employee_id)||null;
    if(!driverId)return next(); // downstream owns the ordinary required-field error
    const {rows:[driver]}=await db.execute({sql:'SELECT id,active,is_driver FROM employees WHERE id=?',args:[driverId]});
    if(!driver||!driver.active||!driver.is_driver){
      return res.status(409).json({
        error:'Selected dispatch driver must be an active employee flagged as a driver.',
        control:'dispatch_driver_eligibility'
      });
    }
    next();
  }catch(e){res.status(500).json({error:'Unable to verify dispatch driver eligibility',detail:e.message});}
});

module.exports=router;
