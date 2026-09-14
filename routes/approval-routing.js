'use strict';
const express=require('express');
const router=express.Router();
const {requireAuth}=require('../lib/permissions');
const {ensureApprovalRoutingSchema,listManagerApprovals,getApprovalForManager,recordApprovalDecision,isAuthorizedDepartmentManager}=require('../lib/approval-routing');
router.use(requireAuth);
router.use((req,res,next)=>req.apiKey?res.status(403).json({error:'API keys cannot operate internal approval workflows'}):next());
router.use(async(req,res,next)=>{try{await ensureApprovalRoutingSchema();next();}catch(e){res.status(500).json({error:e.message});}});
function human(row){return {...row,waiting_label:row.department_name?`Waiting for ${row.department_name} Manager`:'Waiting for authorized manager',can_decide:false};}
router.get('/department-approvals',async(req,res)=>{try{const rows=await listManagerApprovals(req.employee);res.json({available:true,generated_at:new Date().toISOString(),rows:rows.map(human),summary:{total:rows.length,urgent:rows.filter(x=>x.priority==='urgent').length}});}catch(e){res.status(500).json({error:e.message});}});
router.get('/department-approvals/:id',async(req,res)=>{try{const row=await getApprovalForManager(req.params.id,req.employee);if(!row)return res.status(404).json({error:'Approval request not found or not available to you'});res.json(human(row));}catch(e){res.status(500).json({error:e.message});}});
router.post('/department-approvals/:id/:decision',async(req,res)=>{try{
 const decision=String(req.params.decision||'');if(!['claim','changes_requested','approved','rejected'].includes(decision))return res.status(400).json({error:'Invalid approval action'});
 const row=await getApprovalForManager(req.params.id,req.employee);if(!row)return res.status(404).json({error:'Approval request not found or not available to you'});
 if(!(await isAuthorizedDepartmentManager(req.employee.id,row.department_id,row.branch_id)))return res.status(403).json({error:'You are not an authorized manager for this department'});
 if(['approved','rejected'].includes(decision))return res.status(409).json({error:'This request type has no authoritative decision handler yet'});
 const updated=await recordApprovalDecision({approvalId:Number(row.id),employeeId:req.employee.id,expectedVersion:Number(req.body?.version??row.version),decision,notes:String(req.body?.notes||'').trim()||null});
 res.json(human(updated));
}catch(e){res.status(e.status||500).json({error:e.message});}});
module.exports=router;
