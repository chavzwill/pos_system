'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch-board-'));
process.env.TURSO_DATABASE_URL='file:'+path.join(dir,'test.db');
const {db}=require('../database'),express=require('express');let server,base;
const sql=(sql,args=[])=>db.execute({sql,args});
async function api(url,role='dispatch'){const r=await fetch(base+url,{headers:{'X-Test-Role':role}});return{status:r.status,body:await r.json()};}
before(async()=>{
 await db.batch([
 'CREATE TABLE employees(id INTEGER PRIMARY KEY,first_name TEXT,last_name TEXT,active INTEGER,is_driver INTEGER,password TEXT)',
 'CREATE TABLE dispatch_jobs(id INTEGER PRIMARY KEY,job_number TEXT,origin_label TEXT,destination_label TEXT,job_type TEXT,completed_at TEXT,source_type TEXT,source_id INTEGER,assignee_employee_id INTEGER,vehicle_label TEXT,status TEXT)',
 'CREATE TABLE dispatch_executions(dispatch_job_id INTEGER,driver_employee_id INTEGER,stage TEXT)',
 'CREATE TABLE dispatch_proofs(dispatch_job_id INTEGER,proof_type TEXT)',
 "INSERT INTO employees VALUES(1,'Active','Driver',1,1,'never-expose'),(2,'Office','Staff',1,0,'never-expose'),(3,'Inactive','Driver',0,1,'never-expose')",
 "INSERT INTO dispatch_jobs VALUES(1,'OPEN','A','B','delivery',NULL,'test',1,1,'V1','scheduled')",
 "INSERT INTO dispatch_executions VALUES(1,1,'assigned')"
 ],'write');
 for(let i=2;i<=52;i++)await sql("INSERT INTO dispatch_jobs VALUES(?,?,'A','B','delivery','2026-10-24 12:00:00','test',?,1,'V1','completed')",[i,'DSP-'+i,i]);
 await sql("INSERT INTO dispatch_proofs VALUES(52,'delivery')");
 const app=express();app.use((req,res,next)=>{const role=req.get('X-Test-Role');if(role==='dispatch')req.employee={id:1,permissions:{dispatch_view:true}};if(role==='office')req.employee={id:2,permissions:{inventory:true}};if(role==='key')req.apiKey={id:1};next();});app.use('/api/logistics-intelligence',require('../routes/dispatch-board'));server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port;
});
after(async()=>{await new Promise(r=>server.close(r));db.close();});
test('history is bounded, pages without duplicates and marks actual proof evidence',async()=>{
 const a=await api('/api/logistics-intelligence/delivered');assert.equal(a.status,200);assert.equal(a.body.jobs.length,50);assert.equal(a.body.jobs[0].id,52);assert.equal(a.body.jobs[0].delivery_proof_count,1);assert.equal(a.body.jobs[1].delivery_proof_count,0);
 const b=await api('/api/logistics-intelligence/delivered?before='+a.body.next_cursor);assert.deepEqual(b.body.jobs.map(j=>j.id),[2]);assert.equal(b.body.next_cursor,null);assert.equal((await api('/api/logistics-intelligence/delivered?before=NaN')).status,400);
 assert.equal((await sql('SELECT COUNT(*) n FROM dispatch_jobs')).rows[0].n,52);
});
test('driver lookup is limited to eligible names and recorded workload',async()=>{const r=await api('/api/logistics-intelligence/board-resources');assert.equal(r.status,200);assert.deepEqual(r.body.drivers,[{id:1,first_name:'Active',last_name:'Driver',active_jobs:1}]);assert.equal(JSON.stringify(r.body).includes('never-expose'),false);});
test('history and driver lookup require dispatch authority and reject API keys',async()=>{for(const url of ['/delivered','/board-resources']){assert.equal((await api('/api/logistics-intelligence'+url,'none')).status,401);assert.equal((await api('/api/logistics-intelligence'+url,'office')).status,403);assert.equal((await api('/api/logistics-intelligence'+url,'key')).status,403);}});
test('failed-attempt endpoint is governed by execution authority',()=>{
 const {dispatchRequirement,enforceDispatch}=require('../lib/permissions');
 const request=permissions=>({method:'POST',originalUrl:'/api/logistics-intelligence/jobs/1/fail',employee:{id:1,permissions},get:()=>undefined});
 assert.equal(dispatchRequirement(request({})), 'dispatch_execute');
 assert.equal(enforceDispatch(request({dispatch_execute:true}),{}),'allow');
 const response={status(){return this},json(){return this}};assert.equal(enforceDispatch(request({dispatch_view:true}),response),'denied');
});
