'use strict';
const { db } = require('../database');

let readyPromise=null;
async function ensureSecurityAuditTable(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await db.execute({sql:`CREATE TABLE IF NOT EXISTS security_audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_employee_id INTEGER,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id INTEGER,
      old_value TEXT,
      new_value TEXT,
      reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,args:[]});
    const {rows:cols}=await db.execute({sql:'PRAGMA table_info(security_audit_events)',args:[]});
    const names=new Set(cols.map(x=>String(x.name)));
    const additions=[['request_id','TEXT'],['method','TEXT'],['path','TEXT'],['control','TEXT']];
    for(const [name,type] of additions)if(!names.has(name))await db.execute({sql:`ALTER TABLE security_audit_events ADD COLUMN ${name} ${type}`,args:[]});
    await db.execute({sql:'CREATE INDEX IF NOT EXISTS idx_security_audit_actor_created ON security_audit_events(actor_employee_id,created_at)',args:[]});
    await db.execute({sql:'CREATE INDEX IF NOT EXISTS idx_security_audit_action_created ON security_audit_events(action,created_at)',args:[]});
  })().catch(error=>{readyPromise=null;throw error;});
  return readyPromise;
}
function cleanPath(req){return String(req?.originalUrl||req?.path||'').split('?')[0].slice(0,500);}
function safeJson(value){try{return value==null?null:JSON.stringify(value);}catch(_){return null;}}
async function recordSecurityAudit({actorEmployeeId=null,action,targetType='route',targetId=null,oldValue=null,newValue=null,reason=null,requestId=null,method=null,path=null,control=null,executor=db}={}){
  await ensureSecurityAuditTable();
  const target=executor&&typeof executor.execute==='function'?executor:db;
  await target.execute({sql:`INSERT INTO security_audit_events(actor_employee_id,action,target_type,target_id,old_value,new_value,reason,request_id,method,path,control) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,args:[actorEmployeeId||null,String(action||'security_event').slice(0,120),String(targetType||'route').slice(0,80),targetId||null,safeJson(oldValue),safeJson(newValue),reason==null?null:String(reason).slice(0,500),requestId==null?null:String(requestId).slice(0,128),method==null?null:String(method).slice(0,16),path==null?null:String(path).slice(0,500),control==null?null:String(control).slice(0,120)]});
}
function auditPermissionDenied(req,{requiredPermissions=[],control='rbac',reason='Authenticated request denied by permission policy'}={}){
  if(!req?.employee?.id)return Promise.resolve();
  const required=Array.isArray(requiredPermissions)?requiredPermissions.filter(Boolean).map(String):[String(requiredPermissions||'')].filter(Boolean);
  return recordSecurityAudit({
    actorEmployeeId:req.employee.id,
    action:'permission_denied',
    targetType:'route',
    newValue:{required_permissions:required},
    reason,
    requestId:req.requestId||null,
    method:req.method||null,
    path:cleanPath(req),
    control,
  }).catch(()=>{});
}
function auditApiKeyDenied(req,{apiKeyId=null,apiKeyName=null,requiredScope=null,control='api_key_scope'}={}){
  if(!apiKeyId)return Promise.resolve();
  return recordSecurityAudit({
    action:'api_key_denied',
    targetType:'api_key',
    targetId:apiKeyId,
    newValue:{api_key_name:apiKeyName||null,required_scope:requiredScope||null},
    reason:'Authenticated integration key denied by scope or endpoint policy',
    requestId:req?.requestId||null,
    method:req?.method||null,
    path:cleanPath(req),
    control,
  }).catch(()=>{});
}
module.exports={ensureSecurityAuditTable,recordSecurityAudit,auditPermissionDenied,auditApiKeyDenied};
