'use strict';
const express=require('express');
const router=express.Router();
const {ensureInventoryTraceability}=require('../lib/inventory-traceability');
router.use(async(req,res,next)=>{try{await ensureInventoryTraceability();next();}catch(e){res.status(500).json({error:'Rental asset traceability initialization failed',detail:e.message});}});
module.exports=router;