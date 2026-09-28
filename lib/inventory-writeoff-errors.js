'use strict';
const ERRORS={
 WRITEOFF_NOT_FOUND:{status:404,message:'This inventory write-off was not found.'},
 WRITEOFF_NOT_PENDING:{status:409,message:'This inventory write-off is no longer waiting for approval.'},
 WRITEOFF_SELF_APPROVAL_FORBIDDEN:{status:403,message:'This inventory write-off requires independent approval.'},
 WRITEOFF_STOCK_CHANGED:{status:409,message:'Inventory changed before approval. Reload and review the write-off before trying again.'},
 WRITEOFF_IDENTITY_CHANGED:{status:409,message:'The selected serial or lot inventory changed before approval. Reload and review the write-off.'},
 WRITEOFF_FINANCIAL_AUTH_REQUIRED:{status:409,message:'This inventory write-off requires independent financial authorization before approval.'},
 WRITEOFF_FINANCIAL_AUTH_FORBIDDEN:{status:403,message:'The supplied financial authorization cannot approve this inventory write-off.'},
 WRITEOFF_CONCURRENT_DECISION:{status:409,message:'This inventory write-off was decided by another action. Reload to see its current status.'},
 WRITEOFF_INTERNAL_ERROR:{status:500,message:'We could not complete this inventory write-off. No partial approval was recorded. Please try again or contact a supervisor if it continues.'}
};
function writeoffError(code,details={}){
 const def=ERRORS[code]||ERRORS.WRITEOFF_INTERNAL_ERROR;
 return Object.assign(new Error(def.message),{code,status:def.status,...details});
}
function logWriteoffError(error,context={}){
 const code=ERRORS[error?.code]?error.code:'WRITEOFF_INTERNAL_ERROR';
 console.error('[inventory-writeoff]',{...context,code,internal_error:String(error?.message||error||'unknown')});
}
function sendWriteoffError(res,error,context={}){
 const code=ERRORS[error?.code]?error.code:'WRITEOFF_INTERNAL_ERROR';
 const def=ERRORS[code];
 logWriteoffError(error,context);
 return res.status(def.status).json({error:def.message,code});
}
async function rollbackWriteoffQuietly(tx,context={},originalError=null){
 try{await tx?.rollback();}
 catch(error){logWriteoffError(error,{...context,operation:`${context.operation||'writeoff'}_rollback`,original_code:originalError?.code||null});}
}
module.exports={ERRORS,writeoffError,sendWriteoffError,rollbackWriteoffQuietly,logWriteoffError};
