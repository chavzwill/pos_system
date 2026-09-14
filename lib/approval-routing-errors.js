'use strict';

const DEFINITIONS=Object.freeze({
 APPROVAL_API_KEY_FORBIDDEN:{status:403,message:'API keys cannot operate internal approval workflows.'},
 DEPARTMENT_API_KEY_FORBIDDEN:{status:403,message:'API keys cannot administer departments.'},
 APPROVAL_INVALID_DECISION:{status:400,message:'That approval action is not available.'},
 INVALID_APPROVAL_DECISION:{status:400,code:'APPROVAL_INVALID_DECISION',message:'That approval action is not available.'},
 APPROVAL_NOT_FOUND:{status:404,message:'This approval request was not found or is no longer available to you.'},
 APPROVAL_MANAGER_FORBIDDEN:{status:403,message:'You are not authorized to manage this department approval.'},
 APPROVAL_HANDLER_UNAVAILABLE:{status:409,message:'This request must be completed in its owning module before it can be approved or rejected.'},
 APPROVAL_VERSION_CONFLICT:{status:409,message:'This request changed while you were reviewing it. Refresh the queue and review the latest version.'},
 APPROVAL_NOT_PENDING:{status:409,message:'This request is no longer waiting for a decision.'},
 APPROVAL_EXTERNAL_REQUEST_CONFLICT:{status:409,message:'A request with this external reference already exists with different details.'},
 APPROVAL_STORAGE_BUSY:{status:503,message:'Approvals are temporarily busy. Please try again.'},
 APPROVAL_INTERNAL_ERROR:{status:500,message:'We could not complete the approval request. Please try again or contact a supervisor if it continues.'},
 DEPARTMENT_VALIDATION:{status:400,message:'Department code and name are required.'},
 DEPARTMENT_CODE_CONFLICT:{status:409,message:'That department code is already in use.'},
 DEPARTMENT_EMPLOYEE_INVALID:{status:400,message:'Choose an active employee.'},
 DEPARTMENT_NOT_ACTIVE:{status:400,message:'Choose an active department.'},
 DEPARTMENT_INTERNAL_ERROR:{status:500,message:'We could not update department settings. Please try again or contact an administrator if it continues.'}
});

function approvalError(code,details={}){
 const def=DEFINITIONS[code]||DEFINITIONS.APPROVAL_INTERNAL_ERROR;
 const e=new Error(code);
 e.code=DEFINITIONS[code]?(def.code||code):'APPROVAL_INTERNAL_ERROR';
 e.status=details.status||def.status;
 e.publicMessage=details.message||def.message;
 if(details.cause)e.cause=details.cause;
 return e;
}

function isStorageBusy(error){return /SQLITE_BUSY|database is locked/i.test(String(error?.code||error?.message||''));}
function safeApprovalError(error,fallbackCode='APPROVAL_INTERNAL_ERROR'){
 const key=String(error?.code||error?.message||'');
 const known=DEFINITIONS[key]||null;
 const fallback=DEFINITIONS[fallbackCode]||DEFINITIONS.APPROVAL_INTERNAL_ERROR;
 if(isStorageBusy(error))return {status:503,code:'APPROVAL_STORAGE_BUSY',error:DEFINITIONS.APPROVAL_STORAGE_BUSY.message,retryable:true};
 const def=known||fallback;
 return {status:known?(Number(error?.status)||def.status):def.status,code:known?(def.code||key):(DEFINITIONS[fallbackCode]?fallbackCode:'APPROVAL_INTERNAL_ERROR'),error:known?(error?.publicMessage||def.message):def.message,retryable:false};
}
function sendApprovalError(req,res,error,context={}){
 const safe=safeApprovalError(error,context.fallbackCode);
 console.error('[approval-routing]',{operation:context.operation||'unknown',employee_id:req?.employee?.id||null,code:safe.code,internal_error:String(error?.code||error?.message||error||'unknown')});
 return res.status(safe.status).json({error:safe.error,code:safe.code,retryable:safe.retryable});
}

module.exports={DEFINITIONS,approvalError,isStorageBusy,safeApprovalError,sendApprovalError};
