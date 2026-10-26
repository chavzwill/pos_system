'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'maintenance-board-'));
const db=require('@libsql/client').createClient({url:'file:'+path.join(dir,'test.db')});require.cache[require.resolve('../database')]={exports:{db}};
const sql=(sql,args=[])=>db.execute({sql,args});let server,base,plan;
async function api(path,body,role='manager',key='maintenance-stable-key',actor=1){const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','x-role':role,'x-actor':String(actor),'Idempotency-Key':key},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:r.status,body:await r.json()};}
async function ok(path,body,key,role='manager'){const r=await api(path,body,role,key);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;}
before(async()=>{
 await db.batch(['CREATE TABLE products(id INTEGER PRIMARY KEY,name TEXT,sku TEXT,stock_qty INTEGER)','CREATE TABLE branches(id INTEGER PRIMARY KEY,name TEXT,active INTEGER)','CREATE TABLE employees(id INTEGER PRIMARY KEY)','CREATE TABLE inventory_serials(id INTEGER PRIMARY KEY,serial_number TEXT)','CREATE TABLE rental_agreements(id INTEGER PRIMARY KEY,status TEXT)','CREATE TABLE rental_agreement_items(id INTEGER PRIMARY KEY,agreement_id INTEGER,quantity REAL,rental_fee REAL)',"INSERT INTO products VALUES(1,'Mixer','MIX',77)","INSERT INTO branches VALUES(1,'Kingston',1),(2,'Ocho Rios',1)",'INSERT INTO employees VALUES(1),(2),(3)',"INSERT INTO rental_agreements VALUES(1,'active')",'INSERT INTO rental_agreement_items VALUES(1,1,1,10)'],'write');
 const old=require('../routes/rental-asset-lifetime-economics');await old.ensureSchema();
 for(const [id,branch,status] of [[1,1,'active'],[2,2,'active'],[3,1,'sold'],[4,1,'retired'],[5,1,'active'],[6,1,'maintenance'],[7,1,'maintenance']])await sql("INSERT INTO rental_assets(id,asset_number,product_id,branch_id,status,acquisition_cost,acquisition_date,acquisition_evidence_ref) VALUES(?,?,1,?,?,2,'1999-01-01','Opening register')",[id,'MIX-'+id,branch,status]);
 await sql('INSERT INTO rental_asset_allocations(asset_id,agreement_id,agreement_item_id) VALUES(5,1,1)');
 await sql("INSERT INTO rental_asset_maintenance(id,asset_id,maintenance_type,started_at,direct_cost,evidence_ref) VALUES(6,6,'Return inspection','2000-01-01',2,'Inspection report'),(8,7,'Service A','2000-01-01',0,NULL),(9,7,'Service B','2000-01-02',0,NULL)");
 const app=require('express')();app.use(require('express').json());app.use((req,res,next)=>{const role=req.headers['x-role'];if(role!=='anonymous')req.employee={id:Number(req.headers['x-actor']||1),default_branch_id:role==='other'?2:role==='unassigned'||role==='global'?null:1,permissions:role==='viewer'?{rentals:true,rentals_manage_items:false,rentals_manage:false}:role==='denied'?{}:{rentals:true,rentals_manage:true,...(role==='global'?{branches:true}:{})}};if(role==='key')req.apiKey={};next();});
 try{app.use('/board',require('../routes/rental-maintenance-board'));}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e;}
 app.use(old.router);server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});base='http://127.0.0.1:'+server.address().port;
});
after(async()=>{if(server)await new Promise(r=>server.close(r));db.close();fs.rmSync(dir,{recursive:true,force:true});});
test('scheduling creates an explicit due document without taking the asset offline or changing costs',async()=>{
 const body={asset_id:1,service_type:'Oil service',due_date:'2000-02-01',priority:'high',reason:'Service due from inspection findings'};
 plan=await ok('/board/plans',body,'schedule-oil-service');assert.ok(plan.id);assert.equal(plan.status,'scheduled');assert.equal((await sql('SELECT status FROM rental_assets WHERE id=1')).rows[0].status,'active');assert.equal(Number((await sql('SELECT COUNT(*) n FROM rental_asset_maintenance WHERE asset_id=1')).rows[0].n),0);
 assert.equal((await ok('/board/plans',body,'schedule-oil-service')).replayed,true);assert.equal((await api('/board/plans',body,'manager','schedule-oil-service',2)).status,409);
});
test('the board combines plans and original unplanned work with complete scoped counts and bounded cursors',async()=>{
 const board=await ok('/board');assert.equal(board.counts.overdue,1);assert.equal(board.counts.in_progress,3);assert.ok(board.rows.some(x=>x.key==='maintenance:6'&&Number(x.recorded_cost_cents)===200));assert.ok(board.rows.every(x=>Number(x.branch_id)===1));assert.ok(board.assets.some(x=>x.asset_number==='MIX-1'));
 const first=await ok('/board?limit=2'),next=await ok('/board?limit=2&after='+encodeURIComponent(first.next_cursor));assert.deepEqual(first.counts,next.counts);assert.equal(new Set([...first.rows,...next.rows].map(x=>x.key)).size,4);assert.equal((await api('/board?after=wrong')).status,400);assert.equal((await api('/board?limit=501')).status,400);
 for(const role of ['other','unassigned','key','denied','anonymous']){const r=await api('/board?branch_id=1',undefined,role);assert.ok([401,403].includes(r.status),role);}
 assert.equal((await api('/board?branch_id=1',undefined,'global')).status,200);
});
test('start is atomic, reuses one original maintenance source and respects rental and lifecycle conflicts',async()=>{
 const pending=await ok('/board/plans',{asset_id:5,service_type:'Safety check',due_date:'2099-01-01',reason:'Inspect safety controls before next hire'},'schedule-rented-asset');
 assert.equal((await api('/board/plans/'+pending.id+'/start',{expected_version:pending.version},'manager','start-rented-asset')).status,409);
 for(const asset_id of [3,4])assert.equal((await api('/board/plans',{asset_id,service_type:'Service',due_date:'2099-01-01',reason:'Inspect service before next use'},'manager','schedule-blocked-'+asset_id)).status,409);
 const outcomes=await Promise.all([api('/board/plans/'+plan.id+'/start',{expected_version:plan.version},'manager','start-oil-race-one'),api('/board/plans/'+plan.id+'/start',{expected_version:plan.version},'manager','start-oil-race-two')]);assert.deepEqual(outcomes.map(x=>x.status).sort(),[200,409]);plan=outcomes.find(x=>x.status===200).body;assert.ok(plan.maintenance_id);assert.equal(plan.status,'in_progress');assert.equal((await sql('SELECT status FROM rental_assets WHERE id=1')).rows[0].status,'maintenance');assert.equal(Number((await sql('SELECT COUNT(*) n FROM rental_asset_maintenance WHERE asset_id=1')).rows[0].n),1);
});
test('completion posts additional cost once under racing submissions and preserves canonical source history',async()=>{
 const path='/board/maintenance/'+plan.maintenance_id+'/complete',body={expected_cost_cents:0,additional_cost_cents:125,evidence_ref:'Service labour invoice',reason:'Oil service completed and safety checked'};
 for(const role of ['viewer','other','unassigned','key','anonymous'])assert.ok([401,403].includes((await api(path,body,role,'complete-denied-'+role)).status),role);
 const results=await Promise.all([api(path,body,'manager','complete-oil-race-one'),api(path,body,'manager','complete-oil-race-two')]);assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);const key=results[0].status===200?'complete-oil-race-one':'complete-oil-race-two';assert.equal((await ok(path,body,key)).replayed,true);
 const m=(await sql('SELECT * FROM rental_asset_maintenance WHERE id=?',[plan.maintenance_id])).rows[0];assert.equal(Number(m.direct_cost),1.25);assert.ok(m.ended_at);assert.equal((await sql('SELECT status FROM rental_assets WHERE id=1')).rows[0].status,'active');assert.equal(Number((await sql('SELECT stock_qty FROM products')).rows[0].stock_qty),77);
 const history=await ok('/board?status=completed');assert.ok(history.rows.some(x=>x.key==='plan:'+plan.id&&x.recorded_cost_cents===125));await assert.rejects(sql('DELETE FROM rental_maintenance_events'),/immutable/);
});
test('legacy completion uses the same cost-once control and never releases an asset with other open work',async()=>{
 const b={additional_cost:.75,evidence_ref:'Inspection repair invoice',reason:'Inspection work complete and unit tested'};
 const results=await Promise.all([api('/assets/6/maintenance/6/complete',b,'manager','legacy-complete-one'),api('/assets/6/maintenance/6/complete',b,'manager','legacy-complete-two')]);assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);assert.equal(Number((await sql('SELECT direct_cost FROM rental_asset_maintenance WHERE id=6')).rows[0].direct_cost),2.75);
 await ok('/board/maintenance/8/complete',{expected_cost_cents:0,additional_cost_cents:0,reason:'First outstanding service complete'},'complete-first-open-work');assert.equal((await sql('SELECT status FROM rental_assets WHERE id=7')).rows[0].status,'maintenance');
 await sql("UPDATE rental_assets SET status='sold' WHERE id=7");assert.equal((await api('/board/maintenance/9/complete',{expected_cost_cents:0,additional_cost_cents:0,reason:'Should not revive sold unit'},'manager','complete-sold-unit')).status,409);
});
test('cancelled plans preserve reasons, stale versions fail and future due dates are never guessed',async()=>{
 const p=await ok('/board/plans',{asset_id:1,service_type:'Annual inspection',due_date:'2099-12-31',reason:'Planned annual safety inspection'},'schedule-annual-check');
 assert.equal((await api('/board/plans/'+p.id+'/cancel',{expected_version:0,reason:'Cancelled by fleet manager'},'manager','cancel-stale-plan')).status,409);
 await ok('/board/plans/'+p.id+'/cancel',{expected_version:p.version,reason:'Cancelled by fleet manager'},'cancel-annual-check');assert.ok((await ok('/board?status=cancelled')).rows.some(x=>x.key==='plan:'+p.id));
 for(const due_date of ['2026-02-30','not-a-date'])assert.equal((await api('/board/plans',{asset_id:1,service_type:'Service',due_date,reason:'Invalid due date should be rejected'},'manager','schedule-invalid-'+due_date)).status,400);
});
test('legacy maintenance cannot revive sold assets or open a second overlapping episode',async()=>{
 const body={maintenance_type:'Service',started_at:'2000-01-01',direct_cost:0,notes:'Controlled maintenance start'};
 assert.equal((await api('/assets/3/maintenance',body,'manager','legacy-sold-start')).status,409);assert.equal((await sql('SELECT status FROM rental_assets WHERE id=3')).rows[0].status,'sold');
 assert.equal((await api('/assets/7/maintenance',body,'manager','legacy-overlap-start')).status,409);
});

