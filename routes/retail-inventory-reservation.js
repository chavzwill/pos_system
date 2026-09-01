'use strict';
const express=require('express');
const crypto=require('crypto');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');
const {ensureInventoryReservations,reserveLines,releaseReservation}=require('../lib/inventory-reservations');

router.post('/',requirePermission('pos'),async(req,res,next)=>{
  let reservationKey=null;
  try{
    const body=req.body||{};
    const lines=Array.isArray(body.items)?body.items:[];
    let branchId=Number(body.branch_id||0);
    if(!branchId&&req.apiKey){
      const {rows:[setting]}=await db.execute({sql:"SELECT value FROM settings WHERE key='woo_sync_branch_id'",args:[]});
      branchId=Number(setting?.value||0);
    }
    if(!lines.length||!branchId)return next();
    await ensureInventoryReservations();
    reservationKey=`POS-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
    const tx=await db.transaction('write');let committed=false;
    try{
      await reserveLines(tx,{reservationKey,branchId,lines,sourceType:req.apiKey?'online_checkout':'pos_checkout',sourceReference:String(body.quote_id||body.source_return_id||''),employeeId:req.employee?.id||null,ttlSeconds:120});
      await tx.commit();committed=true;
    }catch(e){if(!committed)await tx.rollback();return res.status(e.status||409).json({error:e.message});}
    req.inventoryReservationKey=reservationKey;
    req.body.branch_id=branchId;
    let released=false;
    const release=async reason=>{if(released)return;released=true;try{await releaseReservation(reservationKey,reason);}catch(e){console.error('Inventory reservation release failed',reservationKey,e.message);}};
    res.on('finish',()=>{release(res.statusCode>=200&&res.statusCode<400?'checkout_finished':'checkout_failed');});
    res.on('close',()=>{if(!res.writableEnded)release('client_disconnected');});
    next();
  }catch(e){
    if(reservationKey)releaseReservation(reservationKey,'reservation_error').catch(()=>{});
    res.status(500).json({error:e.message});
  }
});

module.exports=router;
