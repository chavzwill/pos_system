'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rental-costs-'));
const db=require('@libsql/client').createClient({url:'file:'+path.join(dir,'test.db')});
require.cache[require.resolve('../database')]={exports:{db}};
const sql=(sql,args=[])=>db.execute({sql,args});let server,base;
async function api(url,body,role='finance',key='asset-cost-review-key',actor=1){const r=await fetch(base+url,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','x-role':role,'x-actor':String(actor),'Idempotency-Key':key},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:r.status,body:await r.json()};}
const economics=id=>api('/assets/'+id+'/economics');
before(async()=>{
 await db.batch([
  'CREATE TABLE products(id INTEGER PRIMARY KEY,name TEXT,sku TEXT,stock_qty INTEGER)',
  'CREATE TABLE branches(id INTEGER PRIMARY KEY,name TEXT)',
  'CREATE TABLE employees(id INTEGER PRIMARY KEY)',
  'CREATE TABLE inventory_serials(id INTEGER PRIMARY KEY,serial_number TEXT)',
  'CREATE TABLE rental_agreements(id INTEGER PRIMARY KEY,status TEXT)',
  'CREATE TABLE rental_agreement_items(id INTEGER PRIMARY KEY,agreement_id INTEGER,quantity REAL,rental_fee REAL)',
  'CREATE TABLE consumable_catalog(id INTEGER PRIMARY KEY,name TEXT,sku TEXT,uom TEXT)',
  'CREATE TABLE consumable_movements(id INTEGER PRIMARY KEY,action TEXT,consumable_id INTEGER,branch_id INTEGER,rental_product_id INTEGER,rental_asset_id INTEGER,rental_asset_number TEXT,rental_unit_reference TEXT,quantity INTEGER,value_cents INTEGER,purpose TEXT,created_at TEXT)',
  'CREATE TABLE consumable_issue_returns(id INTEGER PRIMARY KEY,issue_movement_id INTEGER,quantity INTEGER,value_cents INTEGER,reason TEXT,created_at TEXT)',
  "INSERT INTO products VALUES(1,'Mixer','MIX',77)","INSERT INTO branches VALUES(1,'Kingston'),(2,'Ocho Rios')",'INSERT INTO employees VALUES(1),(2),(3)',
  "INSERT INTO rental_agreements VALUES(1,'returned')",'INSERT INTO rental_agreement_items VALUES(1,1,1,10)',
  "INSERT INTO consumable_catalog VALUES(1,'Lubricant','OIL','bottle')"
 ],'write');
 const route=require('../routes/rental-asset-lifetime-economics');await route.ensureSchema();
 await sql("INSERT INTO rental_assets(id,asset_number,product_id,branch_id,acquisition_cost,acquisition_date,acquisition_evidence_ref) VALUES(1,'MIX-1',1,1,2,'2026-01-01','Opening register'),(2,'MIX-2',1,2,2,'2026-01-01','Opening register'),(3,'MIX-3',1,1,2,'2026-01-01','Opening register')");
 await sql('INSERT INTO rental_asset_allocations(asset_id,agreement_id,agreement_item_id) VALUES(1,1,1)');
 await sql("INSERT INTO rental_asset_maintenance(id,asset_id,maintenance_type,started_at,ended_at,direct_cost,evidence_ref) VALUES(1,1,'Service','2026-01-01','2026-01-02',1.5,'Workshop invoice')");
 await sql("INSERT INTO consumable_movements VALUES(1,'issue',1,1,1,1,'MIX-1','MIX-1',3,101,'Mixer service','2026-01-03'),(2,'issue',1,2,1,2,'MIX-2','MIX-2',1,200,'Other machine','2026-01-03'),(3,'receive',1,1,NULL,NULL,NULL,NULL,10,500,'Delivery','2026-01-01')");
 await sql("INSERT INTO consumable_issue_returns VALUES(1,1,1,34,'Unused bottle','2026-02-01')");
 const app=require('express')();app.use(require('express').json());app.use((req,res,next)=>{const role=req.headers['x-role'];if(role!=='anonymous')req.employee={id:Number(req.headers['x-actor']||1),default_branch_id:role==='other'?2:role==='unassigned'?null:1,permissions:role==='viewer'?{rentals:true}:role==='denied'?{}:{reports_financial:true,reports:true,...(role==='global'?{branches:true}:{})}};if(role==='key')req.apiKey={};next();});
 // New review router is dynamically mounted once implemented, allowing the first red test to exercise the old report.
 try{app.use(require('../routes/rental-consumable-economics'));}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e;}
 app.use(route.router);server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});base='http://127.0.0.1:'+server.address().port;
});
after(async()=>{if(server)await new Promise(r=>server.close(r));db.close();try{fs.rmSync(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});}catch(e){if(process.platform!=='win32'||!['EPERM','EBUSY'].includes(e.code))throw e;/* Windows libsql may retain a native handle until process exit; OS temp cleanup then applies. */}});
test('asset report exposes exact original costs and withholds contribution when maintenance may overlap supplies',async()=>{
 const r=await economics(1);assert.equal(r.status,200);assert.equal(r.body.consumables?.gross_cost_cents,101);assert.equal(r.body.consumables.returned_cost_cents,34);assert.equal(r.body.consumables.net_cost_cents,67);assert.equal(r.body.lifetime.evidenced_contribution,null);assert.equal(r.body.maintenance.cost_review_required,true);
});
test('Finance reviews only the external maintenance portion, preserving original costs and deriving contribution once',async()=>{
 const body={recorded_cost_cents:150,expected_review_id:null,non_consumable_cost_cents:100,reason:'External labour excludes separately issued supplies',evidence_ref:'Workshop invoice breakdown'};
 const r=await api('/assets/1/maintenance/1/cost-review',body);assert.equal(r.status,200,JSON.stringify(r.body));assert.ok(r.body.id);
 assert.equal((await api('/assets/1/maintenance/1/cost-review',body)).body.replayed,true);
 assert.equal((await api('/assets/1/maintenance/1/cost-review',body,'finance','asset-cost-review-key',2)).status,409);
 for(const role of ['viewer','denied','other','unassigned','key','anonymous'])assert.ok([401,403].includes((await api('/assets/1/maintenance/1/cost-review',body,role)).status),role);
 const result=(await economics(1)).body;assert.equal(result.maintenance.direct_cost,1.5);assert.equal(result.maintenance.non_consumable_cost,1);assert.equal(result.lifetime.evidenced_contribution,6.33);assert.equal(result.consumables.net_cost_cents,67);
 assert.equal(Number((await sql('SELECT direct_cost FROM rental_asset_maintenance WHERE id=1')).rows[0].direct_cost),1.5);assert.equal(Number((await sql('SELECT stock_qty FROM products')).rows[0].stock_qty),77);
 await assert.rejects(sql('DELETE FROM rental_asset_cost_reviews'),/immutable/);
});
test('invalid cost splits and missing or mismatched sources fail without recording a review',async()=>{
 const count=async()=>Number((await sql('SELECT COUNT(*) n FROM rental_asset_cost_reviews')).rows[0].n),before=await count();
 const payload={recorded_cost_cents:150,expected_review_id:1,non_consumable_cost_cents:100,reason:'External labour excludes separately issued supplies',evidence_ref:'Workshop invoice'};
 for(const body of [{...payload,non_consumable_cost_cents:151},{...payload,non_consumable_cost_cents:'100'},{...payload,non_consumable_cost_cents:-1},{...payload,non_consumable_cost_cents:Number.MAX_SAFE_INTEGER+1},{...payload,reason:'Short'},{...payload,evidence_ref:'unknown'}])assert.ok([400,409].includes((await api('/assets/1/maintenance/1/cost-review',body,'finance','cost-invalid-'+Math.random())).status));
 assert.equal((await api('/assets/1/maintenance/999/cost-review',payload,'finance','cost-missing-source')).status,404);
 assert.equal((await api('/assets/3/maintenance/1/cost-review',payload,'finance','cost-wrong-asset')).status,404);
 const bare=await fetch(base+'/assets/1/maintenance/1/cost-review',{method:'POST',headers:{'x-role':'finance','Idempotency-Key':'cost-empty-request'}});assert.equal(bare.status,400);
 assert.equal(await count(),before);
});
test('stale costs and competing reviews cannot silently replace the current review',async()=>{
 const previous=(await sql('SELECT id FROM rental_asset_cost_reviews ORDER BY id DESC LIMIT 1')).rows[0].id;
 const body={recorded_cost_cents:150,expected_review_id:Number(previous),non_consumable_cost_cents:80,reason:'Corrected external service breakdown',evidence_ref:'Corrected invoice'};
 const results=await Promise.all([api('/assets/1/maintenance/1/cost-review',body,'finance','cost-review-race-a'),api('/assets/1/maintenance/1/cost-review',body,'finance','cost-review-race-b')]);assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);
 await sql('UPDATE rental_asset_maintenance SET direct_cost=2 WHERE id=1');assert.equal((await economics(1)).body.lifetime.evidenced_contribution,null);
 assert.equal((await api('/assets/1/maintenance/1/cost-review',body,'finance','cost-review-stale')).status,409);
});
test('manual direct-cost events need the same overlap review as maintenance bills',async()=>{
 await sql('UPDATE rental_asset_maintenance SET direct_cost=1.5 WHERE id=1');
 await sql("INSERT INTO rental_asset_economic_events(id,asset_id,event_type,amount,evidence_ref,event_date) VALUES(1,1,'other_direct_cost',2,'Parts and labour invoice','2026-01-05')");
 assert.equal((await economics(1)).body.lifetime.evidenced_contribution,null);
 const body={recorded_cost_cents:200,expected_review_id:null,non_consumable_cost_cents:100,reason:'External parts exclude stock consumables',evidence_ref:'Parts invoice breakdown'};
 const saved=await api('/assets/1/economic-events/1/cost-review',body,'finance','economic-cost-review');assert.equal(saved.status,200,JSON.stringify(saved.body));
 const report=(await economics(1)).body;assert.equal(report.other_economics.non_consumable_direct_costs,1);assert.equal(report.lifetime.evidenced_contribution,5.53);
});
test('unissued and cancelled allocations do not masquerade as earned rental revenue',async()=>{
 await sql("INSERT INTO rental_agreements VALUES(2,'pending'),(3,'cancelled')");await sql('INSERT INTO rental_agreement_items VALUES(2,2,1,100),(3,3,1,200)');await sql('INSERT INTO rental_asset_allocations(asset_id,agreement_id,agreement_item_id) VALUES(1,2,2),(1,3,3)');
 const report=(await economics(1)).body;assert.equal(report.rentals.core_rental_revenue,10);assert.equal(report.rentals.rental_count,1);
});
test('reports fail closed on foreign or missing branch and retain costs across physical asset transfer',async()=>{
 for(const role of ['other','unassigned','key','denied','anonymous'])assert.ok([401,403].includes((await api('/assets/1/economics',undefined,role)).status),role);
 assert.equal((await api('/asset-economics?branch_id=2',undefined,'viewer')).status,403);
 assert.equal((await api('/asset-economics?branch_id=no',undefined,'global')).status,400);
 await sql('UPDATE rental_assets SET branch_id=2 WHERE id=1');assert.equal((await economics(1)).status,403);
 const moved=await api('/assets/1/economics',undefined,'other');assert.equal(moved.status,200);assert.equal(moved.body.consumables.net_cost_cents,67);
 await sql('UPDATE rental_assets SET branch_id=1 WHERE id=1');
});
test('full unused returns restore every original issue cent and excess evidence fails closed',async()=>{
 await sql("INSERT INTO consumable_issue_returns VALUES(2,1,2,67,'Remaining unused supplies','2026-02-02')");
 const report=(await economics(1)).body;assert.equal(report.consumables.gross_cost_cents,101);assert.equal(report.consumables.returned_cost_cents,101);assert.equal(report.consumables.net_cost_cents,0);assert.equal(report.lifetime.evidenced_contribution,6.2);
 assert.equal(Number((await sql('SELECT value_cents FROM consumable_movements WHERE id=1')).rows[0].value_cents),101);
 await sql("INSERT INTO consumable_issue_returns VALUES(3,1,1,1,'Invalid evidence sentinel','2026-02-03')");assert.equal((await economics(1)).status,409);await sql('DELETE FROM consumable_issue_returns WHERE id=3');
});
test('fleet pages cover the whole authorized branch and search is server-side and literal',async()=>{
 await sql("INSERT INTO rental_assets(id,asset_number,product_id,branch_id,acquisition_cost,acquisition_date,acquisition_evidence_ref) VALUES(4,'MIX%4',1,1,2,'2026-01-01','Register'),(5,'MIX-5',1,1,2,'2026-01-01','Register')");
 const seen=[],first=await api('/asset-economics?limit=2',undefined,'viewer');assert.equal(first.status,200,JSON.stringify(first.body));
 assert.equal(first.body.assets.length,2);assert.equal(first.body.has_more,true);assert.ok(first.body.next_cursor);
 let cursor=first.body.next_cursor;seen.push(...first.body.assets.map(a=>a.asset_id));
 while(cursor){const r=await api('/asset-economics?limit=2&cursor='+encodeURIComponent(cursor),undefined,'viewer');assert.equal(r.status,200,JSON.stringify(r.body));seen.push(...r.body.assets.map(a=>a.asset_id));cursor=r.body.next_cursor;}
 assert.deepEqual([...seen].sort((a,b)=>a-b),[1,3,4,5]);assert.equal(new Set(seen).size,4);
 const exact=await api('/asset-economics?search=%25',undefined,'viewer');assert.equal(exact.status,200,JSON.stringify(exact.body));assert.deepEqual(exact.body.assets.map(a=>a.asset_number),['MIX%4']);
 const escapedUnderscore=await api('/asset-economics?search=MIX_4',undefined,'viewer');assert.deepEqual(escapedUnderscore.body.assets,[]);
 const sku=await api('/asset-economics?search=mix&limit=2',undefined,'viewer');assert.equal(sku.body.assets.length,2);assert.equal(sku.body.has_more,true);
 const other=await api('/asset-economics?search=mix',undefined,'other');assert.deepEqual(other.body.assets.map(a=>a.asset_id),[2]);
 for(const invalid of ['not-a-cursor','W10','eyJ4IjoxfQ'])assert.equal((await api('/asset-economics?cursor='+invalid,undefined,'viewer')).status,400);
 for(const invalid of ['0','-1','501','3.5','hello'])assert.equal((await api('/asset-economics?limit='+invalid,undefined,'viewer')).status,400);
 assert.equal((await api('/asset-economics?limit=2',undefined,'key')).status,403);
});
test('source evidence never guesses legacy asset identities and missing lazy tables remain explicit',async()=>{
 await sql("INSERT INTO consumable_movements VALUES(4,'issue',1,1,1,NULL,NULL,'MIX-1',1,50,'Legacy service','2025-01-01')");
 let r=(await economics(1)).body;assert.equal(r.consumables.net_cost_cents,0);assert.equal(r.consumables.unresolved_legacy_issues,1);assert.equal(r.cost_coverage.partial,true);
 const evidence=await api('/assets/1/cost-evidence');assert.equal(evidence.status,200);assert.equal(evidence.body.issues.length,1);assert.equal(evidence.body.issues[0].id,1);assert.equal(evidence.body.issues[0].net_cost_cents,0);
 await sql('DROP TABLE consumable_issue_returns');r=(await economics(1)).body;assert.equal(r.cost_coverage.partial,true);assert.ok(r.cost_coverage.missing_sources.includes('consumable_issue_returns'));
 await sql('DROP TABLE consumable_movements');r=(await economics(1)).body;assert.ok(r.cost_coverage.missing_sources.includes('consumable_movements'));
});
