'use strict';
const router=require('express').Router(),{db}=require('../database'),{can}=require('../lib/permissions'),{buildQuery}=require('../lib/purchasing-exception-query');
const filters={all:'1=1',overdue:'overdue_lines>0',unbilled:'unbilled_lines>0',unmatched:'unmatched_invoices>0',variance:'invoice_variances>0'};
router.get('/',async(req,res)=>{res.set('Cache-Control','private, no-store');try{
 if(!req.employee||req.apiKey)return res.status(401).json({error:'A signed-in employee is required'});
 const permissions=req.employee.permissions,financial=can(permissions,'purchasing_receive')||can(permissions,'reports_financial');
 if(!can(permissions,'purchasing')&&!financial)return res.status(403).json({error:'Missing purchasing review permission'});
 const home=Number(req.employee.default_branch_id),branch=req.query.branch_id===undefined?home:Number(req.query.branch_id),after=Number(req.query.after||0),limit=Number(req.query.limit||25),category=req.query.category||'all',q=String(req.query.q||'').trim();
 if(!Number.isSafeInteger(branch)||branch<1||!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>50||!Object.hasOwn(filters,category)||q.length>100)return res.status(400).json({error:'Invalid queue filter, branch or page cursor'});
 if(branch!==home&&!can(permissions,'branches')&&!can(permissions,'security_manage'))return res.status(403).json({error:'Review is restricted to your assigned branch'});
 if(!financial&&['unmatched','variance'].includes(category))return res.status(403).json({error:'Invoice review requires receiving or Finance permission'});
 const tables=new Set((await db.execute({sql:"SELECT name FROM sqlite_master WHERE type='table'",args:[]})).rows.map(x=>x.name));
 if(!['purchase_orders','purchase_order_items','suppliers'].every(x=>tables.has(x)))return res.status(503).json({error:'Purchasing records are not ready for review'});
 const asOf=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Jamaica',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()),search='%'+q.replace(/[\\%_]/g,x=>'\\'+x)+'%',args=[branch,asOf,q,search,search],cte=buildQuery(tables,financial);
 const summary=(await db.execute({sql:cte+`SELECT COUNT(*) all_orders,COALESCE(SUM(overdue_lines>0),0) overdue,COALESCE(SUM(unbilled_lines>0),0) unbilled,COALESCE(SUM(unmatched_invoices>0),0) unmatched,COALESCE(SUM(invoice_variances>0),0) variance,COALESCE(SUM(${filters[category]}),0) filtered_orders FROM attention`,args})).rows[0];
 const {rows}=await db.execute({sql:cte+`SELECT * FROM attention WHERE ${filters[category]} AND po_id>? ORDER BY po_id LIMIT ?`,args:[...args,after,limit+1]});const page=rows.slice(0,limit);
 res.json({rows:page,next_cursor:rows.length>limit?Number(page.at(-1).po_id):null,total_orders:Number(summary.filtered_orders),counts:Object.fromEntries(['all_orders','overdue','unbilled','unmatched','variance'].map(k=>[k,Number(summary[k])])),branch_id:branch,as_of:asOf,can_review_invoices:financial,can_review_deliveries:can(permissions,'purchasing'),read_only:true,coverage:{receipts:tables.has('purchase_receipts')&&tables.has('purchase_receipt_items'),posted_invoices:tables.has('supplier_invoices'),captured_invoices:tables.has('captured_supplier_invoices')}});
 }catch(error){res.status(503).json({error:'Unable to load purchasing exceptions. Retry before assuming the queue is clear.'});}});
module.exports=router;
