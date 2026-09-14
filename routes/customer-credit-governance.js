'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requireAuth}=require('../lib/permissions');
const {approvalError,sendApprovalError}=require('../lib/approval-routing-errors');
const credit=require('../lib/customer-credit-approval-adapter');

function path(req){return String(req.originalUrl||'').split('?')[0];}
function requestedCredit(body={}){
 return body.customer_type==='credit'||body.credit_enabled===true||body.credit_enabled===1||body.credit_enabled==='1'||(body.credit_limit!==undefined&&Number(body.credit_limit)>0);
}
router.use(requireAuth);
router.use((req,res,next)=>req.apiKey?sendApprovalError(req,res,approvalError('APPROVAL_API_KEY_FORBIDDEN'),{operation:'customer_credit_api_key_boundary'}):next());
router.post('/accounts/customer/:id/credit-change-requests',async(req,res)=>{try{
 const result=await credit.submitCustomerCreditChange({customerId:req.params.id,employeeId:req.employee.id,branchId:req.employee.default_branch_id||null,departmentId:req.body?.department_id,proposal:req.body||{}});
 res.status(result.replayed?200:201).json({approval:result.approval,replayed:result.replayed});
}catch(error){sendApprovalError(req,res,error,{operation:'submit_customer_credit_change'});}});
router.use(async(req,res,next)=>{try{
 const p=path(req);
 if(req.method==='PATCH'&&/^\/api\/accounts\/customer\/\d+$/.test(p)){
  if(req.body?.credit_enabled!==undefined||req.body?.credit_limit!==undefined||req.body?.credit_terms_days!==undefined)return sendApprovalError(req,res,approvalError('CREDIT_CHANGE_APPROVAL_REQUIRED'),{operation:'block_direct_account_credit_change'});
 }
 if(req.method==='POST'&&p==='/api/customers'&&requestedCredit(req.body))return sendApprovalError(req,res,approvalError('CREDIT_CHANGE_APPROVAL_REQUIRED'),{operation:'block_direct_credit_customer_create'});
 if(req.method==='PUT'&&/^\/api\/customers\/\d+$/.test(p)){
  const {rows:[current]}=await db.execute({sql:'SELECT customer_type,credit_enabled,credit_limit,credit_terms_days FROM customers WHERE id=?',args:[Number(req.params.id)]});
  if(current){
   const proposedEnabled=req.body?.customer_type!==undefined?req.body.customer_type==='credit':req.body?.credit_enabled!==undefined?!!req.body.credit_enabled:!!Number(current.credit_enabled);
   const proposedLimit=req.body?.credit_limit!==undefined?Number(req.body.credit_limit):Number(current.credit_limit||0);
   const proposedTerms=req.body?.credit_terms_days!==undefined?Number(req.body.credit_terms_days):Number(current.credit_terms_days||30);
   if(proposedEnabled!==!!Number(current.credit_enabled)||proposedLimit!==Number(current.credit_limit||0)||proposedTerms!==Number(current.credit_terms_days||30))return sendApprovalError(req,res,approvalError('CREDIT_CHANGE_APPROVAL_REQUIRED'),{operation:'block_direct_customer_credit_change'});
  }
 }
 next();
}catch(error){sendApprovalError(req,res,error,{operation:'customer_credit_governance_guard'});}});
module.exports=router;
