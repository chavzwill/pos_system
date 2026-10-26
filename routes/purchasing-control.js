'use strict';
const router=require('express').Router();
const {db}=require('../database');
const {can}=require('../lib/permissions');
const {buildQuery,SOURCES}=require('../lib/purchasing-control-query');
const categories=['all','deliveries','discrepancies','invoices','returns','credits'];
router.get('/',async(req,res)=>{
 res.set('Cache-Control','private, no-store');
 try{
  if(!req.employee||req.apiKey)return res.status(401).json({error:'A signed-in employee is required'});
  const p=req.employee.permissions,finance=can(p,'reports_financial'),receive=can(p,'purchasing_receive'),approve=can(p,'purchasing_approve');
  if(!can(p,'purchasing')&&!finance)return res.status(403).json({error:'Missing purchasing review permission'});
  const home=Number(req.employee.default_branch_id),branch=req.query.branch_id===undefined?home:Number(req.query.branch_id),limit=Number(req.query.limit||25),category=req.query.category||'all',q=String(req.query.q||'').trim(),after=String(req.query.after||'');
  if(!Number.isSafeInteger(branch)||branch<1||!Number.isSafeInteger(limit)||limit<1||limit>50||!categories.includes(category)||q.length>100||(after&&!/^(delivery|exception|hold|unbilled|capture|invoice|return|credit|consumable-order|consumable-delivery|consumable-receipt|consumable-return|consumable-credit):[1-9]\d*$/.test(after)))return res.status(400).json({error:'Invalid control dashboard filter, branch or page cursor'});
  if(branch!==home&&!can(p,'branches')&&!can(p,'security_manage'))return res.status(403).json({error:'Review is restricted to your assigned branch'});
  const tables=new Set((await db.execute({sql:"SELECT name FROM sqlite_master WHERE type='table'",args:[]})).rows.map(r=>r.name));
  if(!['purchase_orders','purchase_order_items','suppliers'].every(t=>tables.has(t)))return res.status(503).json({error:'Purchasing records are not ready for review'});
  const asOf=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Jamaica',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()),search='%'+q.replace(/[\\%_]/g,c=>'\\'+c)+'%',args=[branch,asOf,q,search,search,search],cte=buildQuery(tables,{finance});
  const summary=(await db.execute({sql:cte+`SELECT COUNT(*) all_count,${categories.slice(1).map(c=>`COALESCE(SUM(category='${c}'),0) ${c}`).join(',')} FROM filtered`,args})).rows[0];
  const result=await db.execute({sql:cte+"SELECT * FROM filtered WHERE (?='all' OR category=?) AND key>? ORDER BY key LIMIT ?",args:[...args,category,category,after,limit+1]});
  const rows=result.rows.slice(0,limit).map(r=>{const row={...r,overdue:!!r.overdue,can_action:r.action==='review_delivery'?can(p,'purchasing'):(r.action==='review_return'||r.action==='review_consumable')?(r.next_role==='Finance'?finance:r.next_role==='Purchasing approver'?approve:receive||finance):receive||finance};if(!finance||row.amount_cents===null)delete row.amount_cents;if(row.credit_id===null)delete row.credit_id;return row;});
  const counts=Object.fromEntries(categories.map(c=>[c,Number(summary[c==='all'?'all_count':c])]));
  const missing=Object.keys(SOURCES).filter(t=>!tables.has(t));
  res.json({rows,counts,total_items:counts[category],next_cursor:result.rows.length>limit?rows.at(-1).key:null,branch_id:branch,as_of:asOf,read_only:true,permissions:{review_delivery:can(p,'purchasing'),match_invoice:receive||finance,review_return:receive||approve||finance,review_consumable:receive||approve||finance,approve_return:approve,finance},coverage:{partial:missing.length>0,missing_sources:missing}});
 }catch(error){res.status(503).json({error:'Unable to load purchasing control. Retry before assuming the dashboard is clear.'});}
});
module.exports=router;
