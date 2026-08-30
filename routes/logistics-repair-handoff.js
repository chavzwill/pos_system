'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requireAnyPermission}=require('../lib/permissions');

function actor(req){return req.employee?.id||req.user?.employee_id||null;}
function fullAddress(x,prefix=''){const g=k=>String(x[`${prefix}${k}`]||'').trim();return [g('address'),g('city'),g('state'),g('zip')].filter(Boolean).join(', ');}
function jobNumber(){return `DSP-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2,6).toUpperCase()}`;}
async function prior(workOrderId,jobType){const {rows:[r]}=await db.execute({sql:`SELECT dj.* FROM dispatch_jobs dj WHERE dj.source_type='repair' AND dj.source_id=? AND dj.job_type=? AND dj.status NOT IN ('completed','cancelled') ORDER BY dj.id DESC LIMIT 1`,args:[workOrderId,jobType]});return r||null;}

router.post('/from-repair/:id',requireAnyPermission('work_orders','transfers'),async(req,res)=>{
 try{
  const direction=String(req.body?.direction||'pickup').toLowerCase();
  if(!['pickup','return'].includes(direction))return res.status(400).json({error:'direction must be pickup or return'});
  const {rows:[wo]}=await db.execute({sql:`SELECT wo.*,c.first_name||' '||c.last_name customer_name,c.phone customer_phone,c.email customer_email,c.address,c.city,c.state,c.zip,b.name branch_name,b.address branch_address,b.city branch_city,b.state branch_state,b.zip branch_zip,rel.equipment_id,ce.equipment_type,ce.brand equipment_brand,ce.model equipment_model,ce.serial_number equipment_serial,ce.asset_tag equipment_asset_tag FROM work_orders wo JOIN customers c ON c.id=wo.customer_id JOIN branches b ON b.id=wo.branch_id LEFT JOIN repair_equipment_links rel ON rel.work_order_id=wo.id LEFT JOIN customer_equipment ce ON ce.id=rel.equipment_id WHERE wo.id=?`,args:[req.params.id]});
  if(!wo)return res.status(404).json({error:'Repair work order not found'});
  if(String(wo.status)==='cancelled')return res.status(409).json({error:'Cancelled repairs cannot be forwarded to Dispatch'});
  if(direction==='return'&&!['awaiting_pickup','complete'].includes(String(wo.status)))return res.status(409).json({error:'Repair return delivery is only available after repair completion/signoff'});
  if(direction==='pickup'&&['awaiting_pickup','picked_up'].includes(String(wo.status)))return res.status(409).json({error:'This repair is already at the customer-return stage and cannot create a new intake pickup'});
  const customerAddress=fullAddress(wo),branchAddress=fullAddress(wo,'branch_');
  if(!customerAddress)return res.status(409).json({error:'Repair logistics requires a usable customer address'});
  if(!branchAddress)return res.status(409).json({error:'Repair branch requires a usable address before dispatch'});
  const jobType=direction==='pickup'?'repair_pickup':'repair_return';
  const existing=await prior(Number(wo.id),jobType);if(existing)return res.status(200).json(existing);
  const origin=direction==='pickup'?customerAddress:branchAddress,destination=direction==='pickup'?branchAddress:customerAddress;
  const snapshot={work_order:{id:wo.id,wo_number:wo.wo_number,status:wo.status,pickup_due_date:wo.pickup_due_date,description:wo.description,customer_complaint:wo.customer_complaint},customer:{id:wo.customer_id,name:wo.customer_name,phone:wo.customer_phone,email:wo.customer_email,address:customerAddress},branch:{id:wo.branch_id,name:wo.branch_name,address:branchAddress},equipment:wo.equipment_id?{id:wo.equipment_id,type:wo.equipment_type,brand:wo.equipment_brand,model:wo.equipment_model,serial_number:wo.equipment_serial,asset_tag:wo.equipment_asset_tag}:null};
  const tx=await db.transaction('write');let committed=false;
  try{
   const number=jobNumber();
   const r=await tx.execute({sql:`INSERT INTO dispatch_jobs(job_number,source_type,source_id,branch_id,origin_label,destination_label,job_type,priority,status,promised_at,notes,created_by_employee_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,args:[number,'repair',Number(wo.id),Number(wo.branch_id),origin,destination,jobType,req.body?.priority||'normal','unassigned',direction==='pickup'?wo.pickup_due_date:null,`${direction==='pickup'?'Repair customer pickup':'Completed repair return'} for ${wo.wo_number}`,actor(req)]});
   const jobId=Number(r.lastInsertRowid);
   await tx.execute({sql:`INSERT INTO dispatch_source_documents(dispatch_job_id,source_type,source_id,document_kind,document_number,party_type,party_id,party_name,contact_phone,contact_email,address_line,city,state,postal_code,branch_id,branch_name,branch_address,snapshot_json,created_by_employee_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:[jobId,'repair',Number(wo.id),'repair_work_order',wo.wo_number,'customer',wo.customer_id,wo.customer_name,wo.customer_phone||null,wo.customer_email||null,wo.address||customerAddress,wo.city||null,wo.state||null,wo.zip||null,wo.branch_id,wo.branch_name,branchAddress,JSON.stringify(snapshot),actor(req)]});
   await tx.execute({sql:`INSERT INTO dispatch_events(dispatch_job_id,event_type,new_status,details,actor_employee_id) VALUES(?,?,?,?,?)`,args:[jobId,'repair_logistics_handoff','unassigned',`${wo.wo_number} forwarded for ${direction==='pickup'?'customer pickup':'return delivery'}`,actor(req)]});
   await tx.execute({sql:`INSERT INTO repair_timeline_events(work_order_id,event_type,visibility,title,details,actor_employee_id,source_entity_type,source_entity_id) VALUES(?,?,?,?,?,?,?,?)`,args:[wo.id,'logistics_handoff','internal',direction==='pickup'?'Repair pickup sent to Dispatch':'Repair return sent to Dispatch',`Dispatch job ${number}`,actor(req),'dispatch_job',String(jobId)]});
   await tx.commit();committed=true;
   const {rows:[row]}=await db.execute({sql:'SELECT * FROM dispatch_jobs WHERE id=?',args:[jobId]});
   res.status(201).json(row);
  }catch(e){if(!committed)await tx.rollback();throw e;}
 }catch(e){res.status(400).json({error:e.message});}
});

module.exports=router;