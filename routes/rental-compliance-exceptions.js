'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');
const {eligibility,grantException,revokeException}=require('../lib/rental-compliance');

function fail(res,e){
  const status=Number(e?.status)||500;
  if(status>=500)console.error('rental_compliance_exception_error',{code:e?.code||'unknown',message:e?.message||'unknown'});
  return res.status(status).json({error:status>=500?'Unable to update rental compliance right now.':e.message,code:e?.code||'RENTAL_COMPLIANCE_FAILED',...(e?.details||{})});
}
function internalOnly(req,res){
  if(req.apiKey){res.status(403).json({error:'API keys cannot grant or revoke staff rental compliance exceptions',code:'RENTAL_COMPLIANCE_INTERNAL_ONLY'});return false;}
  return true;
}
router.get('/customers/:customerId/rental-compliance',requirePermission('rentals'),async(req,res)=>{
  try{
    const {rows:[customer]}=await db.execute({sql:'SELECT * FROM customers WHERE id=?',args:[req.params.customerId]});
    if(!customer)return res.status(404).json({error:'Customer not found',code:'RENTAL_COMPLIANCE_CUSTOMER_NOT_FOUND'});
    const result=await eligibility(db,customer);
    res.json({customer_id:customer.id,...result});
  }catch(e){fail(res,e);}
});
router.post('/customers/:customerId/rental-compliance-exceptions',requirePermission('rentals_compliance_exception'),async(req,res)=>{
  if(!internalOnly(req,res))return;
  try{
    const created=await grantException(db,{customerId:req.params.customerId,approvedBy:req.employee?.id,reason:req.body?.reason,expiresAt:req.body?.expires_at});
    res.status(201).json(created);
  }catch(e){fail(res,e);}
});
router.post('/rental-compliance-exceptions/:id/revoke',requirePermission('rentals_compliance_exception'),async(req,res)=>{
  if(!internalOnly(req,res))return;
  try{res.json(await revokeException(db,{exceptionId:req.params.id,revokedBy:req.employee?.id,reason:req.body?.reason}));}
  catch(e){fail(res,e);}
});
module.exports=router;
