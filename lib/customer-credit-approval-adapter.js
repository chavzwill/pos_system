'use strict';
const {db}=require('../database');
const {ensureApprovalRoutingSchema,sha}=require('./approval-routing');
const {approvalError}=require('./approval-routing-errors');

const MODULE='customer_credit';
const REQUEST_TYPE='customer_credit_change';
const REQUIRED_PERMISSION='accounts_credit_approve';

function canHandle(row){return row?.owning_module===MODULE&&row?.request_type===REQUEST_TYPE;}
function presentation(row){return canHandle(row)?{can_decide:true,decision_area:'Accounts'}:{can_decide:false,decision_area:null};}
async function rollbackQuietly(tx,operation,context={}){try{await tx?.rollback();}catch(error){console.error('[customer-credit-approval] rollback failed',{operation,...context,internal_error:String(error?.message||error)});}}

function normalizeProposal(input={}){
 const enabled=input.credit_enabled===true||input.credit_enabled===1||input.credit_enabled==='1';
 const limit=Number(input.credit_limit);
 const terms=Number(input.credit_terms_days??30);
 if(!Number.isFinite(limit)||limit<0)throw approvalError('CREDIT_CHANGE_INVALID');
 if(!Number.isInteger(terms)||terms<1||terms>365)throw approvalError('CREDIT_CHANGE_INVALID');
 if(enabled&&limit<=0)throw approvalError('CREDIT_CHANGE_INVALID');
 return {credit_enabled:enabled,credit_limit:Number(limit.toFixed(2)),credit_terms_days:terms,reason:String(input.reason||'').trim()||null};
}

async function resolveDepartment(executor,departmentId){
 if(!departmentId)throw approvalError('CREDIT_CHANGE_DEPARTMENT_REQUIRED');
 const {rows:[row]}=await executor.execute({sql:'SELECT id,code,name,active FROM departments WHERE id=?',args:[Number(departmentId)]});
 if(!row||Number(row.active)!==1)throw approvalError('CREDIT_CHANGE_DEPARTMENT_REQUIRED');
 return row;
}

async function submitCustomerCreditChange({customerId,employeeId,branchId,departmentId,proposal}){
 if(!employeeId)throw approvalError('APPROVAL_MANAGER_FORBIDDEN');
 await ensureApprovalRoutingSchema();
 const normalized=normalizeProposal(proposal);
 const tx=await db.transaction('write');
 try{
  const {rows:[customer]}=await tx.execute({sql:'SELECT id,customer_number,first_name,last_name,customer_type,credit_enabled,credit_limit,credit_terms_days,active FROM customers WHERE id=?',args:[Number(customerId)]});
  if(!customer||Number(customer.active)!==1)throw approvalError('CREDIT_CHANGE_CUSTOMER_NOT_FOUND');
  const department=await resolveDepartment(tx,departmentId);
  const payload={customer_id:Number(customer.id),credit_enabled:normalized.credit_enabled,credit_limit:normalized.credit_limit,credit_terms_days:normalized.credit_terms_days,department_id:Number(department.id),branch_id:branchId||null,reason:normalized.reason};
  const payloadHash=sha(JSON.stringify(payload));
  const externalRequestId=`customer-credit:${customer.id}:${payloadHash}`;
  const {rows:[existing]}=await tx.execute({sql:`SELECT * FROM approval_requests WHERE source_system='pos' AND external_request_id=? ORDER BY id DESC LIMIT 1`,args:[externalRequestId]});
  if(existing){await tx.commit();return {approval:existing,replayed:true,customer};}
  const {rows:[active]}=await tx.execute({sql:`SELECT * FROM approval_requests WHERE owning_module=? AND owning_record_id=? AND request_type=? AND status IN ('draft','submitted','in_review','changes_requested') ORDER BY id DESC LIMIT 1`,args:[MODULE,String(customer.id),REQUEST_TYPE]});
  if(active)throw approvalError('CREDIT_CHANGE_ALREADY_PENDING');
  const requestedAction=`Review credit terms for ${customer.customer_number||`customer ${customer.id}`}`;
  const inserted=await tx.execute({sql:`INSERT INTO approval_requests(request_type,source_system,external_request_id,owning_module,owning_record_id,department_id,branch_id,requester_employee_id,requested_action,priority,required_permission,status,payload_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *`,args:[REQUEST_TYPE,'pos',externalRequestId,MODULE,String(customer.id),department.id,branchId||null,employeeId,requestedAction,'normal',REQUIRED_PERMISSION,'submitted',payloadHash]});
  const approval=inserted.rows[0];
  const evidence={proposal:payload,previous:{credit_enabled:!!Number(customer.credit_enabled),credit_limit:Number(customer.credit_limit||0),credit_terms_days:Number(customer.credit_terms_days||30),customer_type:customer.customer_type||'cash'}};
  await tx.execute({sql:`INSERT INTO approval_events(approval_request_id,event_type,from_status,to_status,actor_employee_id,notes,authoritative_result) VALUES(?,?,?,?,?,?,?)`,args:[approval.id,'submitted',null,'submitted',employeeId,normalized.reason,JSON.stringify(evidence)]});
  await tx.commit();
  return {approval,replayed:false,customer};
 }catch(error){await rollbackQuietly(tx,'submit_customer_credit_change',{customer_id:customerId});throw error;}
}

