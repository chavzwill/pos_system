'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {can}=require('../lib/permissions');

function crossBranch(employee){
  return !!employee && (can(employee.permissions,'branches') || can(employee.permissions,'security_manage'));
}
function assignedBranch(req){return req.employee?.default_branch_id==null?null:String(req.employee.default_branch_id);}
function deny(res,branchId){return res.status(403).json({error:`This action belongs to branch ${branchId}. Use your assigned branch or an authorized cross-branch administrator.`,control:'multi_branch_integrity'});}
function assertBranch(req,res,branchId){
  if(req.apiKey||!req.employee||crossBranch(req.employee))return true;
  const own=assignedBranch(req);if(!own)return true;
  if(branchId==null||String(branchId)!==own){deny(res,branchId??'unknown');return false;}
  return true;
}
async function sourceBranch(table,id){
  const {rows:[row]}=await db.execute({sql:`SELECT branch_id FROM ${table} WHERE id=?`,args:[id]});
  return row?row.branch_id:null;
}
function numericId(path,re){const m=path.match(re);return m?Number(m[1]):null;}

router.use(async(req,res,next)=>{
  try{
    if(req.apiKey||!req.employee||req.method==='GET'||req.method==='HEAD'||req.method==='OPTIONS')return next();
    const p=req.path;

    if(/^\/products\/\d+\/stock$/.test(p)&&req.method==='PATCH'){
      if(!assertBranch(req,res,req.body?.branch_id))return;
      return next();
    }

    if(p==='/work-orders'&&req.method==='POST'){
      if(!assertBranch(req,res,req.body?.branch_id))return;
      req.body.employee_id=req.employee.id;
      return next();
    }
    let id=numericId(p,/^\/work-orders\/(\d+)(?:\/|$)/);
    if(id){
      const branchId=await sourceBranch('work_orders',id);
      if(branchId==null)return next();
      if(!assertBranch(req,res,branchId))return;
      req.body ||= {};
      req.body.employee_id=req.employee.id;
      if(/\/(assessment-paid|deposit-paid|final-payment)$/.test(p))req.body.branch_id=branchId;
      return next();
    }

    if(p==='/rentals/agreements'&&req.method==='POST'){
      if(!assertBranch(req,res,req.body?.branch_id))return;
      req.body.employee_id=req.employee.id;
      return next();
    }
    id=numericId(p,/^\/rentals\/agreements\/(\d+)(?:\/|$)/);
    if(id){
      const branchId=await sourceBranch('rental_agreements',id);
      if(branchId==null)return next();
      if(!assertBranch(req,res,branchId))return;
      req.body ||= {};
      req.body.employee_id=req.employee.id;
      if(/\/(checkout|collect-balance|return)$/.test(p))req.body.branch_id=branchId;
      return next();
    }

    id=numericId(p,/^\/purchase-orders\/(\d+)\/receive$/);
    if(id){
      const branchId=await sourceBranch('purchase_orders',id);
      if(branchId==null)return next();
      if(!assertBranch(req,res,branchId))return;
      return next();
    }

    if(p==='/inventory-writeoffs'&&req.method==='POST'){
      if(!assertBranch(req,res,req.body?.branch_id))return;
      return next();
    }
    id=numericId(p,/^\/inventory-writeoffs\/(\d+)\/(approve|reject)$/);
    if(id){
      const branchId=await sourceBranch('inventory_writeoffs',id);
      if(branchId==null)return next();
      if(!assertBranch(req,res,branchId))return;
      return next();
    }

    // A transfer is cross-branch by definition, but an ordinary branch user may
    // only originate stock from their own branch and may only receive into their
    // own branch. Branch/Security administrators retain deliberate network-wide
    // authority. This protects stock custody without disabling real transfers.
    if(p==='/transfers'&&req.method==='POST'){
      if(!assertBranch(req,res,req.body?.from_branch_id))return;
      return next();
    }
    id=numericId(p,/^\/transfers\/(\d+)\/receive$/);
    if(id){
      const {rows:[tr]}=await db.execute({sql:'SELECT to_branch_id FROM branch_transfers WHERE id=?',args:[id]});
      if(!tr)return next();
      if(!assertBranch(req,res,tr.to_branch_id))return;
      return next();
    }

    next();
  }catch(e){res.status(500).json({error:'Multi-branch integrity check failed',detail:e.message});}
});
module.exports=router;
