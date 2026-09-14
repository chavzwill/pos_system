'use strict';
const {db}=require('../database');
const {ensureApprovalRoutingSchema,sha}=require('./approval-routing');
const {approvalError}=require('./approval-routing-errors');

const MODULE='purchase_requests';
const REQUEST_TYPE='purchase_request';
const REQUIRED_PERMISSION='purchasing_approve';

function canHandle(row){
 return row?.owning_module===MODULE&&row?.request_type===REQUEST_TYPE;
}

function presentation(row){
 return canHandle(row)?{can_decide:true,decision_area:'Purchasing'}:{can_decide:false,decision_area:null};
}

async function rollbackQuietly(tx,operation,context={}){
 try{await tx?.rollback();}catch(error){console.error('[purchasing-approval] rollback failed',{operation,...context,internal_error:String(error?.message||error)});}
}

async function resolveDepartment(executor,departmentId,legacyName){
 if(departmentId){
  const {rows:[row]}=await executor.execute({sql:'SELECT id,code,name,active FROM departments WHERE id=?',args:[Number(departmentId)]});
  if(row&&Number(row.active)===1)return row;
  throw approvalError('PURCHASE_REQUEST_DEPARTMENT_REQUIRED');
 }
 const legacy=String(legacyName||'').trim();
 if(!legacy)throw approvalError('PURCHASE_REQUEST_DEPARTMENT_REQUIRED');
 const {rows:[row]}=await executor.execute({sql:'SELECT id,code,name,active FROM departments WHERE active=1 AND (lower(code)=lower(?) OR lower(name)=lower(?)) ORDER BY id LIMIT 1',args:[legacy,legacy]});
 if(!row)throw approvalError('PURCHASE_REQUEST_DEPARTMENT_REQUIRED');
 return row;
}

async function submitPurchaseRequestForApproval({purchaseRequestId,employeeId,departmentId}){
 await ensureApprovalRoutingSchema();
 const tx=await db.transaction('write');
 try{
  const {rows:[pr]}=await tx.execute({sql:'SELECT * FROM purchase_requests WHERE id=?',args:[Number(purchaseRequestId)]});
  if(!pr)throw approvalError('PURCHASE_REQUEST_NOT_FOUND');

  const {rows:[existing]}=await tx.execute({sql:`SELECT * FROM approval_requests WHERE owning_module=? AND owning_record_id=? AND request_type=? ORDER BY id DESC LIMIT 1`,args:[MODULE,String(pr.id),REQUEST_TYPE]});
  if(pr.status==='submitted'&&existing){await tx.commit();return {purchase_request:pr,approval:existing,replayed:true};}
  if(pr.status!=='draft')throw approvalError('PURCHASE_REQUEST_NOT_DRAFT');

  const department=await resolveDepartment(tx,departmentId,pr.department);
  const payload={purchase_request_id:Number(pr.id),pr_number:pr.pr_number,branch_id:pr.branch_id||null,department_id:Number(department.id),supplier_id:pr.supplier_id||null,request_type:pr.request_type||'sale_items'};
  const payloadHash=sha(JSON.stringify(payload));
  const externalRequestId=`purchase-request:${pr.id}`;

  let approval=existing;
  if(existing){
   if(existing.payload_hash!==payloadHash)throw approvalError('APPROVAL_EXTERNAL_REQUEST_CONFLICT');
   if(!['submitted','in_review','changes_requested'].includes(existing.status))throw approvalError('PURCHASE_REQUEST_ALREADY_DECIDED');
  }else{
   const inserted=await tx.execute({sql:`INSERT INTO approval_requests(request_type,source_system,external_request_id,owning_module,owning_record_id,department_id,branch_id,requester_employee_id,requested_action,priority,required_permission,status,payload_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *`,args:[REQUEST_TYPE,'pos',externalRequestId,MODULE,String(pr.id),department.id,pr.branch_id||null,pr.employee_id||employeeId||null,`Approve purchase request ${pr.pr_number}`,'normal',REQUIRED_PERMISSION,'submitted',payloadHash]});
   approval=inserted.rows[0];
   await tx.execute({sql:`INSERT INTO approval_events(approval_request_id,event_type,from_status,to_status,actor_employee_id,notes) VALUES(?,?,?,?,?,?)`,args:[approval.id,'submitted',null,'submitted',employeeId||pr.employee_id||null,`Purchase request ${pr.pr_number} submitted for department approval.`]});
  }

  const updated=await tx.execute({sql:`UPDATE purchase_requests SET status='submitted' WHERE id=? AND status='draft' RETURNING *`,args:[pr.id]});
  if(!updated.rows.length)throw approvalError('PURCHASE_REQUEST_NOT_DRAFT');
  await tx.commit();
  return {purchase_request:updated.rows[0],approval,replayed:false};
 }catch(error){await rollbackQuietly(tx,'submit_purchase_request',{purchase_request_id:purchaseRequestId});throw error;}
}

