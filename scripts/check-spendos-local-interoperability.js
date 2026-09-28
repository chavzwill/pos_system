'use strict';
// Synthetic certification fixtures live only in unique temporary databases.
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const express=require('express');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'spendos-interop-cert-'));
process.env.TURSO_DATABASE_URL='file:'+path.join(dir,'pos.db');
process.env.SPENDOS_DB=path.join(dir,'spendos.db');
process.env.POS_SKIP_DEMO_SEED='1';
process.env.SPENDOS_TENANT_ID='certification-only';
process.env.SPENDOS_API_KEY='isolated-test-only';
process.env.SPENDOS_OUTBOX_MAX_ATTEMPTS='2';
process.env.NODE_ENV='test';
const spendRoot=process.env.SPENDOS_SOURCE_DIR;
if(!spendRoot)throw new Error('SPENDOS_SOURCE_DIR is required');
const spend=require(path.join(spendRoot,'src/server'));
const {db,ensureReady}=require('../database');
const {enqueuePurchaseRequested,enqueueSpendEvent}=require('../lib/spendos-outbox');
let proxy;
async function main(){
 await ensureReady();
 await new Promise(r=>spend.server.listen(0,'127.0.0.1',r));
 const origin=`http://127.0.0.1:${spend.server.address().port}`;
 process.env.SPENDOS_INGEST_URL=origin+'/v1/events';
 const worker=require('./deliver-spendos-outbox');
 const app=express();app.use(express.json());
 // Test-only employee context exercises the real permission middleware/router.
 app.use((req,res,next)=>{if(req.headers['x-cert-role'])req.employee={id:1,permissions:req.headers['x-cert-role']==='finance'?{reports_financial:true}:{purchasing:true}};next();});
 app.use('/api/spendos-management',require('../routes/spendos-management'));
 proxy=app.listen(0,'127.0.0.1');await new Promise(r=>proxy.once('listening',r));
 const proxyOrigin=`http://127.0.0.1:${proxy.address().port}/api/spendos-management`;
 const headers={'x-cert-role':'finance'};
 assert.equal((await fetch(proxyOrigin+'/opportunities')).status,401);
 for(const suffix of ['/opportunities','/leakage/cases','/outbox/health','/verified-rollup','/attention','/leakage','/targets/performance']){
  const response=await fetch(proxyOrigin+suffix,{headers});assert.equal(response.status,200,suffix);await response.json();
 }
 assert.equal((await fetch(proxyOrigin+'/scan',{method:'POST',headers})).status,409,'scan requires evidence');
 assert.equal(spend.db.prepare('SELECT COUNT(*) n FROM spend_events').get().n,0);
 assert.equal(spend.db.prepare('SELECT COUNT(*) n FROM savings_opportunities').get().n,0);
 const input={id:1,pr_number:'CERT-ONLY',sourceVersion:1,currency:'JMD',items:[{sku:'CERT',product_name:'Certification fixture',quantity:1,unit_cost:10,total:10}]};
 let tx=await db.transaction('write');
 await tx.execute({sql:'INSERT INTO purchase_requests(id,pr_number) VALUES(?,?)',args:[1,'CERT-ONLY']});
 await enqueuePurchaseRequested(tx,input);await tx.rollback();
 assert.equal(Number((await db.execute('SELECT COUNT(*) n FROM purchase_requests')).rows[0].n),0);
 assert.equal((await worker.claimRows()).length,0);
 tx=await db.transaction('write');
 await tx.execute({sql:'INSERT INTO purchase_requests(id,pr_number) VALUES(?,?)',args:[1,'CERT-ONLY']});
 const event=await enqueuePurchaseRequested(tx,input);await tx.commit();
 const claimed=await worker.claimRows();assert.equal(claimed.length,1);
 assert.equal((await worker.claimRows()).length,0,'lease prevents a second claim');
 assert.equal((await worker.deliver(claimed[0])).status,'sent');
 assert.equal(spend.db.prepare('SELECT COUNT(*) n FROM spend_events').get().n,1);
 assert.equal((await worker.deliver(claimed[0])).status,'sent','receiver accepts replay');
 assert.equal(spend.db.prepare('SELECT COUNT(*) n FROM spend_events').get().n,1);
 // Force a real receiver rejection, backoff, dead letter, then permissioned requeue.
 for(const type of ['purchase.received','consumable.issued']){
  tx=await db.transaction('write');
  await enqueueSpendEvent(tx,{...event,id:'cert:'+type,sourceRecordId:'cert:'+type,type,payload:{currency:'JMD',items:[{sku:'CERT',quantity:1,unitCost:10,lineCost:10,trackedValue:10}]}});
  await tx.commit();
  const [delivery]=await worker.claimRows();assert.equal((await worker.deliver(delivery)).status,'sent');
 }
 assert.deepEqual(spend.db.prepare('SELECT state,amount FROM spend_facts ORDER BY state').all().map(r=>({...r})),[{state:'actual',amount:10},{state:'consumed',amount:10},{state:'requested',amount:10}]);
 tx=await db.transaction('write');await enqueuePurchaseRequested(tx,{...input,id:2,pr_number:'CERT-REJECT'});await tx.commit();
 await db.execute({sql:'UPDATE spendos_outbox SET payload=? WHERE aggregate_id=?',args:[JSON.stringify({id:'cert-invalid'}),'2']});
 let row=(await worker.claimRows())[0];assert.equal((await worker.deliver(row)).status,'failed');
 assert.equal((await worker.claimRows()).length,0,'backoff prevents immediate retry');
 await db.execute({sql:'UPDATE spendos_outbox SET available_at=CURRENT_TIMESTAMP WHERE id=?',args:[row.id]});
 row=(await worker.claimRows())[0];assert.equal((await worker.deliver(row)).status,'dead_letter');
 assert.equal((await worker.claimRows()).length,0,'terminal failures are not auto-retried');
 assert.equal((await (await fetch(proxyOrigin+'/outbox/health',{headers})).json()).status,'critical');
 assert.equal((await fetch(proxyOrigin+`/outbox/${row.id}/requeue`,{method:'POST',headers:{'x-cert-role':'purchasing'}})).status,403);
 const result=await (await fetch(proxyOrigin+`/outbox/${row.id}/requeue`,{method:'POST',headers})).json();
 assert.equal(result.event_id,row.event_id);assert.equal(result.status,'pending');
 assert.equal((await worker.claimRows()).length,1);
 const before=spend.db.prepare('SELECT total_changes() n').get().n;
 for(const suffix of ['/opportunities','/leakage/cases'])assert.equal((await fetch(proxyOrigin+suffix,{headers})).status,200);
 assert.equal(spend.db.prepare('SELECT total_changes() n').get().n,before,'management reads must not write');
 console.log(JSON.stringify({ok:true,fixtureDirectory:dir,checks:['empty management reads','unauthenticated denial','transaction rollback','atomic commit','claim lease','real receiver delivery','replay deduplication','retry backoff','dead letter','finance-only requeue','read-only proxy']}));
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
 if(proxy)await new Promise(r=>proxy.close(r));
 await new Promise(r=>spend.server.close(r));spend.db.close();db.close();
});
