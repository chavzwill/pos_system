'use strict';
function complianceMissing(customer){
  const missing=[];
  if(!customer?.is_rental_customer)missing.push('rental customer designation');
  if(!customer?.rental_id_type||!customer?.rental_id_number)missing.push('photo ID type and number');
  if(!customer?.rental_id_scan_path)missing.push('scanned photo ID');
  if(!customer?.rental_address_proof_type)missing.push('proof of address');
  if(!customer?.rental_reference_name||!customer?.rental_reference_phone)missing.push('reference name and phone');
  return missing;
}
async function activeException(executor,customerId){
  const {rows:[row]}=await executor.execute({sql:`SELECT e.*,a.first_name||' '||a.last_name AS approved_by_name
    FROM rental_compliance_exceptions e
    LEFT JOIN employees a ON a.id=e.approved_by
    WHERE e.customer_id=? AND datetime(e.expires_at)>datetime('now')
      AND NOT EXISTS(SELECT 1 FROM rental_compliance_exception_revocations r WHERE r.exception_id=e.id)
    ORDER BY datetime(e.expires_at) DESC,e.id DESC LIMIT 1`,args:[customerId]});
  return row||null;
}
async function eligibility(executor,customer){
  if(!customer)return{eligible:false,via_exception:false,missing:['customer record'],exception:null};
  const missing=complianceMissing(customer);
  if(!missing.length)return{eligible:true,via_exception:false,missing:[],exception:null};
  const exception=await activeException(executor,customer.id);
  return{eligible:!!exception,via_exception:!!exception,missing,exception};
}
async function assertEligible(executor,customer){
  const result=await eligibility(executor,customer);
  if(result.eligible)return result;
  const name=customer?([customer.first_name,customer.last_name].filter(Boolean).join(' ')||'Customer'):'Customer';
  const e=new Error(`${name}'s rental record still needs ${result.missing.join(', ')}. Complete the customer record or have an authorized manager grant a temporary compliance exception.`);
  e.code='RENTAL_CUSTOMER_COMPLIANCE_REQUIRED';e.status=409;e.details=result;throw e;
}
async function grantException(executor,{customerId,approvedBy,reason,expiresAt}){
  const id=Number(customerId),actor=Number(approvedBy),why=String(reason||'').trim(),expiry=new Date(expiresAt);
  if(!Number.isInteger(id)||id<=0)throw Object.assign(new Error('Customer is required'),{status:400,code:'RENTAL_COMPLIANCE_CUSTOMER_REQUIRED'});
  if(!Number.isInteger(actor)||actor<=0)throw Object.assign(new Error('Authenticated approver is required'),{status:403,code:'RENTAL_COMPLIANCE_APPROVER_REQUIRED'});
  if(why.length<10)throw Object.assign(new Error('Explain why this temporary exception is necessary.'),{status:400,code:'RENTAL_COMPLIANCE_REASON_REQUIRED'});
  if(Number.isNaN(expiry.getTime()))throw Object.assign(new Error('Choose a valid exception expiry date and time.'),{status:400,code:'RENTAL_COMPLIANCE_EXPIRY_INVALID'});
  const now=Date.now(),ms=expiry.getTime()-now;
  if(ms<=0)throw Object.assign(new Error('Exception expiry must be in the future.'),{status:400,code:'RENTAL_COMPLIANCE_EXPIRY_PAST'});
  if(ms>30*24*60*60*1000)throw Object.assign(new Error('Temporary rental compliance exceptions cannot exceed 30 days.'),{status:400,code:'RENTAL_COMPLIANCE_EXPIRY_TOO_LONG'});
  const {rows:[customer]}=await executor.execute({sql:'SELECT * FROM customers WHERE id=?',args:[id]});
  if(!customer)throw Object.assign(new Error('Customer not found'),{status:404,code:'RENTAL_COMPLIANCE_CUSTOMER_NOT_FOUND'});
  const missing=complianceMissing(customer);
  if(!missing.length)throw Object.assign(new Error('This customer already meets the rental compliance requirements.'),{status:409,code:'RENTAL_COMPLIANCE_ALREADY_COMPLETE'});
  const existing=await activeException(executor,id);
  if(existing)throw Object.assign(new Error('This customer already has an active temporary rental compliance exception.'),{status:409,code:'RENTAL_COMPLIANCE_EXCEPTION_ACTIVE',details:{exception:existing}});
  const result=await executor.execute({sql:`INSERT INTO rental_compliance_exceptions(customer_id,approved_by,reason,missing_requirements_json,expires_at)
    VALUES(?,?,?,?,?)`,args:[id,actor,why,JSON.stringify(missing),expiry.toISOString()]});
  const {rows:[created]}=await executor.execute({sql:'SELECT * FROM rental_compliance_exceptions WHERE id=?',args:[Number(result.lastInsertRowid)]});
  return{...created,missing_requirements:missing};
}
async function revokeException(executor,{exceptionId,revokedBy,reason}){
  const id=Number(exceptionId),actor=Number(revokedBy),why=String(reason||'').trim();
  if(!Number.isInteger(id)||id<=0)throw Object.assign(new Error('Exception is required'),{status:400,code:'RENTAL_COMPLIANCE_EXCEPTION_REQUIRED'});
  if(!Number.isInteger(actor)||actor<=0)throw Object.assign(new Error('Authenticated approver is required'),{status:403,code:'RENTAL_COMPLIANCE_APPROVER_REQUIRED'});
  if(why.length<5)throw Object.assign(new Error('Explain why the exception is being revoked.'),{status:400,code:'RENTAL_COMPLIANCE_REVOCATION_REASON_REQUIRED'});
  const {rows:[row]}=await executor.execute({sql:'SELECT * FROM rental_compliance_exceptions WHERE id=?',args:[id]});
  if(!row)throw Object.assign(new Error('Rental compliance exception not found'),{status:404,code:'RENTAL_COMPLIANCE_EXCEPTION_NOT_FOUND'});
  try{await executor.execute({sql:'INSERT INTO rental_compliance_exception_revocations(exception_id,revoked_by,reason) VALUES(?,?,?)',args:[id,actor,why]});}
  catch(e){if(/unique/i.test(String(e.message)))throw Object.assign(new Error('This exception has already been revoked.'),{status:409,code:'RENTAL_COMPLIANCE_EXCEPTION_REVOKED'});throw e;}
  return{success:true,exception_id:id};
}
module.exports={complianceMissing,activeException,eligibility,assertEligible,grantException,revokeException};