'use strict';
require('dotenv').config({quiet:true});
const {db,ensureReady}=require('../database');
const {ensureCostAllocationSchema}=require('../lib/cost-allocations');
const {enqueuePurchaseRequested}=require('../lib/spendos-outbox');

const apply=process.argv.includes('--apply');
const limitArg=process.argv.find(x=>x.startsWith('--limit='));
const limit=limitArg?Math.max(1,Math.min(10000,Number(limitArg.split('=')[1])||10000)):10000;
const now=()=>new Date().toISOString();

async function loadItems(executor,prId){
  const {rows:items}=await executor.execute({sql:'SELECT * FROM purchase_request_items WHERE pr_id=? ORDER BY id',args:[prId]});
  const {rows:allocs}=await executor.execute({sql:`SELECT * FROM cost_allocations
    WHERE source_type='purchase_request' AND source_id=? ORDER BY source_line_id,id`,args:[String(prId)]});
  return items.map(item=>({...item,allocations:allocs.filter(a=>String(a.source_line_id)===String(item.id))}));
}
function unsafeReason(pr,items){
  if(!items.length)return 'no_purchase_request_items';
  if(items.some(x=>!Number.isFinite(Number(x.quantity))||Number(x.quantity)<=0))return 'invalid_item_quantity';
  if(items.some(x=>!Number.isFinite(Number(x.total))||Number(x.total)<0))return 'invalid_item_total';
  if(String(pr.request_type||'sale_items')==='internal_use'){
    const missing=items.find(x=>!Array.isArray(x.allocations)||x.allocations.length===0);
    if(missing)return `internal_use_item_missing_allocation:${missing.id}`;
  }
  return null;
}
function payloadStatus(row){
  if(!row)return null;
  try{return JSON.parse(row.payload||'{}')?.payload?.status||null;}catch{return null;}
}

async function inspectPR(pr){
  const items=await loadItems(db,pr.id);
  const unsafe=unsafeReason(pr,items);
  const {rows:events}=await db.execute({sql:`SELECT * FROM spendos_outbox
    WHERE aggregate_type='purchase_request' AND aggregate_id=?
    ORDER BY source_version DESC,id DESC`,args:[String(pr.id)]});
  const currentVersion=Number(pr.spendos_version||1);
  const exact=events.find(x=>Number(x.source_version)===currentVersion)||null;
  const latest=events[0]||null;
  if(unsafe)return {classification:'unsafe',reason:unsafe,pr,items,currentVersion,exact,latest};
  if(!exact)return {classification:'missing_current_snapshot',reason:events.length?'current_version_not_emitted':'no_spendos_history',pr,items,currentVersion,exact,latest};
  if(payloadStatus(exact)!==String(pr.status||'draft'))return {classification:'stale_current_snapshot',reason:`outbox_status_${payloadStatus(exact)||'unknown'}_pos_status_${pr.status||'draft'}`,pr,items,currentVersion,exact,latest};
  return {classification:'current',reason:null,pr,items,currentVersion,exact,latest};
}
async function applyOne(row){
  if(row.classification==='current'||row.classification==='unsafe')return {changed:false,classification:row.classification};
  const tx=await db.transaction('write');let committed=false;
  try{
    const {rows:[fresh]}=await tx.execute({sql:'SELECT * FROM purchase_requests WHERE id=?',args:[row.pr.id]});
    if(!fresh)throw new Error('Purchase request disappeared during backfill');
    const items=await loadItems(tx,fresh.id);
    const unsafe=unsafeReason(fresh,items);
    if(unsafe)throw new Error('Backfill became unsafe: '+unsafe);
    const currentVersion=Number(fresh.spendos_version||1);
    const {rows:events}=await tx.execute({sql:`SELECT * FROM spendos_outbox
      WHERE aggregate_type='purchase_request' AND aggregate_id=?
      ORDER BY source_version DESC,id DESC`,args:[String(fresh.id)]});
    const exact=events.find(x=>Number(x.source_version)===currentVersion)||null;
    if(exact&&payloadStatus(exact)===String(fresh.status||'draft')){
      await tx.rollback();
      return {changed:false,classification:'current_after_recheck'};
    }
    const targetVersion=exact?currentVersion+1:currentVersion;
    if(targetVersion!==currentVersion){
      await tx.execute({sql:'UPDATE purchase_requests SET spendos_version=? WHERE id=?',args:[targetVersion,fresh.id]});
    }
    await enqueuePurchaseRequested(tx,{
      ...fresh,
      sourceVersion:targetVersion,
      items,
      backfill:{basis:'current_authoritative_snapshot',detectedAt:now()}
    });
    await tx.commit();committed=true;
    return {changed:true,classification:exact?'stale_repaired':'missing_repaired',sourceVersion:targetVersion};
  }catch(e){
    if(!committed)try{await tx.rollback();}catch{}
    throw e;
  }
}

async function main(){
  await ensureReady();
  await ensureCostAllocationSchema();
  const {rows:prs}=await db.execute({sql:'SELECT * FROM purchase_requests ORDER BY id LIMIT ?',args:[limit]});
  const inspected=[];
  for(const pr of prs)inspected.push(await inspectPR(pr));
  const summary={
    mode:apply?'apply':'dry_run',
    scanned:inspected.length,
    current:inspected.filter(x=>x.classification==='current').length,
    missing_current_snapshot:inspected.filter(x=>x.classification==='missing_current_snapshot').length,
    stale_current_snapshot:inspected.filter(x=>x.classification==='stale_current_snapshot').length,
    unsafe:inspected.filter(x=>x.classification==='unsafe').length,
    changed:0,
    errors:[]
  };
  const results=[];
  if(apply){
    for(const row of inspected){
      try{
        const result=await applyOne(row);
        if(result.changed)summary.changed++;
        results.push({id:row.pr.id,pr_number:row.pr.pr_number,before:row.classification,...result});
      }catch(e){
        summary.errors.push({id:row.pr.id,pr_number:row.pr.pr_number,error:String(e.message||e)});
      }
    }
  }else{
    for(const row of inspected.filter(x=>x.classification!=='current'))results.push({
      id:row.pr.id,pr_number:row.pr.pr_number,status:row.pr.status,spendos_version:row.currentVersion,
      classification:row.classification,reason:row.reason,latest_outbox_version:row.latest?Number(row.latest.source_version):null
    });
  }
  console.log(JSON.stringify({summary,results},null,2));
  if(summary.errors.length)process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exitCode=1;});
