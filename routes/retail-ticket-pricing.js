'use strict';
const express=require('express');const router=express.Router();
const {db}=require('../database');const {can,requirePermission}=require('../lib/permissions');
const {priceTicket}=require('../lib/retail-ticket-pricing');
async function price(req,res,next){try{
  const b=req.body;
  if(req.path==='/hold'&&b.promotion_code)throw new Error('Promotion codes must be revalidated at checkout; remove the code before holding');
  // Promotion protection has already verified any promotion code against its live rule.
  if(b.promotion_code&&b.items.some(x=>Number(x.line_discount_percent||0)>0))throw new Error('Line discounts cannot be combined with a promotion code');
  const source=b.promotion_code?null:await require('../lib/retail-discount-source').resolveSource(b);
  const intent=b.promotion_code?{mode:'amount',value:b.discount_amount}:{mode:b.discount_mode||'amount',value:b.discount_value??b.discount_amount??0};
  const evidence=priceTicket(b.items,source?.intent||intent,source?.eligibleIndices||req.retailPromotionEvidence?.eligibleIndices);evidence.source=b.promotion_code?'promotion_code':source?.source||(evidence.discount_amount?'manual':'none');evidence.referenceId=source?.referenceId||req.retailPromotionEvidence?.promotionId||null;
  if(evidence.discount_amount>0&&!b.promotion_code&&!source){
    if(req.apiKey||!can(req.employee?.permissions,'pos_discounts'))return res.status(403).json({error:'Missing permission: pos_discounts'});
    const {rows:[s]}=await db.execute({sql:"SELECT value FROM settings WHERE key='max_discount_pct'",args:[]});const cap=Number(s?.value||0),gross=b.items.reduce((sum,x)=>sum+Math.round(Number(x.quantity)*Number(x.uom_base_unit_price??x.unit_price)*100),0);
    if(cap>0&&Math.round(evidence.discount_amount*100)>Math.round(gross*cap/100))throw new Error(`Combined discount exceeds the ${cap}% limit`);
  }
  req.retailTicketPricing=evidence;b.discount_amount=evidence.discount_amount;
  b.discount_mode=evidence.mode;b.discount_value=evidence.value;
  b.retail_ticket={extras:req.retailTicketExtras||[],discount:{mode:evidence.mode,value:evidence.value,source:evidence.source,allocations:evidence.allocations}};
  next();
}catch(e){res.status(400).json({error:e.message});}}
router.post('/',requirePermission('pos'),price);router.post('/hold',requirePermission('pos_hold'),price);
module.exports=router;
