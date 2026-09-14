'use strict';
const crypto=require('crypto');
const {db}=require('../database');
const {can}=require('./permissions');
const {approvalError,isStorageBusy}=require('./approval-routing-errors');
let readyPromise=null;
const ACTIVE_STATES=new Set(['submitted','in_review']);
const externalInflight=new Map();
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function sha(v){return crypto.createHash('sha256').update(String(v||'')).digest('hex');}
async function ensureApprovalRoutingSchema(){
 if(readyPromise)return readyPromise;
 readyPromise=db.batch([
  {sql:`CREATE TABLE IF NOT EXISTS departments(id INTEGER PRIMARY KEY AUTOINCREMENT,code TEXT NOT NULL UNIQUE,name TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,created_at DATETIME DEFAULT CURRENT_TIMESTAMP,updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`},
  {sql:`CREATE TABLE IF NOT EXISTS employee_department_memberships(id INTEGER PRIMARY KEY AUTOINCREMENT,employee_id INTEGER NOT NULL REFERENCES employees(id),department_id INTEGER NOT NULL REFERENCES departments(id),branch_id INTEGER REFERENCES branches(id),is_manager INTEGER NOT NULL DEFAULT 0,active INTEGER NOT NULL DEFAULT 1,created_by INTEGER REFERENCES employees(id),created_at DATETIME DEFAULT CURRENT_TIMESTAMP,updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,CHECK(is_manager IN (0,1)),CHECK(active IN (0,1)))`},
  {sql:`CREATE UNIQUE INDEX IF NOT EXISTS ux_employee_department_membership ON employee_department_memberships(employee_id,department_id,COALESCE(branch_id,-1))`},
  {sql:`CREATE TABLE IF NOT EXISTS approval_requests(id INTEGER PRIMARY KEY AUTOINCREMENT,request_type TEXT NOT NULL,source_system TEXT NOT NULL DEFAULT 'pos',external_request_id TEXT,owning_module TEXT NOT NULL,owning_record_id TEXT,department_id INTEGER NOT NULL REFERENCES departments(id),branch_id INTEGER REFERENCES branches(id),requester_employee_id INTEGER REFERENCES employees(id),customer_id INTEGER REFERENCES customers(id),organization_ref TEXT,member_ref TEXT,requested_action TEXT NOT NULL,priority TEXT NOT NULL DEFAULT 'normal',required_permission TEXT,status TEXT NOT NULL DEFAULT 'submitted',payload_hash TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,decided_at DATETIME,decided_by INTEGER REFERENCES employees(id),created_at DATETIME DEFAULT CURRENT_TIMESTAMP,updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,CHECK(status IN ('draft','submitted','in_review','approved','rejected','changes_requested','cancelled')))`},
  {sql:`CREATE UNIQUE INDEX IF NOT EXISTS ux_approval_external ON approval_requests(source_system,external_request_id) WHERE external_request_id IS NOT NULL`},
  {sql:`CREATE UNIQUE INDEX IF NOT EXISTS ux_approval_owner_active ON approval_requests(owning_module,owning_record_id,request_type) WHERE owning_record_id IS NOT NULL AND status IN ('submitted','in_review','changes_requested')`},
  {sql:`CREATE TABLE IF NOT EXISTS approval_events(id INTEGER PRIMARY KEY AUTOINCREMENT,approval_request_id INTEGER NOT NULL REFERENCES approval_requests(id),event_type TEXT NOT NULL,from_status TEXT,to_status TEXT,actor_employee_id INTEGER REFERENCES employees(id),notes TEXT,authoritative_result TEXT,created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`},
  {sql:`CREATE TRIGGER IF NOT EXISTS trg_approval_events_no_update BEFORE UPDATE ON approval_events BEGIN SELECT RAISE(ABORT,'approval evidence is immutable'); END`},
  {sql:`CREATE TRIGGER IF NOT EXISTS trg_approval_events_no_delete BEFORE DELETE ON approval_events BEGIN SELECT RAISE(ABORT,'approval evidence is immutable'); END`},
  {sql:`CREATE TRIGGER IF NOT EXISTS trg_approval_requests_no_evidence_delete BEFORE DELETE ON approval_requests WHEN EXISTS (SELECT 1 FROM approval_events WHERE approval_request_id=OLD.id) BEGIN SELECT RAISE(ABORT,'approval request has immutable evidence'); END`}
 ],'write').catch(e=>{readyPromise=null;throw e;});
 return readyPromise;
}
async function isAuthorizedDepartmentManager(employeeId,departmentId,branchId){
 await ensureApprovalRoutingSchema();
 const {rows}=await db.execute({sql:`SELECT edm.*,e.active employee_active,e.default_branch_id FROM employee_department_memberships edm JOIN employees e ON e.id=edm.employee_id WHERE edm.employee_id=? AND edm.department_id=? AND edm.is_manager=1 AND edm.active=1 AND e.active=1 AND (edm.branch_id IS NULL OR edm.branch_id=?)`,args:[employeeId,departmentId,branchId]});
 if(!rows.length)return false;
 return rows.some(r=>r.branch_id==null||Number(r.branch_id)===Number(branchId));
}
async function findExternalReplay(sourceSystem,externalRequestId,payloadHash){
 const {rows:[existing]}=await db.execute({sql:'SELECT * FROM approval_requests WHERE source_system=? AND external_request_id=?',args:[sourceSystem,externalRequestId]});
 if(!existing)return null;
 if(existing.payload_hash!==payloadHash)throw approvalError('APPROVAL_EXTERNAL_REQUEST_CONFLICT');
 return existing;
}
async function waitForExternalReplay(sourceSystem,externalRequestId,payloadHash){
 for(let attempt=0;attempt<16;attempt++){
  try{const existing=await findExternalReplay(sourceSystem,externalRequestId,payloadHash);if(existing)return existing;}catch(error){if(!isStorageBusy(error))throw error;}
  await sleep(Math.min(250,15+(attempt*15)));
 }
 return null;
}
async function rollbackQuietly(tx,label,context={}){
 try{await tx?.rollback();}catch(error){console.error('[approval-routing] rollback failed',{operation:label,...context,internal_error:String(error?.message||error)});}
}
async function createApprovalRequestWrite(input,payloadHash,sourceSystem){
 if(input.externalRequestId){
  try{const existing=await findExternalReplay(sourceSystem,input.externalRequestId,payloadHash);if(existing)return existing;}catch(error){if(!isStorageBusy(error))throw error;}
 }
 for(let attempt=0;attempt<4;attempt++){
  let tx;
  try{tx=await db.transaction('write');}
  catch(error){
   if(input.externalRequestId&&isStorageBusy(error)){
    const existing=await waitForExternalReplay(sourceSystem,input.externalRequestId,payloadHash);
    if(existing)return existing;
    await sleep(25*(attempt+1));
    continue;
   }
   throw error;
  }
  try{
   const r=await tx.execute({sql:`INSERT INTO approval_requests(request_type,source_system,external_request_id,owning_module,owning_record_id,department_id,branch_id,requester_employee_id,customer_id,organization_ref,member_ref,requested_action,priority,required_permission,status,payload_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *`,args:[input.requestType,sourceSystem,input.externalRequestId||null,input.owningModule,input.owningRecordId==null?null:String(input.owningRecordId),input.departmentId,input.branchId||null,input.requesterEmployeeId||null,input.customerId||null,input.organizationRef||null,input.memberRef||null,input.requestedAction,input.priority||'normal',input.requiredPermission||null,input.status||'submitted',payloadHash]});
   const row=r.rows[0];
   await tx.execute({sql:`INSERT INTO approval_events(approval_request_id,event_type,from_status,to_status,actor_employee_id,notes) VALUES(?,?,?,?,?,?)`,args:[row.id,'submitted',null,row.status,input.requesterEmployeeId||null,input.notes||null]});
   await tx.commit();return row;
  }catch(error){
   await rollbackQuietly(tx,'create_approval',{external_request_id:input.externalRequestId||null});
   if(input.externalRequestId){
    const existing=await waitForExternalReplay(sourceSystem,input.externalRequestId,payloadHash);
    if(existing)return existing;
    if(isStorageBusy(error)){await sleep(25*(attempt+1));continue;}
   }
   throw error;
  }
 }
 throw approvalError('APPROVAL_STORAGE_BUSY');
}
async function createApprovalRequest(input){
 await ensureApprovalRoutingSchema();
 const payloadHash=input.payloadHash||sha(JSON.stringify(input.payload||{}));
 const sourceSystem=input.sourceSystem||'pos';
 if(!input.externalRequestId)return createApprovalRequestWrite(input,payloadHash,sourceSystem);
 const externalRequestId=String(input.externalRequestId);
 const key=`${sourceSystem}\u0000${externalRequestId}`;
 const active=externalInflight.get(key);
 if(active){
  const row=await active.promise;
  if(active.payloadHash!==payloadHash)throw approvalError('APPROVAL_EXTERNAL_REQUEST_CONFLICT');
  return row;
 }
 const promise=createApprovalRequestWrite(input,payloadHash,sourceSystem);
 externalInflight.set(key,{payloadHash,promise});
 try{return await promise;}
 finally{if(externalInflight.get(key)?.promise===promise)externalInflight.delete(key);}
}
async function listManagerApprovals(employee){
 await ensureApprovalRoutingSchema();
 const branchId=employee.default_branch_id||null;
 const {rows}=await db.execute({sql:`SELECT ar.*,d.code department_code,d.name department_name FROM approval_requests ar JOIN departments d ON d.id=ar.department_id JOIN employee_department_memberships edm ON edm.department_id=ar.department_id AND edm.employee_id=? AND edm.active=1 AND edm.is_manager=1 WHERE ar.status IN ('submitted','in_review','changes_requested') AND (edm.branch_id IS NULL OR edm.branch_id=ar.branch_id) AND (? IS NULL OR ar.branch_id IS NULL OR ar.branch_id=?) ORDER BY ar.submitted_at ASC LIMIT 200`,args:[employee.id,branchId,branchId]});
 return rows.filter(r=>!r.required_permission||can(employee.permissions,r.required_permission));
}
async function getApprovalForManager(id,employee){
 const rows=await listManagerApprovals(employee);
 return rows.find(r=>Number(r.id)===Number(id))||null;
}
async function recordApprovalDecision({approvalId,employeeId,expectedVersion,decision,notes,authoritativeResult=null}){
 await ensureApprovalRoutingSchema();
 const valid={claim:'in_review',changes_requested:'changes_requested',approved:'approved',rejected:'rejected'};
 const next=valid[decision];
 if(!next)throw approvalError('APPROVAL_INVALID_DECISION');
 const {rows:[current]}=await db.execute({sql:'SELECT * FROM approval_requests WHERE id=?',args:[approvalId]});
 if(!current)throw approvalError('APPROVAL_NOT_FOUND');
 const allowed=ACTIVE_STATES.has(current.status)||(decision==='claim'&&current.status==='changes_requested');
 if(!allowed)throw approvalError('APPROVAL_NOT_PENDING');
 const tx=await db.transaction('write');
 try{
  const r=await tx.execute({sql:`UPDATE approval_requests SET status=?,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND version=? RETURNING *`,args:[next,approvalId,expectedVersion]});
  if(!r.rows.length)throw approvalError('APPROVAL_VERSION_CONFLICT');
  await tx.execute({sql:`INSERT INTO approval_events(approval_request_id,event_type,from_status,to_status,actor_employee_id,notes,authoritative_result) VALUES(?,?,?,?,?,?,?)`,args:[approvalId,decision,current.status,next,employeeId,notes||null,authoritativeResult?JSON.stringify(authoritativeResult):null]});
  await tx.commit();
  return r.rows[0];
 }catch(error){await rollbackQuietly(tx,'approval_decision',{approval_id:approvalId});throw error;}
}
module.exports={ensureApprovalRoutingSchema,createApprovalRequest,listManagerApprovals,getApprovalForManager,recordApprovalDecision,isAuthorizedDepartmentManager,sha};
