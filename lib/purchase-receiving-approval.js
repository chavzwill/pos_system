'use strict';
// Call within the same write transaction that commits receipt/stock changes.
// Partial is a continuation of a previously approved order.
async function assertReceivingApproved(executor,poId){
 const {rows:[po]}=await executor.execute({sql:'SELECT status FROM purchase_orders WHERE id=?',args:[poId]});
 if(!po||!['approved','partial'].includes(po.status)){
  const error=new Error(`PO must be approved before receiving; current status is ${po?.status||'missing'}`);
  error.status=409;throw error;
 }
}
module.exports={assertReceivingApproved};
