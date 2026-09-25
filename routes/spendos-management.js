'use strict';
const express=require('express');
const router=express.Router();
const {requireAnyPermission}=require('../lib/permissions');

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

router.get('/opportunities',async(req,res)=>{
  try{
    const {tenant}=config();
    const result=await callSpendOS(`/v1/savings/run?tenantId=${encodeURIComponent(tenant)}`,{method:'POST'});
    res.json(result);
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
