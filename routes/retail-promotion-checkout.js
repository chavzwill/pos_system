'use strict';
const express=require('express');
const router=express.Router();
const {withLifecycleLocks}=require('../lib/lifecycleLock');
const promo=require('../lib/retailPromotionIntegrity');

router.post('/',
  withLifecycleLocks(promo.lockKeys,{ttlSeconds:120,label:'promotion redemption'}),
  async(req,res,next)=>{
    try{
      await promo.ensureUsageIntegrity();
      const cart=await promo.authoritativeCart(req.body||{});
      const result=await promo.validate(req.body||{},cart.subtotal,cart.lines);
      if(result.error)return res.status(409).json({error:result.error,control:'promotion_revalidation'});
      req.retailPromotionValidation=result;
      req.retailPromotionEvidence=result.evidence;
      next();
    }catch(error){res.status(400).json({error:error.message,control:'promotion_revalidation'});}
  });

module.exports=router;