async function decidePurchaseRequest({approvalRow,employeeId,expectedVersion,decision,notes}){
 if(!canHandle(approvalRow))throw approvalError('APPROVAL_HANDLER_UNAVAILABLE');
 if(!['approved','rejected'].includes(decision))throw approvalError('APPROVAL_INVALID_DECISION');
 await ensureApprovalRoutingSchema();
 const tx=await db.transaction('write');
 try{
  const {rows:[current]}=await tx.execute({sql:'SELECT * FROM approval_requests WHERE id=?',args:[Number(approvalRow.id)]});
  if(!current)throw approvalError('APPROVAL_NOT_FOUND');
  if(!canHandle(current))throw approvalError('APPROVAL_HANDLER_UNAVAILABLE');
  if(!['submitted','in_review'].includes(current.status))throw approvalError('APPROVAL_NOT_PENDING');
  if(Number(current.version)!==Number(expectedVersion))throw approvalError('APPROVAL_VERSION_CONFLICT');

  const {rows:[pr]}=await tx.execute({sql:'SELECT * FROM purchase_requests WHERE id=?',args:[Number(current.owning_record_id)]});
  if(!pr)throw approvalError('PURCHASE_REQUEST_NOT_FOUND');
  if(pr.status!=='submitted')throw approvalError('PURCHASE_REQUEST_NOT_PENDING');

  let prUpdate;
  if(decision==='approved'){
   prUpdate=await tx.execute({sql:`UPDATE purchase_requests SET status='approved',approved_by=?,approved_at=CURRENT_TIMESTAMP,rejection_reason=NULL WHERE id=? AND status='submitted' RETURNING *`,args:[employeeId,pr.id]});
  }else{
   const reason=String(notes||'').trim()||'Rejected by authorized department manager';
   prUpdate=await tx.execute({sql:`UPDATE purchase_requests SET status='rejected',approved_by=NULL,approved_at=NULL,rejection_reason=? WHERE id=? AND status='submitted' RETURNING *`,args:[reason,pr.id]});
  }
  if(!prUpdate.rows.length)throw approvalError('PURCHASE_REQUEST_NOT_PENDING');

  const approvalUpdate=await tx.execute({sql:`UPDATE approval_requests SET status=?,version=version+1,decided_at=CURRENT_TIMESTAMP,decided_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND version=? AND status IN ('submitted','in_review') RETURNING *`,args:[decision,employeeId,current.id,expectedVersion]});
  if(!approvalUpdate.rows.length)throw approvalError('APPROVAL_VERSION_CONFLICT');

  const authoritativeResult={type:'purchase_request',purchase_request_id:Number(pr.id),pr_number:pr.pr_number,status:decision};
  await tx.execute({sql:`INSERT INTO approval_events(approval_request_id,event_type,from_status,to_status,actor_employee_id,notes,authoritative_result) VALUES(?,?,?,?,?,?,?)`,args:[current.id,decision,current.status,decision,employeeId,notes||null,JSON.stringify(authoritativeResult)]});
  await tx.commit();
  return {approval:approvalUpdate.rows[0],purchase_request:prUpdate.rows[0],authoritative_result:authoritativeResult};
 }catch(error){await rollbackQuietly(tx,'decide_purchase_request',{approval_id:approvalRow?.id,purchase_request_id:approvalRow?.owning_record_id});throw error;}
}

module.exports={MODULE,REQUEST_TYPE,REQUIRED_PERMISSION,canHandle,presentation,submitPurchaseRequestForApproval,decidePurchaseRequest};
