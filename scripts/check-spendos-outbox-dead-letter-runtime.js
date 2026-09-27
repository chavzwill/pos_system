'use strict';
const fs=require('fs'),http=require('http'),path=require('path');
const dbPath=path.join(__dirname,'..','spendos-dead-letter-runtime.db');
try{fs.rmSync(dbPath);}catch{}
process.env.TURSO_DATABASE_URL='file:'+dbPath;
process.env.SPENDOS_OUTBOX_MAX_ATTEMPTS='2';
const {db,ensureReady}=require('../database');
const {enqueuePurchaseRequested}=require('../lib/spendos-outbox');

async function seed(){
  await ensureReady();
  const tx=await db.transaction('write');
  const r=await tx.execute({sql:`INSERT INTO purchase_requests(pr_number,department,request_type,currency,spendos_version)
    VALUES(?,?,?,?,?)`,args:['PR-DLQ-001','Operations','internal_use','JMD',1]});
  const id=Number(r.lastInsertRowid);
  await enqueuePurchaseRequested(tx,{id,pr_number:'PR-DLQ-001',department:'Operations',request_type:'internal_use',currency:'JMD',sourceVersion:1,items:[]});
  await tx.commit();
  return id;
}
async function main(){
  const server=http.createServer((req,res)=>{req.resume();res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:'forced failure'}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();
  process.env.SPENDOS_INGEST_URL=`http://127.0.0.1:${address.port}/v1/events`;
  const prId=await seed();
  const {claimRows,deliver}=require('./deliver-spendos-outbox');

  let claimed=await claimRows();
  if(claimed.length!==1)throw new Error('Expected first claim');
  let result=await deliver(claimed[0]);
  if(result.status!=='failed'||result.attempts!==1)throw new Error('First failure did not remain retryable');
  let {rows:[row]}=await db.execute({sql:'SELECT * FROM spendos_outbox WHERE aggregate_id=?',args:[String(prId)]});
  if(row.status!=='failed'||Number(row.attempts)!==1)throw new Error('Outbox did not persist first failure');

  await db.execute({sql:'UPDATE spendos_outbox SET available_at=CURRENT_TIMESTAMP WHERE id=?',args:[row.id]});
  claimed=await claimRows();
  if(claimed.length!==1)throw new Error('Expected second claim');
  result=await deliver(claimed[0]);
  if(result.status!=='dead_letter'||result.attempts!==2)throw new Error('Second failure did not dead-letter');
  ({rows:[row]}=await db.execute({sql:'SELECT * FROM spendos_outbox WHERE id=?',args:[row.id]}));
  if(row.status!=='dead_letter'||Number(row.attempts)!==2||!String(row.last_error||'').includes('503'))throw new Error('Dead-letter evidence not persisted');

  claimed=await claimRows();
  if(claimed.length!==0)throw new Error('Dead-letter event was claimed automatically');

  server.close();
  try{fs.rmSync(dbPath);}catch{}
  console.log(JSON.stringify({ok:true,event_id:row.event_id,status:row.status,attempts:Number(row.attempts)}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
