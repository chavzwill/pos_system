'use strict';
const express=require('express');
const router=express.Router();
const {requireAuth}=require('../lib/permissions');
const {approvalError,sendApprovalError}=require('../lib/approval-routing-errors');
const {ensureApprovalRoutingSchema,listManagerApprovals,getApprovalForManager,recordApprovalDecision,isAuthorizedDepartmentManager}=require('../lib/approval-routing');
const purchasing=require('../lib/purchasing-approval-adapter');
router.use(requireAuth);
router.use((req,res,next)=>req.apiKey?sendApprovalError(req,res,approvalError('APPROVAL_API_KEY_FORBIDDEN'),{operation:'approval_api_key_boundary'}):next());
router.use(async(req,res,next)=>{try{await ensureApprovalRoutingSchema();next();}catch(error){sendApprovalError(req,res,error,{operation:'ensure_approval_schema'});}});
function human(row){const view=purchasing.presentation(row);return {...row,waiting_label:row.department_name?`Waiting for ${row.department_name} Manager`:'Waiting for authorized manager',can_decide:view.can_decide,decision_area:view.decision_area};}
router.get('/department-approvals',async(req,res)=>{try{const rows=await listManagerApprovals(req.employee);res.json({available:true,generated_at:new Date().toISOString(),rows:rows.map(human),summary:{total:rows.length,urgent:rows.filter(x=>x.priority==='urgent').length}});}catch(error){sendApprovalError(req,res,error,{operation:'list_department_approvals'});}});
router.get('/department-approvals/:id',async(req,res)=>{try{const row=await getApprovalForManager(req.params.id,req.employee);if(!row)throw approvalError('APPROVAL_NOT_FOUND');res.json(human(row));}catch(error){sendApprovalError(req,res,error,{operation:'get_department_approval'});}});
router.post('/department-approvals/:id/:decision',async(req,res)=>{try{
 const decision=String(req.params.decision||'');if(!['claim','changes_requested','approved','rejected'].includes(decision))throw approvalError('APPROVAL_INVALID_DECISION');
 const row=await getApprovalForManager(req.params.id,req.employee);if(!row)throw approvalError('APPROVAL_NOT_FOUND');
 if(!(await isAuthorizedDepartmentManager(req.employee.id,row.department_id,row.branch_id)))throw approvalError('APPROVAL_MANAGER_FORBIDDEN');
 const expectedVersion=Number(req.body?.version??row.version),notes=String(req.body?.notes||'').trim()||null;
 if(['approved','rejected'].includes(decision)){
  if(!purchasing.canHandle(row))throw approvalError('APPROVAL_HANDLER_UNAVAILABLE');
  const result=await purchasing.decidePurchaseRequest({approvalRow:row,employeeId:req.employee.id,expectedVersion,decision,notes});
  return res.json({...human(result.approval),authoritative_result:result.authoritative_result});
 }
 const updated=await recordApprovalDecision({approvalId:Number(row.id),employeeId:req.employee.id,expectedVersion,decision,notes});
 res.json(human(updated));
}catch(error){sendApprovalError(req,res,error,{operation:'change_department_approval'});}});
module.exports=router;
