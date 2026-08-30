'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
async function seedMissing(){
 const {rows}=await db.execute({sql:`SELECT dj.id job_id,dj.job_type,dj.origin_label,dj.destination_label,dsd.source_type,dsd.source_id,dsd.party_name,dsd.address_line,dsd.city,dsd.state,dsd.postal_code,dsd.branch_name,dsd.branch_address,dsd.snapshot_json
 FROM dispatch_jobs dj JOIN dispatch_source_documents dsd ON dsd.dispatch_job_id=dj.id LEFT JOIN dispatch_job_locations jl ON jl.dispatch_job_id=dj.id WHERE jl.id IS NULL`,args:[]});
 let seeded=0;
 for(const row of rows){
  const party={label:row.party_name,address:row.address_line,city:row.city,state:row.state,postal:row.postal_code};
  const branch={label:row.branch_name||'Branch',address:row.branch_address,city:null,state:null,postal:null};
  if(!party.address||!branch.address)continue;
  const pickup=['supplier_pickup','rental_pickup'].includes(row.job_type);
  const origin=pickup?party:branch,destination=pickup?branch:party;
  const tx=await db.transaction('write');
  try{
   const ok=`dispatch_job:${row.job_id}:origin`,dk=`dispatch_job:${row.job_id}:destination`;
   await tx.execute({sql:`INSERT INTO dispatch_locations(location_key,label,address_line,city,state,country,postal_code,geocode_status,source_type,source_id) VALUES(?,?,?,?,?,'Jamaica',?,'unverified',?,?) ON CONFLICT(location_key) DO NOTHING`,args:[ok,origin.label,origin.address,origin.city,origin.state,origin.postal,row.source_type,row.source_id]});
   await tx.execute({sql:`INSERT INTO dispatch_locations(location_key,label,address_line,city,state,country,postal_code,geocode_status,source_type,source_id) VALUES(?,?,?,?,?,'Jamaica',?,'unverified',?,?) ON CONFLICT(location_key) DO NOTHING`,args:[dk,destination.label,destination.address,destination.city,destination.state,destination.postal,row.source_type,row.source_id]});
   const {rows:[ol]}=await tx.execute({sql:'SELECT id FROM dispatch_locations WHERE location_key=?',args:[ok]});
   const {rows:[dl]}=await tx.execute({sql:'SELECT id FROM dispatch_locations WHERE location_key=?',args:[dk]});
   if(ol&&dl){await tx.execute({sql:`INSERT INTO dispatch_job_locations(dispatch_job_id,origin_location_id,destination_location_id,source_snapshot) VALUES(?,?,?,?) ON CONFLICT(dispatch_job_id) DO NOTHING`,args:[row.job_id,ol.id,dl.id,row.snapshot_json||null]});seeded++;}
   await tx.commit();
  }catch(e){await tx.rollback();throw e;}
 }
 return seeded;
}
router.use(async(req,res,next)=>{try{if(req.method==='GET'&&req.path==='/command-center')await seedMissing();next();}catch(e){res.status(500).json({error:'Commercial dispatch location backfill failed',detail:e.message});}});
router.post('/locations/backfill-commercial',async(req,res)=>{try{res.json({seeded:await seedMissing()});}catch(e){res.status(500).json({error:e.message});}});
module.exports=router;
module.exports.seedMissing=seedMissing;