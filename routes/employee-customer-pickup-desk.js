'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requireAuth,can}=require('../lib/permissions');
router.use(requireAuth);
const branchId=req=>req.employee?.default_branch_id||null;
const allowed=(req,keys)=>keys.some(k=>can(req.employee?.permissions||{},k));
async function rows(sql,args=[]){return (await db.execute({sql,args})).rows||[];}
function ageMinutes(value){if(!value)return null;const ms=Date.now()-new Date(value).getTime();return Number.isFinite(ms)?Math.max(0,Math.floor(ms/60000)):null;}
function pickup(row,recordType,action,nextAction){
 const ready=row.ready_since||row.created_at||null;
 return{record_type:recordType,record_id:row.id,reference:row.reference,customer_name:row.customer_name||'Customer',phone:row.phone||'',branch_id:row.branch_id,branch_name:row.branch_name||'',ready_since:ready,age_minutes:ageMinutes(ready),action,next_action:nextAction};
}
router.get('/customer-pickups',async(req,res)=>{
 try{
  const branch=branchId(req),items=[];
  if(allowed(req,['work_orders','repairs'])){
   const repairRows=await rows(`SELECT wo.id,wo.wo_number reference,wo.branch_id,wo.notified_at ready_since,wo.created_at,c.first_name||' '||c.last_name customer_name,c.phone,b.name branch_name FROM work_orders wo JOIN customers c ON c.id=wo.customer_id LEFT JOIN branches b ON b.id=wo.branch_id WHERE wo.status='awaiting_pickup' AND (? IS NULL OR wo.branch_id=?) ORDER BY wo.notified_at,wo.id`,[branch,branch]);
   for(const row of repairRows)items.push(pickup(row,'Repair','Work Orders','Open repair to collect any remaining balance and complete pickup'));
  }
  if(allowed(req,['rentals'])){
   const rentalRows=await rows(`SELECT ra.id,ra.agreement_number reference,ra.branch_id,COALESCE(t.created_at,ra.created_at) ready_since,ra.created_at,c.first_name||' '||c.last_name customer_name,c.phone,b.name branch_name FROM rental_agreements ra JOIN customers c ON c.id=ra.customer_id LEFT JOIN branches b ON b.id=ra.branch_id LEFT JOIN transactions t ON t.id=ra.checkout_transaction_id WHERE ra.status='awaiting_issue' AND (? IS NULL OR ra.branch_id=?) ORDER BY ready_since,ra.id`,[branch,branch]);
   for(const row of rentalRows)items.push(pickup(row,'Rental','Rentals','Open rental to complete the customer/security handoff and issue equipment'));
  }
  items.sort((a,b)=>(b.age_minutes||0)-(a.age_minutes||0));
  res.json({generated_at:new Date().toISOString(),branch_id:branch,summary:{total:items.length,repairs:items.filter(x=>x.record_type==='Repair').length,rentals:items.filter(x=>x.record_type==='Rental').length},items});
 }catch(e){res.status(500).json({error:e.message});}
});
module.exports=router;
