'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requireAuth,can}=require('../lib/permissions');
router.use(requireAuth);
const STAGES=['ready_to_pick','picked','verified','packed','staged'];
const next={ready_to_pick:'picked',picked:'verified',verified:'packed',packed:'staged'};
function allowed(req){const p=req.employee?.permissions||{};return ['warehouse','shipping','transactions'].some(k=>can(p,k));}
function branchId(req){return req.employee?.default_branch_id||null;}
async function ensureSchema(){
 await db.execute({sql:`CREATE TABLE IF NOT EXISTS warehouse_fulfillment_progress (
  shipment_id INTEGER PRIMARY KEY,
  stage TEXT NOT NULL DEFAULT 'ready_to_pick',
  updated_by INTEGER,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 )`,args:[]});
 await db.execute({sql:`CREATE TABLE IF NOT EXISTS warehouse_fulfillment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_id INTEGER NOT NULL,
  stage TEXT NOT NULL,
  employee_id INTEGER NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 )`,args:[]});
}
router.use(async(req,res,nextFn)=>{try{if(!allowed(req))return res.status(403).json({error:'Warehouse or shipping access is required'});await ensureSchema();nextFn();}catch(e){res.status(500).json({error:e.message});}});
async function shipment(id,branch){const {rows:[s]}=await db.execute({sql:`SELECT s.*,c.first_name||' '||c.last_name customer_name FROM shipments s LEFT JOIN customers c ON c.id=s.customer_id WHERE s.id=? AND (? IS NULL OR s.from_branch_id=?)`,args:[id,branch,branch]});return s;}
router.get('/warehouse-flow/shipments/:id',async(req,res)=>{
 try{
  const branch=branchId(req),s=await shipment(req.params.id,branch);if(!s)return res.status(404).json({error:'Shipment not found for your branch'});
  const {rows:items}=await db.execute({sql:`SELECT si.id,si.product_id,si.product_name,si.sku,si.quantity,si.bin_id,
   COALESCE(sb.bin_code,(SELECT sb2.bin_code FROM product_bin_assignments pba2 JOIN storage_bins sb2 ON sb2.id=pba2.bin_id WHERE pba2.product_id=si.product_id AND pba2.branch_id=s.from_branch_id ORDER BY pba2.is_primary DESC,pba2.quantity DESC LIMIT 1)) suggested_bin,
   COALESCE((SELECT SUM(pba.quantity) FROM product_bin_assignments pba WHERE pba.product_id=si.product_id AND pba.branch_id=s.from_branch_id),0) located_qty
   FROM shipment_items si JOIN shipments s ON s.id=si.shipment_id LEFT JOIN storage_bins sb ON sb.id=si.bin_id WHERE si.shipment_id=? ORDER BY si.id`,args:[s.id]});
  const {rows:[p]}=await db.execute({sql:'SELECT * FROM warehouse_fulfillment_progress WHERE shipment_id=?',args:[s.id]});
  const {rows:events}=await db.execute({sql:`SELECT wfe.*,e.first_name||' '||e.last_name employee_name FROM warehouse_fulfillment_events wfe LEFT JOIN employees e ON e.id=wfe.employee_id WHERE wfe.shipment_id=? ORDER BY wfe.created_at DESC,wfe.id DESC LIMIT 20`,args:[s.id]});
  const stage=p?.stage||'ready_to_pick';
  res.json({shipment:s,stage,next_stage:next[stage]||null,can_ship:stage==='staged'&&s.status==='draft',items,events});
 }catch(e){res.status(500).json({error:e.message});}
});
router.post('/warehouse-flow/shipments/:id/advance',async(req,res)=>{
 try{
  const branch=branchId(req),s=await shipment(req.params.id,branch);if(!s)return res.status(404).json({error:'Shipment not found for your branch'});
  if(s.status!=='draft')return res.status(409).json({error:'Only draft shipments can move through warehouse preparation'});
  const {rows:[p]}=await db.execute({sql:'SELECT * FROM warehouse_fulfillment_progress WHERE shipment_id=?',args:[s.id]});
  const current=p?.stage||'ready_to_pick',requested=String(req.body?.stage||'').trim();
  if(!STAGES.includes(requested))return res.status(400).json({error:'Invalid warehouse stage'});
  if(next[current]!==requested)return res.status(409).json({error:`Complete ${current.replaceAll('_',' ')} before ${requested.replaceAll('_',' ')}`});
  if(requested==='picked'){
   const {rows:shortages}=await db.execute({sql:`SELECT si.product_name,si.quantity,COALESCE((SELECT SUM(pba.quantity) FROM product_bin_assignments pba WHERE pba.product_id=si.product_id AND pba.branch_id=s.from_branch_id),0) located_qty FROM shipment_items si WHERE si.shipment_id=?`,args:[s.id]});
   const bad=shortages.filter(x=>Number(x.located_qty)<Number(x.quantity));
   if(bad.length)return res.status(409).json({error:'One or more shipment items do not have enough located stock to complete picking',shortages:bad});
  }
  const tx=await db.transaction('write');
  try{
   await tx.execute({sql:`INSERT INTO warehouse_fulfillment_progress(shipment_id,stage,updated_by,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(shipment_id) DO UPDATE SET stage=excluded.stage,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`,args:[s.id,requested,req.employee.id]});
   await tx.execute({sql:'INSERT INTO warehouse_fulfillment_events(shipment_id,stage,employee_id,note) VALUES(?,?,?,?)',args:[s.id,requested,req.employee.id,String(req.body?.note||'').trim()||null]});
   await tx.commit();
  }catch(e){await tx.rollback();throw e;}
  res.json({shipment_id:s.id,stage:requested,next_stage:next[requested]||null,can_ship:requested==='staged'});
 }catch(e){res.status(e.status||500).json({error:e.message,shortages:e.shortages});}
});
module.exports=router;
