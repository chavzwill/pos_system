'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {can}=require('../lib/permissions');

const num=v=>Number(v);
const moneyFields=['cash_counted','card_counted','check_counted','gift_card_counted','credit_counted','direct_deposit_counted'];
function employee(req){return req.employee||null;}
function manager(req){return !!employee(req)&&can(employee(req).permissions,'drawers_manage');}
function requireEmployeeSession(req,res){
  if(req.apiKey){res.status(403).json({error:'Cash drawer sessions require an authenticated employee session'});return null;}
  const emp=employee(req);if(!emp){res.status(401).json({error:'Authentication required'});return null;}return emp;
}
async function accessFor(drawerId,employeeId){
  const {rows}=await db.execute({sql:'SELECT * FROM drawer_employee_access WHERE drawer_id=?',args:[drawerId]});
  if(!rows.length)return {restricted:false,row:null};
  return {restricted:true,row:rows.find(r=>String(r.employee_id)===String(employeeId))||null};
}
async function session(id){const {rows:[row]}=await db.execute({sql:'SELECT * FROM drawer_sessions WHERE id=?',args:[id]});return row;}

router.post('/sessions',async(req,res,next)=>{
  try{
    const emp=requireEmployeeSession(req,res);if(!emp)return;
    if(!can(emp.permissions,'drawers_open')&&!manager(req))return res.status(403).json({error:'Missing permission: drawers_open'});
    const drawerId=Number(req.body?.drawer_id);if(!drawerId)return res.status(400).json({error:'A cash drawer is required'});
    const {rows:[drawer]}=await db.execute({sql:'SELECT * FROM cash_drawers WHERE id=? AND active=1',args:[drawerId]});
    if(!drawer)return res.status(404).json({error:'Cash drawer not found or inactive'});
    if(emp.default_branch_id&&String(drawer.branch_id)!==String(emp.default_branch_id)&&!manager(req))return res.status(403).json({error:'This drawer belongs to another branch'});
    const access=await accessFor(drawerId,emp.id);
    if(access.restricted&&(!access.row||!access.row.can_use)&&!manager(req))return res.status(403).json({error:'You are not assigned to this cash drawer'});
    const opening=num(req.body?.opening_float||0);if(!Number.isFinite(opening)||opening<0)return res.status(400).json({error:'Opening float must be zero or greater'});
    const {rows:[drawerOpen]}=await db.execute({sql:"SELECT ds.*,e.first_name||' '||e.last_name employee_name FROM drawer_sessions ds LEFT JOIN employees e ON e.id=ds.employee_id WHERE ds.drawer_id=? AND ds.status='open'",args:[drawerId]});
    if(drawerOpen&&String(drawerOpen.employee_id)!==String(emp.id))return res.status(409).json({error:`${drawer.name} is already open by ${drawerOpen.employee_name||'another employee'}`});
    req.body.employee_id=emp.id;req.body.branch_id=drawer.branch_id;req.body.opening_float=opening;
    next();
  }catch(e){res.status(500).json({error:e.message});}
});

router.patch('/sessions/:id/close',async(req,res,next)=>{
  try{
    const emp=requireEmployeeSession(req,res);if(!emp)return;
    const s=await session(req.params.id);if(!s)return res.status(404).json({error:'Drawer session not found'});
    if(s.status!=='open')return res.status(409).json({error:`Drawer session is already ${s.status}`});
    if(String(s.employee_id)!==String(emp.id)&&!manager(req))return res.status(403).json({error:'Only the cashier who opened this drawer or a drawer manager can close it'});
    if(!can(emp.permissions,'drawers_close')&&!manager(req))return res.status(403).json({error:'Missing permission: drawers_close'});
    next();
  }catch(e){res.status(500).json({error:e.message});}
});

router.post('/sessions/:id/reconcile',async(req,res,next)=>{
  try{
    const emp=requireEmployeeSession(req,res);if(!emp)return;
    const s=await session(req.params.id);if(!s)return res.status(404).json({error:'Drawer session not found'});
    if(s.status==='reconciled')return res.status(409).json({error:'Drawer session has already been reconciled'});
    if(String(s.employee_id)!==String(emp.id)&&!manager(req))return res.status(403).json({error:'Only the owning cashier or a drawer manager can reconcile this session'});
    const access=await accessFor(s.drawer_id,emp.id);
    if(access.restricted&&!manager(req)&&(!access.row||!access.row.can_reconcile))return res.status(403).json({error:'You are not authorized to reconcile this drawer'});
    for(const field of moneyFields){const value=num(req.body?.[field]||0);if(!Number.isFinite(value)||value<0)return res.status(400).json({error:`${field} must be zero or greater`});req.body[field]=value;}
    if(Array.isArray(req.body?.note_counts))for(const row of req.body.note_counts){const q=num(row?.quantity);if(!Number.isInteger(q)||q<0)return res.status(400).json({error:'Denomination quantities must be non-negative whole numbers'});}
    req.body.reconciled_by=emp.id;
    next();
  }catch(e){res.status(500).json({error:e.message});}
});

module.exports=router;
