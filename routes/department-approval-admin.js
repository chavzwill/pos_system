'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requireAuth,requirePermission}=require('../lib/permissions');
const {ensureApprovalRoutingSchema}=require('../lib/approval-routing');
const {approvalError,sendApprovalError}=require('../lib/approval-routing-errors');
router.use(requireAuth);
router.use((req,res,next)=>req.apiKey?sendApprovalError(req,res,approvalError('DEPARTMENT_API_KEY_FORBIDDEN'),{operation:'department_admin_api_key_boundary',fallbackCode:'DEPARTMENT_INTERNAL_ERROR'}):next());
router.use(requirePermission('security_assign'));
router.use(async(req,res,next)=>{try{await ensureApprovalRoutingSchema();next();}catch(error){sendApprovalError(req,res,error,{operation:'ensure_department_schema',fallbackCode:'DEPARTMENT_INTERNAL_ERROR'});}});
const norm=v=>String(v||'').trim();
router.get('/departments',async(req,res)=>{try{const {rows}=await db.execute({sql:'SELECT * FROM departments ORDER BY active DESC,name',args:[]});res.json({rows});}catch(error){sendApprovalError(req,res,error,{operation:'list_departments',fallbackCode:'DEPARTMENT_INTERNAL_ERROR'});}});
router.post('/departments',async(req,res)=>{try{
 const code=norm(req.body?.code).toLowerCase(),name=norm(req.body?.name);if(!code||!name)throw approvalError('DEPARTMENT_VALIDATION');
 const r=await db.execute({sql:'INSERT INTO departments(code,name) VALUES(?,?) RETURNING *',args:[code,name]});res.status(201).json(r.rows[0]);
}catch(error){
 if(/UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i.test(String(error?.message||error?.code||'')))error=approvalError('DEPARTMENT_CODE_CONFLICT',{cause:error});
 sendApprovalError(req,res,error,{operation:'create_department',fallbackCode:'DEPARTMENT_INTERNAL_ERROR'});
}});
router.post('/departments/:id/members',async(req,res)=>{try{
 const departmentId=Number(req.params.id),employeeId=Number(req.body?.employee_id),branchId=req.body?.branch_id==null?null:Number(req.body.branch_id),isManager=req.body?.is_manager?1:0;
 const {rows:[employee]}=await db.execute({sql:'SELECT id,active FROM employees WHERE id=?',args:[employeeId]});if(!employee||!employee.active)throw approvalError('DEPARTMENT_EMPLOYEE_INVALID');
 const {rows:[department]}=await db.execute({sql:'SELECT id,active FROM departments WHERE id=?',args:[departmentId]});if(!department||!department.active)throw approvalError('DEPARTMENT_NOT_ACTIVE');
 await db.execute({sql:`INSERT INTO employee_department_memberships(employee_id,department_id,branch_id,is_manager,active,created_by) VALUES(?,?,?,?,1,?) ON CONFLICT(employee_id,department_id,COALESCE(branch_id,-1)) DO UPDATE SET is_manager=excluded.is_manager,active=1,updated_at=CURRENT_TIMESTAMP`,args:[employeeId,departmentId,branchId,isManager,req.employee.id]});
 res.status(201).json({employee_id:employeeId,department_id:departmentId,branch_id:branchId,is_manager:!!isManager,active:true});
}catch(error){sendApprovalError(req,res,error,{operation:'assign_department_member',fallbackCode:'DEPARTMENT_INTERNAL_ERROR'});}});
router.get('/departments/:id/members',async(req,res)=>{try{const {rows}=await db.execute({sql:`SELECT edm.*,e.first_name,e.last_name,e.active employee_active FROM employee_department_memberships edm JOIN employees e ON e.id=edm.employee_id WHERE edm.department_id=? ORDER BY edm.is_manager DESC,e.first_name,e.last_name`,args:[Number(req.params.id)]});res.json({rows});}catch(error){sendApprovalError(req,res,error,{operation:'list_department_members',fallbackCode:'DEPARTMENT_INTERNAL_ERROR'});}});
module.exports=router;
