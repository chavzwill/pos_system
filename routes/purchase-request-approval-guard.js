'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission,can}=require('../lib/permissions');
const {approvalError,sendApprovalError}=require('../lib/approval-routing-errors');
const {submitPurchaseRequestForApproval}=require('../lib/purchasing-approval-adapter');

function canCrossBranch(employee){return !!employee&&(can(employee.permissions,'branches')||can(employee.permissions,'security_manage'));}
async function assertPurchaseRequestBranch(req,id){
 const {rows:[row]}=await db.execute({sql:'SELECT branch_id FROM purchase_requests WHERE id=?',args:[Number(id)]});
 if(!row)throw approvalError('PURCHASE_REQUEST_NOT_FOUND');
 const own=req.employee?.default_branch_id;
 if(own!=null&&row.branch_id!=null&&!canCrossBranch(req.employee)&&Number(own)!==Number(row.branch_id))throw approvalError('PURCHASE_REQUEST_BRANCH_FORBIDDEN');
}

router.patch('/:id/status',requirePermission('purchase_requests'),async(req,res,next)=>{
 const status=String(req.body?.status||'').trim();
 if(!['submitted','approved','rejected'].includes(status))return next();
 try{
  if(req.apiKey)throw approvalError('APPROVAL_API_KEY_FORBIDDEN');
  await assertPurchaseRequestBranch(req,req.params.id);
  if(['approved','rejected'].includes(status))throw approvalError('PURCHASE_REQUEST_APPROVAL_REQUIRED');
  const result=await submitPurchaseRequestForApproval({purchaseRequestId:Number(req.params.id),employeeId:req.employee.id,departmentId:req.body?.department_id||null});
  return res.json(result.purchase_request);
 }catch(error){
  return sendApprovalError(req,res,error,{operation:'purchase_request_approval_guard'});
 }
});

module.exports=router;
