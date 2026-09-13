'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requireAuth}=require('../lib/permissions');
router.use(requireAuth);
const norm=v=>String(v||'').trim();
const branchId=req=>req.employee?.default_branch_id||null;
async function rows(sql,args=[]){try{return (await db.execute({sql,args})).rows||[];}catch{return[];}}
async function snapshot(req){
  const employeeId=req.employee.id,branch=branchId(req);
  const openDrawers=await rows(`SELECT ds.id,ds.drawer_id,cd.name drawer_name,ds.opened_at FROM drawer_sessions ds LEFT JOIN cash_drawers cd ON cd.id=ds.drawer_id WHERE ds.employee_id=? AND ds.status='open'`,[employeeId]);
  const followups=await rows(`SELECT id,subject,due_date FROM crm_activities WHERE employee_id=? AND completed=0 AND type='follow_up' ORDER BY due_date LIMIT 30`,[employeeId]);
  const dispatch=await rows(`SELECT id,job_number,status,promised_at FROM dispatch_jobs WHERE assignee_employee_id=? AND status NOT IN ('completed','cancelled') AND (? IS NULL OR branch_id=?) ORDER BY promised_at LIMIT 30`,[employeeId,branch,branch]);
  const handovers=await rows(`SELECT id,title,status,priority FROM shift_handovers WHERE created_by=? AND status!='resolved' AND (? IS NULL OR branch_id=?) ORDER BY created_at DESC LIMIT 30`,[employeeId,branch,branch]);
  const items=[];
  for(const d of openDrawers)items.push({type:'drawer',severity:'blocking',title:`Close ${d.drawer_name||'cash drawer'} before signing out`,detail:'Cash custody is still open',record_id:d.id,action:'Cash Drawer & End-of-Shift Count'});
  for(const f of followups)items.push({type:'followup',severity:'handover',title:f.subject,detail:f.due_date?`Due ${f.due_date}`:'No due date',record_id:f.id,action:'Follow-ups'});
  for(const j of dispatch)items.push({type:'dispatch',severity:'handover',title:`Dispatch ${j.job_number||j.id} is unfinished`,detail:j.promised_at?`${j.status} · promised ${j.promised_at}`:j.status,record_id:j.id,action:'Dispatch & Deliveries'});
  for(const h of handovers)items.push({type:'handover',severity:'review',title:h.title,detail:`Existing ${h.priority||'normal'} handover · ${h.status}`,record_id:h.id,action:'Handover'});
  return{employee_id:employeeId,branch_id:branch,generated_at:new Date().toISOString(),ready_to_sign_out:openDrawers.length===0,summary:{open_drawers:openDrawers.length,open_followups:followups.length,unfinished_dispatch:dispatch.length,open_handovers:handovers.length,total:items.length},items};
}
router.get('/end-shift',async(req,res)=>{try{res.json(await snapshot(req));}catch(e){res.status(500).json({error:e.message});}});
router.post('/end-shift/handover',async(req,res)=>{
 try{
  const snap=await snapshot(req),note=norm(req.body?.note);
  if(!snap.items.length&&!note)return res.status(400).json({error:'There is no unfinished work to hand over'});
  const lines=snap.items.filter(x=>x.type!=='handover').slice(0,20).map(x=>`- ${x.title}${x.detail?' — '+x.detail:''}`);
  const body=[note?`Employee note: ${note}`:null,lines.length?'Unfinished work:':null,...lines].filter(Boolean).join('\n');
  const priority=snap.summary.open_drawers>0?'urgent':(snap.summary.unfinished_dispatch>0?'important':'normal');
  const title=`End-of-shift handover — ${req.employee.first_name||'Employee'}`;
  const r=await db.execute({sql:`INSERT INTO shift_handovers(branch_id,workspace,priority,title,note,record_type,record_id,created_by) VALUES(?,?,?,?,?,?,?,?) RETURNING id`,args:[snap.branch_id,'my-day',priority,title,body,'end_shift',null,req.employee.id]});
  res.status(201).json({id:r.rows?.[0]?.id,ready_to_sign_out:snap.ready_to_sign_out,summary:snap.summary});
 }catch(e){res.status(500).json({error:e.message});}
});
module.exports=router;
