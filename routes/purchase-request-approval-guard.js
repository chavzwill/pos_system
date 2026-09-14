'use strict';
const express=require('express');
const router=express.Router();
const {requirePermission}=require('../lib/permissions');
const {approvalError,sendApprovalError}=require('../lib/approval-routing-errors');
const {submitPurchaseRequestForApproval}=require('../lib/purchasing-approval-adapter');

router.patch('/:id/status',requirePermission('purchase_requests'),async(req,res,next)=>{
 const status=String(req.body?.status||'').trim();
 if(!['submitted','approved','rejected'].includes(status))return next();
 try{
  if(req.apiKey)throw approvalError('APPROVAL_API_KEY_FORBIDDEN');
  if(['approved','rejected'].includes(status))throw approvalError('PURCHASE_REQUEST_APPROVAL_REQUIRED');
  const result=await submitPurchaseRequestForApproval({purchaseRequestId:Number(req.params.id),employeeId:req.employee?.id||null,departmentId:req.body?.department_id||null});
  return res.json(result.purchase_request);
 }catch(error){
  return sendApprovalError(req,res,error,{operation:'purchase_request_approval_guard'});
 }
});

module.exports=router;
