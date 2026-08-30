'use strict';
const express=require('express');
const router=express.Router();
const {requireAnyPermission}=require('../lib/permissions');
const BAD=new Set(['n/a','na','none','unknown','tbd','-']);
function meaningful(v){const s=String(v||'').trim();return s.length>=3&&!BAD.has(s.toLowerCase());}
router.post('/assets',requireAnyPermission('inventory_edit','reports_financial'),(req,res,next)=>{
  if(!meaningful(req.body?.acquisition_evidence_ref))return res.status(400).json({error:'A meaningful acquisition invoice/receipt/receiving evidence reference is required'});
  next();
});
router.post('/assets/:id/economic-events',requireAnyPermission('reports_financial','inventory_writeoff_approve'),(req,res,next)=>{
  if(!meaningful(req.body?.evidence_ref))return res.status(400).json({error:'A meaningful financial evidence reference is required for an asset recovery or loss event'});
  next();
});
router.post('/assets/:id/dispose',requireAnyPermission('reports_financial','inventory_writeoff_approve'),(req,res,next)=>{
  if(!meaningful(req.body?.evidence_ref))return res.status(400).json({error:'A meaningful disposal/sale/write-off evidence reference is required'});
  next();
});
module.exports=router;