async function proposalFromSubmission(executor,approvalId){
 const {rows:[event]}=await executor.execute({sql:`SELECT authoritative_result FROM approval_events WHERE approval_request_id=? AND event_type='submitted' ORDER BY id ASC LIMIT 1`,args:[Number(approvalId)]});
 if(!event?.authoritative_result)throw approvalError('CREDIT_CHANGE_INVALID');
 try{return JSON.parse(event.authoritative_result);}catch(_){throw approvalError('CREDIT_CHANGE_INVALID');}
}

async function decideCustomerCreditChange({approvalRow,employeeId,expectedVersion,decision,notes}){
 if(!canHandle(approvalRow))throw approvalError('APPROVAL_HANDLER_UNAVAILABLE');
 if(!['approved','rejected'].includes(decision))throw approvalError('APPROVAL_INVALID_DECISION');
 const tx=await db.transaction('write');
 try{
  const {rows:[current]}=await tx.execute({sql:'SELECT * FROM approval_requests WHERE id=?',args:[Number(approvalRow.id)]});
  if(!current)throw approvalError('APPROVAL_NOT_FOUND');
  if(!canHandle(current))throw approvalError('APPROVAL_HANDLER_UNAVAILABLE');
  if(!['submitted','in_review'].includes(current.status))throw approvalError('APPROVAL_NOT_PENDING');
  if(Number(current.version)!==Number(expectedVersion))throw approvalError('APPROVAL_VERSION_CONFLICT');
  const {rows:[customer]}=await tx.execute({sql:'SELECT * FROM customers WHERE id=?',args:[Number(current.owning_record_id)]});
  if(!customer)throw approvalError('CREDIT_CHANGE_CUSTOMER_NOT_FOUND');
  const evidence=await proposalFromSubmission(tx,current.id);
  const proposal=evidence?.proposal;
  if(!proposal||Number(proposal.customer_id)!==Number(customer.id))throw approvalError('CREDIT_CHANGE_INVALID');
  let resultState={credit_enabled:!!Number(customer.credit_enabled),credit_limit:Number(customer.credit_limit||0),credit_terms_days:Number(customer.credit_terms_days||30),customer_type:customer.customer_type||'cash'};
  if(decision==='approved'){
   const enabled=!!proposal.credit_enabled;
   const update=await tx.execute({sql:`UPDATE customers SET credit_enabled=?,credit_limit=?,credit_terms_days=?,customer_type=?,account_blocked=CASE WHEN ?=0 THEN 0 ELSE account_blocked END WHERE id=? RETURNING credit_enabled,credit_limit,credit_terms_days,customer_type,account_blocked`,args:[enabled?1:0,enabled?Number(proposal.credit_limit):0,Number(proposal.credit_terms_days),enabled?'credit':'cash',enabled?1:0,customer.id]});
   if(!update.rows.length)throw approvalError('CREDIT_CHANGE_CUSTOMER_NOT_FOUND');
   const row=update.rows[0];
   resultState={credit_enabled:!!Number(row.credit_enabled),credit_limit:Number(row.credit_limit||0),credit_terms_days:Number(row.credit_terms_days||30),customer_type:row.customer_type};
  }
  const approvalUpdate=await tx.execute({sql:`UPDATE approval_requests SET status=?,version=version+1,decided_at=CURRENT_TIMESTAMP,decided_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND version=? AND status IN ('submitted','in_review') RETURNING *`,args:[decision,employeeId,current.id,expectedVersion]});
  if(!approvalUpdate.rows.length)throw approvalError('APPROVAL_VERSION_CONFLICT');
  const authoritativeResult={type:'customer_credit',customer_id:Number(customer.id),status:decision,previous:evidence.previous||null,result:resultState};
  await tx.execute({sql:`INSERT INTO approval_events(approval_request_id,event_type,from_status,to_status,actor_employee_id,notes,authoritative_result) VALUES(?,?,?,?,?,?,?)`,args:[current.id,decision,current.status,decision,employeeId,notes||null,JSON.stringify(authoritativeResult)]});
  await tx.commit();
  return {approval:approvalUpdate.rows[0],authoritative_result:authoritativeResult};
 }catch(error){await rollbackQuietly(tx,'decide_customer_credit_change',{approval_id:approvalRow?.id,customer_id:approvalRow?.owning_record_id});throw error;}
}

module.exports={MODULE,REQUEST_TYPE,REQUIRED_PERMISSION,canHandle,presentation,normalizeProposal,submitCustomerCreditChange,decideCustomerCreditChange};
