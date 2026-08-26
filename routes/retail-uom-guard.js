'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');
const {ensureUomSchema,resolveProductUom,toBaseQuantity,snapshot}=require('../lib/unit-of-measure');

async function normalize(req){
  await ensureUomSchema();
  const items=Array.isArray(req.body?.items)?req.body.items:[];
  const evidence=[];
  for(const line of items){
    const productId=Number(line.product_id);if(!productId)continue;
    const enteredQuantity=Number(line.quantity);const resolved=await resolveProductUom(db,productId,line.uom_code||line.unit||null,'sell');
    const baseQuantity=toBaseQuantity(enteredQuantity,resolved);
    evidence.push({productId,enteredQuantity,resolved,baseQuantity,line});
    line.entered_quantity=enteredQuantity;line.entered_uom=resolved.uom_code;line.uom_factor_to_base=Number(resolved.factor_to_base);line.base_uom=resolved.profile.base_uom;line.quantity=baseQuantity;
  }
  req.uomEvidence=evidence;
}
async function saveEvidence(req,payload,sourceType){
  if(!payload?.id||!req.uomEvidence?.length)return;
  const tx=await db.transaction('write');let committed=false;
  try{
    for(const e of req.uomEvidence)await snapshot(tx,{sourceType,sourceId:payload.id,sourceLineId:null,productId:e.productId,enteredQuantity:e.enteredQuantity,resolved:e.resolved,baseQuantity:e.baseQuantity});
    await tx.commit();committed=true;
  }catch(err){if(!committed)await tx.rollback();throw err;}
}
function guard(sourceType){return async(req,res,next)=>{
  try{await normalize(req);}catch(e){return res.status(409).json({error:e.message});}
  const originalJson=res.json.bind(res);let handled=false;
  res.json=function(payload){
    if(handled)return originalJson(payload);handled=true;
    if(res.statusCode>=200&&res.statusCode<300&&payload?.id){
      return saveEvidence(req,payload,sourceType).then(()=>originalJson(payload)).catch(e=>{if(!res.headersSent){res.status(500);return originalJson({error:'Transaction posted but UOM evidence finalization failed; reconciliation required',transaction_id:payload.id,detail:e.message});}});
    }
    return originalJson(payload);
  };
  next();
};}
router.post('/',requirePermission('pos'),guard('transaction'));
router.post('/hold',requirePermission('pos_hold'),guard('held_transaction'));
module.exports=router;
