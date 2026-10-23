'use strict';
const express=require('express');
const bcrypt=require('bcryptjs');
const {db,ensureReady}=require('../database');
const {requirePermission}=require('../lib/permissions');
const {privilegedPinRateLimit,resetRequestRateLimit}=require('../lib/securityHardening');
const router=express.Router();
// Private, non-enumerable request state keeps approval secrets out of JSON/logs.
const approvals=new WeakMap();
let ready;
function failure(message,status=403){const error=new Error(message);error.status=status;return error;}
async function ensureSchema(){
 if(ready)return ready;
 ready=(async()=>{
  await ensureReady();
  await db.batch([
   {sql:`CREATE TABLE IF NOT EXISTS retail_return_authorizations (
    return_id INTEGER PRIMARY KEY REFERENCES returns(id),
    original_transaction_id INTEGER NOT NULL REFERENCES transactions(id),
    original_branch_id INTEGER,
    initiated_by_employee_id INTEGER NOT NULL REFERENCES employees(id),
    authorized_by_employee_id INTEGER NOT NULL REFERENCES employees(id),
    authorizer_name TEXT NOT NULL,
    reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 5 AND 1000),
    authorized_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK(initiated_by_employee_id != authorized_by_employee_id)
   )`,args:[]},
   {sql:`CREATE TRIGGER IF NOT EXISTS retail_return_authorizations_no_update BEFORE UPDATE ON retail_return_authorizations BEGIN SELECT RAISE(ABORT,'Return authorization evidence is immutable'); END`,args:[]},
   {sql:`CREATE TRIGGER IF NOT EXISTS retail_return_authorizations_no_delete BEFORE DELETE ON retail_return_authorizations BEGIN SELECT RAISE(ABORT,'Return authorization evidence is immutable'); END`,args:[]}
  ],'write');
  const {rows}=await db.execute({sql:'SELECT id,name,permissions FROM security_groups',args:[]});
  for(const group of rows){
   let p;try{p=JSON.parse(group.permissions||'{}');}catch(_){continue;}
   if(!p||Array.isArray(p)||typeof p!=='object')continue;
   if(!Object.prototype.hasOwnProperty.call(p,'returns_authorize')&&/^(administrator|manager)$/i.test(String(group.name||'').trim())){
    p.returns_authorize=true;
    // Compare-and-set prevents overwriting concurrent permission administration.
    await db.execute({sql:'UPDATE security_groups SET permissions=? WHERE id=? AND permissions=?',args:[JSON.stringify(p),group.id,group.permissions]});
   }
  }
 })().catch(e=>{ready=null;throw e;});
 return ready;
}
async function validate(executor,req,approval){
 if(!req.employee?.id)throw failure('An authenticated cashier is required for independently authorized returns',401);
 if(!approval||approval.cashierId!==Number(req.employee.id)||approval.transactionId!==Number(req.params.id))throw failure('Independent return authorization is required');
 if(approval.reason.length<5||approval.reason.length>1000)throw failure('Return reason must contain 5–1000 characters',400);
 if(!Number.isSafeInteger(approval.authorizerId)||approval.authorizerId<=0||!approval.password)throw failure('Authorizer employee ID and password are required',400);
 if(approval.authorizerId===approval.cashierId)throw failure('A different employee must authorize this return');
 const {rows:[sale]}=await executor.execute({sql:'SELECT id,branch_id FROM transactions WHERE id=?',args:[approval.transactionId]});
 if(!sale)throw failure('Transaction not found',404);
 const {rows:[employee]}=await executor.execute({sql:`SELECT e.id,e.first_name,e.last_name,e.password,e.default_branch_id,g.permissions FROM employees e LEFT JOIN security_groups g ON g.id=e.security_group_id WHERE e.id=? AND e.active=1`,args:[approval.authorizerId]});
 let permissions={};try{permissions=JSON.parse(employee?.permissions||'{}');}catch(_){}
 if(!employee||permissions?.returns_authorize!==true)throw failure('Authorizer is inactive or lacks explicit return authorization permission');
 let branchAllowed=permissions.multi_branch_access===true||permissions.security_manage===true;
 if(!branchAllowed&&sale.branch_id!=null){
  branchAllowed=Number(employee.default_branch_id)===Number(sale.branch_id);
  if(!branchAllowed){const {rows}=await executor.execute({sql:'SELECT 1 FROM employee_branches WHERE employee_id=? AND branch_id=?',args:[employee.id,sale.branch_id]});branchAllowed=rows.length>0;}
 }
 if(!branchAllowed)throw failure('Authorizer is not authorized for the original selling branch');
 if(!/^\$2[aby]\$/.test(String(employee.password||''))||!await bcrypt.compare(approval.password,employee.password))throw failure('Invalid authorizer credentials');
 return {sale,employee};
}
async function authorizeReturn(req,res,next,capturedPassword){
 const body=req.body||{};
 const approval={transactionId:Number(req.params.id),cashierId:Number(req.employee?.id),authorizerId:Number(body.return_authorizer_id),password:typeof capturedPassword==='string'?capturedPassword:typeof body.return_authorizer_password==='string'?body.return_authorizer_password:'',reason:String(body.return_reason??body.notes??'').trim()};
 delete body.return_authorizer_password;
 try{
  // Reuse the existing bounded credential-attempt infrastructure with a fixed
  // permission suffix; caller-supplied permission cannot create fresh buckets.
  let permitted=false;
  const rateRequest={...req,ip:req.ip,socket:req.socket,body:{permission:'returns_authorize'}};
  privilegedPinRateLimit(rateRequest,res,()=>{permitted=true;});
  if(!permitted)return;
  await ensureSchema();
  await validate(db,req,approval);
  resetRequestRateLimit(rateRequest);
  approvals.set(req,approval);
  body.notes=approval.reason;
  res.once?.('finish',()=>approvals.delete(req));
  next();
 }catch(error){approvals.delete(req);res.status(error.status||500).json({error:error.status?error.message:'Return authorization failed'});}
}
async function recordReturnAuthorization(tx,req,returnId){
 const approval=approvals.get(req);
 try{
  const {sale,employee}=await validate(tx,req,approval);
  const {rows:[ret]}=await tx.execute({sql:'SELECT original_transaction_id FROM returns WHERE id=?',args:[returnId]});
  if(!ret||Number(ret.original_transaction_id)!==Number(sale.id))throw failure('Return authorization does not match this return');
  await tx.execute({sql:`INSERT INTO retail_return_authorizations(return_id,original_transaction_id,original_branch_id,initiated_by_employee_id,authorized_by_employee_id,authorizer_name,reason) VALUES(?,?,?,?,?,?,?)`,args:[returnId,sale.id,sale.branch_id??null,approval.cashierId,employee.id,[employee.first_name,employee.last_name].filter(Boolean).join(' '),approval.reason]});
 }finally{approvals.delete(req);}
}
router.post('/:id/return',(req,res,next)=>{const password=req.body?.return_authorizer_password;if(req.body)delete req.body.return_authorizer_password;requirePermission('transactions_returns')(req,res,()=>authorizeReturn(req,res,next,password));});
module.exports={router,authorizeReturn,ensureSchema,recordReturnAuthorization};
