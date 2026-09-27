'use strict';
const fs=require('fs'),path=require('path'),{spawnSync}=require('child_process');
const root=path.join(__dirname,'..');
const dbPath=path.join(root,'spendos-backfill-runtime.db');
try{fs.rmSync(dbPath);}catch{}
process.env.TURSO_DATABASE_URL='file:'+dbPath;
const {db,ensureReady}=require('../database');
const {ensureCostAllocationSchema}=require('../lib/cost-allocations');
const {enqueuePurchaseRequested}=require('../lib/spendos-outbox');

async function addPR({number,status='draft',request_type='sale_items',withEvent=false,eventStatus=status,allocated=false}){
  const tx=await db.transaction('write');let committed=false;
  try{
    const r=await tx.execute({sql:`INSERT INTO purchase_requests(pr_number,department,request_type,currency,status,spendos_version)
      VALUES(?,?,?,?,?,1)`,args:[number,'Operations',request_type,'JMD',status]});
    const id=Number(r.lastInsertRowid);
    const line=await tx.execute({sql:`INSERT INTO purchase_request_items(pr_id,product_name,sku,quantity,unit_cost,item_type,total)
      VALUES(?,?,?,?,?,?,?)`,args:[id,number+' item',number+'-SKU',2,100,request_type==='internal_use'?'internal':'sale',200]});
    if(allocated){
      await tx.execute({sql:`INSERT INTO cost_allocations(allocation_number,source_type,source_id,source_line_id,target_type,target_id,target_label,allocation_amount,allocation_percent,purpose,expense_category,valuation_status)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,args:['CA-'+number,'purchase_request',String(id),String(line.lastInsertRowid),'department','1','Operations',200,100,'Runtime','supplies','declared']});
    }
    if(withEvent){
      await enqueuePurchaseRequested(tx,{id,pr_number:number,department:'Operations',request_type,currency:'JMD',status:eventStatus,sourceVersion:1,items:[{product_name:number+' item',sku:number+'-SKU',quantity:2,unit_cost:100,total:200,allocations:[]}]});
    }
    await tx.commit();committed=true;return id;
  }catch(e){if(!committed)try{await tx.rollback();}catch{}throw e;}
}
function run(args=[]){
  const r=spawnSync(process.execPath,[path.join(__dirname,'backfill-spendos-purchase-requests.js'),...args],{
    cwd:root,env:{...process.env,TURSO_DATABASE_URL:'file:'+dbPath},encoding:'utf8'
  });
  if(r.status!==0)throw new Error('Backfill command failed: '+r.stderr+'\n'+r.stdout);
  return JSON.parse(r.stdout);
}
async function row(id){
  const {rows:[pr]}=await db.execute({sql:'SELECT * FROM purchase_requests WHERE id=?',args:[id]});
  const {rows:events}=await db.execute({sql:`SELECT * FROM spendos_outbox WHERE aggregate_type='purchase_request' AND aggregate_id=? ORDER BY source_version`,args:[String(id)]});
  return {pr,events};
}
async function main(){
  await ensureReady();await ensureCostAllocationSchema();
  const current=await addPR({number:'PR-CURRENT',withEvent:true});
  const missing=await addPR({number:'PR-MISSING'});
  const stale=await addPR({number:'PR-STALE',status:'approved',withEvent:true,eventStatus:'draft'});
  const unsafe=await addPR({number:'PR-UNSAFE',request_type:'internal_use',allocated:false});

  const before={};
  for(const id of [current,missing,stale,unsafe])before[id]=await row(id);
  const dry=run();
  if(dry.summary.current!==1||dry.summary.missing_current_snapshot!==1||dry.summary.stale_current_snapshot!==1||dry.summary.unsafe!==1)throw new Error('Dry-run classification mismatch: '+JSON.stringify(dry.summary));
  if(dry.summary.changed!==0)throw new Error('Dry run reported writes');
  for(const id of [current,missing,stale,unsafe]){
    const after=await row(id);
    if(after.pr.spendos_version!==before[id].pr.spendos_version||after.events.length!==before[id].events.length)throw new Error('Dry run mutated data');
  }

  const applied=run(['--apply']);
  if(applied.summary.changed!==2)throw new Error('Expected exactly two safe repairs');
  const c=await row(current),m=await row(missing),s=await row(stale),u=await row(unsafe);
  if(c.events.length!==1||Number(c.pr.spendos_version)!==1)throw new Error('Current PR was modified');
  if(m.events.length!==1||Number(m.events[0].source_version)!==1)throw new Error('Missing PR was not backfilled at version 1');
  const mp=JSON.parse(m.events[0].payload);
  if(mp.payload?.backfill?.basis!=='current_authoritative_snapshot')throw new Error('Missing PR lacks explicit backfill marker');
  if(s.events.length!==2||Number(s.pr.spendos_version)!==2||Number(s.events[1].source_version)!==2)throw new Error('Stale PR was not version-bumped and repaired');
  const sp=JSON.parse(s.events[1].payload);
  if(sp.payload?.status!=='approved'||sp.payload?.backfill?.basis!=='current_authoritative_snapshot')throw new Error('Stale repair snapshot is not current/marked');
  if(u.events.length!==0||Number(u.pr.spendos_version)!==1)throw new Error('Unsafe internal-use PR was modified');

  const replay=run(['--apply']);
  if(replay.summary.changed!==0)throw new Error('Backfill replay was not idempotent');

  try{fs.rmSync(dbPath);}catch{}
  console.log(JSON.stringify({ok:true,dry_run:dry.summary,apply:applied.summary,replay:replay.summary}));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
