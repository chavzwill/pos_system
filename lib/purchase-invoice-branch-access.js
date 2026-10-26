'use strict';
const {can}=require('./permissions');

// Invoice capture, posting and receipt matching share the same branch boundary.
function assertPurchaseInvoiceBranch(req,row){
 const employee=req.employee,branch=Number(row?.branch_id);
 const own=Number(employee?.default_branch_id);
 const assigned=Number.isSafeInteger(own)&&own>0;
 const validTarget=Number.isSafeInteger(branch)&&branch>0;
 const crossBranch=employee?.permissions?.multi_branch_access===true||
  can(employee?.permissions,'branches')||can(employee?.permissions,'security_manage');
 if(req.apiKey||!employee||!validTarget||(!(assigned&&own===branch)&&!crossBranch)){
  throw Object.assign(new Error('Staff branch assignment or explicit cross-branch authority is required for this invoice'),{
   status:403,code:'BRANCH_FORBIDDEN',
  });
 }
}
module.exports={assertPurchaseInvoiceBranch};
