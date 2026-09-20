'use strict';
const {db}=require('../database');
function fault(code,message,status=400){const e=new Error(message);e.code=code;e.status=status;return e;}
async function assessmentServiceSnapshot(productId,executor=db){
  const id=Number(productId);
  if(!Number.isInteger(id)||id<=0)throw fault('WORK_ORDER_ASSESSMENT_SERVICE_REQUIRED','Choose the assessment service that matches this repair.',400);
  const {rows:[p]}=await executor.execute({sql:'SELECT id,name,price,tax_rate,active,is_service FROM products WHERE id=?',args:[id]});
  if(!p||Number(p.active)===0||Number(p.is_service)!==1)throw fault('WORK_ORDER_ASSESSMENT_SERVICE_UNAVAILABLE','That assessment service is no longer available. Choose an active service.',409);
  return{product_id:id,name:String(p.name||'Assessment Service'),subtotal:Math.max(0,Number(p.price)||0),tax_rate:Math.max(0,Number(p.tax_rate)||0)};
}
function assessmentAmounts(workOrder={}){
  const subtotal=Math.max(0,Number(workOrder.assessment_fee)||0);
  const taxRate=Math.max(0,Number(workOrder.assessment_fee_tax_rate)||0);
  const tax=Number((subtotal*taxRate/100).toFixed(2));
  return{subtotal,tax_rate:taxRate,tax,total:Number((subtotal+tax).toFixed(2))};
}
module.exports={assessmentServiceSnapshot,assessmentAmounts};
