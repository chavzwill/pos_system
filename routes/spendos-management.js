'use strict';
const express=require('express');
const router=express.Router();
const {requireAnyPermission,requirePermission}=require('../lib/permissions');
const {db}=require('../database');

router.use(requireAnyPermission('reports_financial','purchasing'));

function config(){
  const ingest=process.env.SPENDOS_INGEST_URL;
  if(!ingest)throw Object.assign(new Error('SpendOS is not configured'),{statusCode:503});
  const u=new URL(ingest);
  return {base:u.origin,key:process.env.SPENDOS_API_KEY||'',tenant:process.env.SPENDOS_TENANT_ID||'total-tools'};
}

async function callSpendOS(path,options={}){
  const {base,key}=config();
  const headers={...(options.headers||{})};
  if(key)headers.authorization=`Bearer ${key}`;
  if(options.body)headers['content-type']='application/json';
  const response=await fetch(base+path,{...options,headers});
  const text=await response.text();
  let body={};try{body=JSON.parse(text||'{}');}catch{body={error:text||'Invalid SpendOS response'};}
  if(!response.ok)throw Object.assign(new Error(body.error||'SpendOS request failed'),{statusCode:response.status});
  return body;
}

router.get('/outbox/health',async(req,res)=>{
  try{
    const {rows:counts}=await db.execute({sql:`SELECT status,COUNT(*) count,MAX(attempts) max_attempts,
      MIN(created_at) oldest_created_at FROM spendos_outbox GROUP BY status ORDER BY status`,args:[]});
    const byStatus=Object.fromEntries(counts.map(x=>[x.status,{count:Number(x.count||0),max_attempts:Number(x.max_attempts||0),oldest_created_at:x.oldest_created_at||null}]));
    const {rows:[age]}=await db.execute({sql:`SELECT
      COALESCE(SUM(CASE WHEN status='pending' AND datetime(created_at)<=datetime('now','-15 minutes') THEN 1 ELSE 0 END),0) stale_pending,
      COALESCE(SUM(CASE WHEN status='sending' AND datetime(available_at)<=CURRENT_TIMESTAMP THEN 1 ELSE 0 END),0) expired_sending,
      COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END),0) failed,
      COALESCE(SUM(CASE WHEN status='dead_letter' THEN 1 ELSE 0 END),0) dead_letter
      FROM spendos_outbox`,args:[]});
    const {rows:deadLetters}=await db.execute({sql:`SELECT id,event_id,event_type,aggregate_type,aggregate_id,source_version,attempts,last_error,created_at
      FROM spendos_outbox WHERE status='dead_letter' ORDER BY id DESC LIMIT 50`,args:[]});
    const stalePending=Number(age?.stale_pending||0),expiredSending=Number(age?.expired_sending||0),failed=Number(age?.failed||0),deadLetter=Number(age?.dead_letter||0);
    const status=deadLetter>0?'critical':(failed>0||expiredSending>0||stalePending>0?'degraded':'healthy');
    res.json({
      status,
      counts:byStatus,
      stale_pending:stalePending,
      expired_sending:expiredSending,
      failed,
      dead_letter:deadLetter,
      dead_letters:deadLetters,
      basis:'Outbox health is operational delivery evidence only. Requeueing a dead-letter event retries the existing immutable event and does not alter POS source records.'
    });
  }catch(e){res.status(500).json({error:e.message});}
});

router.post('/outbox/:id/requeue',requirePermission('reports_financial'),async(req,res)=>{
  try{
    const id=Number(req.params.id);
    const {rows:[row]}=await db.execute({sql:'SELECT * FROM spendos_outbox WHERE id=?',args:[id]});
    if(!row)return res.status(404).json({error:'SpendOS outbox event not found'});
    if(row.status!=='dead_letter')return res.status(409).json({error:'Only dead-letter SpendOS events can be manually requeued'});
    await db.execute({sql:`UPDATE spendos_outbox SET status='pending',attempts=0,last_error=NULL,available_at=CURRENT_TIMESTAMP,sent_at=NULL WHERE id=?`,args:[id]});
    res.json({id,event_id:row.event_id,status:'pending',requeued:true});
  }catch(e){res.status(500).json({error:e.message});}
});

router.get('/opportunities',async(req,res)=>{
  try{
    const {tenant}=config();
    const opportunities=await callSpendOS(`/v1/savings/opportunities?tenantId=${encodeURIComponent(tenant)}`);
    res.json({opportunities});
  }catch(e){res.status(e.statusCode||502).json({error:e.message});}
});

router.get('/leakage/cases',async(req,res)=>{
  try{
    const {tenant}=config();
    res.json(await callSpendOS(`/v1/savings/leakage/cases?tenantId=${encodeURIComponent(tenant)}`));
  }catch(e){res.status(e.statusCode||502).json({error:e.message});}
});

