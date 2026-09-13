const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requireAuth,can}=require('../lib/permissions');
router.use(requireAuth);
const norm=v=>String(v||'').trim();
const allowed=(req,keys)=>keys.some(k=>can(req.employee?.permissions||{},k));
const branchId=req=>req.employee?.default_branch_id||null;
async function rows(sql,args=[]){try{return (await db.execute({sql,args})).rows||[];}catch{return[];}}
function task(type,title,detail,priority,action,record_id){return{type,title,detail,priority,action,record_id};}
router.get('/my-day',async(req,res)=>{
 try{
  const branch=branchId(req),tasks=[];
  if(allowed(req,['rentals'])){
   const rs=await rows(`SELECT id,agreement_number,due_date,status FROM rental_agreements WHERE status IN ('active','awaiting_issue','returned') AND (? IS NULL OR branch_id=?) ORDER BY due_date LIMIT 20`,[branch,branch]);
   for(const r of rs){if(r.status==='active'&&r.due_date&&new Date(r.due_date)<new Date())tasks.push(task('rental',`Rental ${r.agreement_number} is overdue`,`Due ${r.due_date}`,'high','Rentals',r.id));else if(r.status==='awaiting_issue')tasks.push(task('rental',`Rental ${r.agreement_number} is ready to issue`,'Customer handover is pending','medium','Rentals',r.id));}
  }
  if(allowed(req,['purchase_requests','purchasing'])){
   const prs=await rows(`SELECT id,pr_number,status,required_date FROM purchase_requests WHERE status IN ('pending','approved') AND (? IS NULL OR branch_id=?) ORDER BY required_date LIMIT 20`,[branch,branch]);
   for(const r of prs)tasks.push(task('purchasing',r.status==='pending'?`Approve purchase request ${r.pr_number}`:`Order approved request ${r.pr_number}`,r.required_date?`Needed ${r.required_date}`:'No required date set',r.status==='pending'?'high':'medium','Purchase Requests',r.id));
   const pos=await rows(`SELECT id,po_number,expected_date FROM purchase_orders WHERE status NOT IN ('received','cancelled') AND expected_date IS NOT NULL AND date(expected_date)<date('now') AND (? IS NULL OR branch_id=?) ORDER BY expected_date LIMIT 20`,[branch,branch]);
   for(const p of pos)tasks.push(task('purchasing',`PO ${p.po_number} is overdue`,`Expected ${p.expected_date}`,'high','Purchase Orders',p.id));
  }
  if(allowed(req,['inventory','warehouse','transfers'])){
   const stock=await rows(`SELECT p.id,p.name,p.sku,bi.stock_qty,COALESCE(bi.min_stock,p.min_stock,0) min_stock FROM branch_inventory bi JOIN products p ON p.id=bi.product_id WHERE p.active=1 AND COALESCE(bi.stock_qty,0)<=COALESCE(bi.min_stock,p.min_stock,0) AND (? IS NULL OR bi.branch_id=?) ORDER BY bi.stock_qty ASC LIMIT 20`,[branch,branch]);
   for(const s of stock)tasks.push(task('inventory',`${s.name||s.sku} needs stock`,`On hand ${s.stock_qty}; minimum ${s.min_stock}`,Number(s.stock_qty)<=0?'high':'medium','Stock Health & Reordering',s.id));
  }
  const rank={high:0,medium:1,low:2};
  tasks.sort((a,b)=>(rank[a.priority]??9)-(rank[b.priority]??9));
  res.json({
   generated_at:new Date().toISOString(),
   employee_id:req.employee?.id,
   branch_id:branch,
   summary:{total:tasks.length,high:tasks.filter(x=>x.priority==='high').length,medium:tasks.filter(x=>x.priority==='medium').length},
   tasks:tasks.slice(0,50)
  });
 }catch(e){res.status(500).json({error:e.message});}
});
module.exports=router;
