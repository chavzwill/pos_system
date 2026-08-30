'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {can}=require('../lib/permissions');

let migrated=false;
async function migrateLegacyGroups(){
  if(migrated)return;
  const {rows}=await db.execute({sql:'SELECT id,permissions FROM security_groups',args:[]});
  for(const row of rows){
    let p={};try{p=JSON.parse(row.permissions||'{}')}catch{}
    if(['dispatch','dispatch_view','dispatch_plan','dispatch_execute','dispatch_admin'].some(k=>Object.prototype.hasOwnProperty.call(p,k)))continue;
    const full=!!p.transfers,create=!!p.transfers_create,approve=!!p.transfers_approve,pickup=!!p.transfers_pickup,dropoff=!!p.transfers_dropoff;
    if(!(full||create||approve||pickup||dropoff))continue;
    p.dispatch_view=true;
    if(full||create||approve)p.dispatch_plan=true;
    if(full||pickup||dropoff)p.dispatch_execute=true;
    if(full||approve)p.dispatch_admin=true;
    await db.execute({sql:'UPDATE security_groups SET permissions=? WHERE id=?',args:[JSON.stringify(p),row.id]});
  }
  migrated=true;
}
function has(req,key){return !!req.employee&&can(req.employee.permissions,key);}
function any(req,...keys){return keys.some(k=>has(req,k));}
function deny(res,key){return res.status(403).json({error:`Missing permission: ${key}`,control:'dispatch_rbac'});}
function sourceHandoff(path){return /^\/from-(purchase-order|sales-invoice|rental|repair)\//.test(path);}
function sourceDocument(path){return /^\/jobs\/\d+\/source-document(?:\/|$)/.test(path);}
function fieldExecution(path){
  return /^\/jobs\/\d+\/(stage\/|proof|complete|failed|reschedule)/.test(path)
    || /^\/routes\/\d+\/(start|close|stops\/\d+\/(complete|skip|stage|proof))/.test(path);
}
function planning(path){
  return path==='/jobs' || /^\/from-transfer\//.test(path) || /^\/jobs\/\d+$/.test(path)
    || /^\/jobs\/\d+\/assign$/.test(path)
    || /^\/routes(?:\/|$)/.test(path)
    || /^\/driver-shifts(?:\/|$)/.test(path);
}
function administration(path){
  return /^\/vehicles(?:\/|$)/.test(path)
    || /^\/service-zones(?:\/|$)/.test(path)
    || /^\/locations\/\d+\/verify$/.test(path)
    || /^\/travel-evidence(?:\/|$)/.test(path);
}
router.use(async(req,res,next)=>{
  try{
    await migrateLegacyGroups();
    // API keys are already fail-closed by the integration allowlist and are
    // not valid Dispatch operator credentials.
    if(req.apiKey)return res.status(403).json({error:'API keys cannot operate internal Dispatch workflows',control:'dispatch_rbac'});
    if(!req.employee)return next();
    const p=req.path;
    // Department-owned commercial handoffs keep their own Purchasing/Sales/
    // Rental/Repair permissions in the underlying handler. They do not need
    // Dispatch planning authority merely to submit work to the queue.
    if(sourceHandoff(p))return next();
    if(req.method==='GET'||req.method==='HEAD'){
      if(sourceDocument(p)&&any(req,'dispatch_view','purchasing','transactions','rentals','work_orders'))return next();
      if(any(req,'dispatch_view','dispatch_plan','dispatch_execute','dispatch_admin'))return next();
      return deny(res,'dispatch_view');
    }
    if(administration(p)){
      if(any(req,'dispatch_admin'))return next();
      return deny(res,'dispatch_admin');
    }
    if(fieldExecution(p)){
      if(any(req,'dispatch_execute','dispatch_plan','dispatch_admin'))return next();
      return deny(res,'dispatch_execute');
    }
    if(planning(p)){
      if(any(req,'dispatch_plan','dispatch_admin'))return next();
      return deny(res,'dispatch_plan');
    }
    // Unknown Dispatch mutations fail closed rather than inheriting the old
    // transfers permission. New logistics endpoints must be classified here.
    return res.status(403).json({error:'Dispatch mutation is not classified for RBAC',control:'dispatch_rbac_unclassified'});
  }catch(e){res.status(500).json({error:'Dispatch permission guard failed',detail:e.message});}
});
module.exports=router;
module.exports.migrateLegacyGroups=migrateLegacyGroups;
