'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requireAuth,can}=require('../lib/permissions');
const {approvalError,sendApprovalError}=require('../lib/approval-routing-errors');
const {ensureApprovalRoutingSchema,listManagerApprovals,getApprovalForManager,recordApprovalDecision,isAuthorizedDepartmentManager}=require('../lib/approval-routing');
const purchasing=require('../lib/purchasing-approval-adapter');
const customerCredit=require('../lib/customer-credit-approval-adapter');
const adapters=[purchasing,customerCredit];
function adapterFor(row){return adapters.find(adapter=>adapter.canHandle(row))||null;}
function presentation(row){return adapterFor(row)?.presentation(row)||{can_decide:false,decision_area:null};}
router.use(requireAuth);
router.use((req,res,next)=>req.apiKey?sendApprovalError(req,res,approvalError('APPROVAL_API_KEY_FORBIDDEN'),{operation:'approval_api_key_boundary'}):next());
router.use(async(req,res,next)=>{try{await ensureApprovalRoutingSchema();next();}catch(error){sendApprovalError(req,res,error,{operation:'ensure_approval_schema'});}});
function human(row){const view=presentation(row);return {...row,waiting_label:row.department_name?`Waiting for ${row.department_name} Manager`:'Waiting for authorized manager',can_decide:view.can_decide,decision_area:view.decision_area};}
async function classifyMissingPendingApproval(id,employee){
 const {rows:[raw]}=await db.execute({sql:`SELECT ar.*,d.name department_name,d.code department_code FROM approval_requests ar JOIN departments d ON d.id=ar.department_id WHERE ar.id=?`,args:[Number(id)]});
 if(!raw)throw approvalError('APPROVAL_NOT_FOUND');
 const manager=await isAuthorizedDepartmentManager(employee.id,raw.department_id,raw.branch_id);
 const permitted=!raw.required_permission||can(employee.permissions,raw.required_permission);
 if(!manager||!permitted)throw approvalError('APPROVAL_NOT_FOUND');
 throw approvalError('APPROVAL_NOT_PENDING');
}
router.get('/department-approvals',async(req,res)=>{try{const rows=await listManagerApprovals(req.employee);res.json({available:true,generated_at:new Date().toISOString(),rows:rows.map(human),summary:{total:rows.length,urgent:rows.filter(x=>x.priority==='urgent').length}});}catch(error){sendApprovalError(req,res,error,{operation:'list_department_approvals'});}});
router.get('/department-approvals/:id',async(req,res)=>{try{const row=await getApprovalForManager(req.params.id,req.employee);if(!row)throw approvalError('APPROVAL_NOT_FOUND');res.json(human(row));}catch(error){sendApprovalError(req,res,error,{operation:'get_department_approval'});}});
router.post('/department-approvals/:id/:decision',async(req,res)=>{try{
 const decision=String(req.params.decision||'');if(!['claim','changes_requested','approved','rejected'].includes(decision))throw approvalError('APPROVAL_INVALID_DECISION');
 const row=await getApprovalForManager(req.params.id,req.employee);if(!row)return await classifyMissingPendingApproval(req.params.id,req.employee);
 if(!(await isAuthorizedDepartmentManager(req.employee.id,row.department_id,row.branch_id)))throw approvalError('APPROVAL_MANAGER_FORBIDDEN');
 const expectedVersion=Number(req.body?.version??row.version),notes=String(req.body?.notes||'').trim()||null;
 if(['approved','rejected'].includes(decision)){
  const adapter=adapterFor(row);if(!adapter)throw approvalError('APPROVAL_HANDLER_UNAVAILABLE');
  const result=adapter===purchasing?await adapter.decidePurchaseRequest({approvalRow:row,employeeId:req.employee.id,expectedVersion,decision,notes}):await adapter.decideCustomerCreditChange({approvalRow:row,employeeId:req.employee.id,expectedVersion,decision,notes});
  return res.json({...human(result.approval),authoritative_result:result.authoritative_result});
 }
 const updated=await recordApprovalDecision({approvalId:Number(row.id),employeeId:req.employee.id,expectedVersion,decision,notes});
 res.json(human(updated));
}catch(error){sendApprovalError(req,res,error,{operation:'change_department_approval'});}});
module.exports=router;
