'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
let ready=null;
async function ensure(){if(ready)return ready;ready=db.batch([
 {sql:`CREATE TABLE IF NOT EXISTS dispatch_vehicles(id INTEGER PRIMARY KEY AUTOINCREMENT,vehicle_number TEXT NOT NULL UNIQUE,registration_number TEXT,description TEXT NOT NULL,vehicle_type TEXT,capacity_kg REAL,capacity_volume_m3 REAL,status TEXT NOT NULL DEFAULT 'available',current_branch_id INTEGER REFERENCES branches(id),notes TEXT,active INTEGER NOT NULL DEFAULT 1,created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`},
 {sql:`CREATE TABLE IF NOT EXISTS dispatch_executions(id INTEGER PRIMARY KEY AUTOINCREMENT,dispatch_job_id INTEGER NOT NULL UNIQUE REFERENCES dispatch_jobs(id),driver_employee_id INTEGER REFERENCES employees(id),vehicle_id INTEGER REFERENCES dispatch_vehicles(id),stage TEXT NOT NULL DEFAULT 'assigned',assigned_at DATETIME,departed_for_origin_at DATETIME,arrived_origin_at DATETIME,picked_up_at DATETIME,arrived_destination_at DATETIME,completed_at DATETIME,failed_at DATETIME,failure_reason TEXT,rescheduled_for DATETIME,last_notes TEXT,created_by_employee_id INTEGER REFERENCES employees(id),updated_by_employee_id INTEGER REFERENCES employees(id),created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`},
 {sql:`CREATE TABLE IF NOT EXISTS dispatch_custody_events(id INTEGER PRIMARY KEY AUTOINCREMENT,dispatch_job_id INTEGER NOT NULL REFERENCES dispatch_jobs(id),execution_id INTEGER REFERENCES dispatch_executions(id),event_type TEXT NOT NULL,from_party TEXT,to_party TEXT,recipient_name TEXT,evidence_reference TEXT,notes TEXT,actor_employee_id INTEGER REFERENCES employees(id),created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`},
 {sql:`CREATE TABLE IF NOT EXISTS dispatch_proofs(id INTEGER PRIMARY KEY AUTOINCREMENT,dispatch_job_id INTEGER NOT NULL REFERENCES dispatch_jobs(id),execution_id INTEGER REFERENCES dispatch_executions(id),proof_type TEXT NOT NULL,recipient_name TEXT,signature_name TEXT,photo_url TEXT,evidence_reference TEXT,notes TEXT,latitude REAL,longitude REAL,captured_by_employee_id INTEGER REFERENCES employees(id),captured_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`},
 {sql:'CREATE INDEX IF NOT EXISTS idx_dispatch_execution_stage ON dispatch_executions(stage,updated_at)'}
],'write').catch(e=>{ready=null;throw e;});return ready;}
router.use(async(req,res,next)=>{try{await ensure();next();}catch(e){res.status(500).json({error:'Dispatch command center dependencies unavailable',detail:e.message});}});
module.exports=router;