router.post('/scan',requirePermission('reports_financial'),async(req,res)=>{
  try{
    const {tenant}=config();
    const status=await callSpendOS(`/v1/system/status?tenantId=${encodeURIComponent(tenant)}`);
    if(!status.eventCount)return res.status(409).json({error:'Awaiting POS evidence'});
    const result=await callSpendOS(`/v1/savings/run?tenantId=${encodeURIComponent(tenant)}`,{method:'POST'});
    await callSpendOS(`/v1/savings/leakage/cases?tenantId=${encodeURIComponent(tenant)}`,{method:'POST'});
    res.json(result);
  }catch(e){res.status(e.statusCode||502).json({error:e.message});}
});

router.post('/leakage/cases',async(req,res)=>{
  try{
    const {tenant}=config();
    res.json(await callSpendOS(`/v1/savings/leakage/cases?tenantId=${encodeURIComponent(tenant)}`,{method:'POST'}));
  }catch(e){res.status(e.statusCode||502).json({error:e.message});}
});

router.post('/leakage/cases/:id/state',async(req,res)=>{
  try{
    const {tenant}=config();
    const payload={...req.body,actorId:req.employee?.id?String(req.employee.id):null};
    res.json(await callSpendOS(`/v1/savings/leakage/cases/${req.params.id}/state?tenantId=${encodeURIComponent(tenant)}`,{method:'POST',body:JSON.stringify(payload)}));
  }catch(e){res.status(e.statusCode||502).json({error:e.message});}
});

router.post('/leakage/cases/:id/verify',async(req,res)=>{
  try{
    const {tenant}=config();
    res.json(await callSpendOS(`/v1/savings/leakage/cases/${req.params.id}/verify?tenantId=${encodeURIComponent(tenant)}`,{method:'POST'}));
  }catch(e){res.status(e.statusCode||502).json({error:e.message});}
});

router.get('/leakage',async(req,res)=>{
  try{
    const {tenant}=config();
    res.json(await callSpendOS(`/v1/savings/leakage?tenantId=${encodeURIComponent(tenant)}`));
  }catch(e){res.status(e.statusCode||502).json({error:e.message});}
});

router.get('/attention',async(req,res)=>{
  try{
    const {tenant}=config();
    res.json(await callSpendOS(`/v1/savings/attention?tenantId=${encodeURIComponent(tenant)}`));
  }catch(e){res.status(e.statusCode||502).json({error:e.message});}
});

router.get('/targets/performance',async(req,res)=>{
  try{
    const {tenant}=config();
    res.json(await callSpendOS(`/v1/savings/targets/performance?tenantId=${encodeURIComponent(tenant)}`));
  }catch(e){res.status(e.statusCode||502).json({error:e.message});}
});

router.post('/targets',async(req,res)=>{
  try{
    const {tenant}=config();
    const payload={...req.body,ownerId:req.body?.ownerId|| (req.employee?.id?String(req.employee.id):null)};
    res.status(201).json(await callSpendOS(`/v1/savings/targets?tenantId=${encodeURIComponent(tenant)}`,{
      method:'POST',body:JSON.stringify(payload)
    }));
  }catch(e){res.status(e.statusCode||502).json({error:e.message});}
});

router.get('/verified-rollup',async(req,res)=>{
  try{
    const {tenant}=config();
    res.json(await callSpendOS(`/v1/savings/verified-rollup?tenantId=${encodeURIComponent(tenant)}`));
  }catch(e){res.status(e.statusCode||502).json({error:e.message});}
});

router.get('/opportunities/:id',async(req,res)=>{
  try{
    const {tenant}=config();
    res.json(await callSpendOS(`/v1/savings/opportunities/${req.params.id}?tenantId=${encodeURIComponent(tenant)}`));
  }catch(e){res.status(e.statusCode||502).json({error:e.message});}
});

router.post('/opportunities/:id/actions',async(req,res)=>{
  try{
    const {tenant}=config();
    const payload={...req.body,actorId:req.employee?.id?String(req.employee.id):null};
    res.status(201).json(await callSpendOS(
      `/v1/savings/opportunities/${req.params.id}/actions?tenantId=${encodeURIComponent(tenant)}`,
      {method:'POST',body:JSON.stringify(payload)}
    ));
  }catch(e){res.status(e.statusCode||502).json({error:e.message});}
});

router.post('/opportunities/:id/verify',async(req,res)=>{
  try{
    const {tenant}=config();
    res.json(await callSpendOS(
      `/v1/savings/opportunities/${req.params.id}/verify?tenantId=${encodeURIComponent(tenant)}`,
      {method:'POST'}
    ));
  }catch(e){res.status(e.statusCode||502).json({error:e.message});}
});

module.exports=router;