test('cost snapshots and current branch authority are checked before any write or replay',async()=>{
 const body={asset_id:1,service_type:'Transfer inspection',due_date:'2099-01-01',reason:'Inspect equipment after branch transfer'};
 const p=await ok('/board/plans',body,'transfer-inspection-plan');
 const start=await ok('/board/plans/'+p.id+'/start',{expected_version:p.version},'transfer-inspection-start');
 const complete='/board/maintenance/'+start.maintenance_id+'/complete';
 for(const additional_cost_cents of [-1,1.25,'125'])assert.equal((await api(complete,{expected_cost_cents:0,additional_cost_cents,reason:'Completed maintenance safely'},'manager','invalid-cost-'+String(additional_cost_cents))).status,400);
 await sql('UPDATE rental_asset_maintenance SET direct_cost=2 WHERE id=?',[start.maintenance_id]);
 assert.equal((await api(complete,{expected_cost_cents:0,additional_cost_cents:0,reason:'Completed maintenance safely'},'manager','stale-cost-snapshot')).status,409);
 await sql('UPDATE rental_assets SET branch_id=2 WHERE id=1');
 assert.equal((await api('/board/plans',body,'manager','transfer-inspection-plan')).status,403);
 assert.equal((await api(complete,{expected_cost_cents:200,additional_cost_cents:0,reason:'Completed maintenance safely'},'manager','transferred-completion')).status,403);
 const scoped=await ok('/board?asset_id=1');assert.equal(scoped.rows.length,0);
 assert.ok((await api('/board?asset_id=1',undefined,'other')).body.rows.every(x=>Number(x.asset_id)===1));
});
