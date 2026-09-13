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

router.get('/search',async(req,res)=>{
 try{const q=norm(req.query.q);if(q.length<2)return res.json({query:q,results:[]});const like=`%${q}%`,branch=branchId(req),out=[];
 const add=(type,action,rs,map)=>rs.forEach(r=>out.push({type,action,...map(r)}));
 if(allowed(req,['customers','pos','transactions','rentals','work_orders']))add('Customer','Customers',await rows(`SELECT id,first_name,last_name,phone,email FROM customers WHERE active=1 AND (first_name||' '||last_name LIKE ? OR phone LIKE ? OR email LIKE ?) LIMIT 8`,[like,like,like]),r=>({id:r.id,title:`${r.first_name||''} ${r.last_name||''}`.trim(),detail:r.phone||r.email||''}));
 if(allowed(req,['inventory','warehouse','pos','purchasing']))add('Item','Inventory',await rows(`SELECT id,name,sku,barcode FROM products WHERE active=1 AND (name LIKE ? OR sku LIKE ? OR barcode LIKE ?) LIMIT 8`,[like,like,like]),r=>({id:r.id,title:r.name||r.sku,detail:r.sku||r.barcode||''}));
 if(allowed(req,['transactions','pos']))add('Sale','Transactions',await rows(`SELECT id,transaction_number,total,status FROM transactions WHERE transaction_number LIKE ? AND (? IS NULL OR branch_id=?) ORDER BY created_at DESC LIMIT 8`,[like,branch,branch]),r=>({id:r.id,title:r.transaction_number,detail:`${r.status} · JMD ${Number(r.total||0).toFixed(2)}`}));
 if(allowed(req,['work_orders','repairs']))add('Repair','Work Orders',await rows(`SELECT id,wo_number,status FROM work_orders WHERE wo_number LIKE ? AND (? IS NULL OR branch_id=?) ORDER BY created_at DESC LIMIT 8`,[like,branch,branch]),r=>({id:r.id,title:r.wo_number,detail:r.status}));
 if(allowed(req,['rentals']))add('Rental','Rentals',await rows(`SELECT id,agreement_number,status FROM rental_agreements WHERE agreement_number LIKE ? AND (? IS NULL OR branch_id=?) ORDER BY created_at DESC LIMIT 8`,[like,branch,branch]),r=>({id:r.id,title:r.agreement_number,detail:r.status}));
 if(allowed(req,['purchasing','purchase_orders']))add('Purchase order','Purchase Orders',await rows(`SELECT id,po_number,status FROM purchase_orders WHERE po_number LIKE ? AND (? IS NULL OR branch_id=?) ORDER BY created_at DESC LIMIT 8`,[like,branch,branch]),r=>({id:r.id,title:r.po_number,detail:r.status}));
 res.json({query:q,results:out.slice(0,30)});}catch(e){res.status(500).json({error:e.message});}
});
router.get('/handovers',async(req,res)=>{try{const b=branchId(req);const r=await rows(`SELECT h.*,e.first_name||' '||e.last_name created_by_name,a.first_name||' '||a.last_name acknowledged_by_name FROM shift_handovers h LEFT JOIN employees e ON e.id=h.created_by LEFT JOIN employees a ON a.id=h.acknowledged_by WHERE h.status!='resolved' AND (? IS NULL OR h.branch_id=?) ORDER BY CASE h.priority WHEN 'urgent' THEN 0 WHEN 'important' THEN 1 ELSE 2 END,h.created_at DESC LIMIT 50`,[b,b]);res.json({rows:r});}catch(e){res.status(500).json({error:e.message});}});
router.post('/handovers',async(req,res)=>{try{const title=norm(req.body?.title),note=norm(req.body?.note),workspace=norm(req.body?.workspace||'general'),priority=['normal','important','urgent'].includes(req.body?.priority)?req.body.priority:'normal';if(title.length<3||note.length<3)return res.status(400).json({error:'Title and handover note are required'});const r=await db.execute({sql:`INSERT INTO shift_handovers(branch_id,workspace,priority,title,note,record_type,record_id,created_by) VALUES(?,?,?,?,?,?,?,?) RETURNING id`,args:[branchId(req),workspace,priority,title,note,norm(req.body?.record_type)||null,req.body?.record_id||null,req.employee.id]});res.status(201).json({id:r.rows?.[0]?.id});}catch(e){res.status(500).json({error:e.message});}});
router.post('/handovers/:id/acknowledge',async(req,res)=>{try{const b=branchId(req);const r=await db.execute({sql:`UPDATE shift_handovers SET status='acknowledged',acknowledged_by=?,acknowledged_at=CURRENT_TIMESTAMP WHERE id=? AND status='open' AND (? IS NULL OR branch_id=?)`,args:[req.employee.id,Number(req.params.id),b,b]});res.json({updated:Number(r.rowsAffected||0)});}catch(e){res.status(500).json({error:e.message});}});
router.post('/handovers/:id/resolve',async(req,res)=>{try{const b=branchId(req);const r=await db.execute({sql:`UPDATE shift_handovers SET status='resolved',resolved_at=CURRENT_TIMESTAMP,acknowledged_by=COALESCE(acknowledged_by,?),acknowledged_at=COALESCE(acknowledged_at,CURRENT_TIMESTAMP) WHERE id=? AND status!='resolved' AND (? IS NULL OR branch_id=?)`,args:[req.employee.id,Number(req.params.id),b,b]});res.json({updated:Number(r.rowsAffected||0)});}catch(e){res.status(500).json({error:e.message});}});

module.exports=router;
