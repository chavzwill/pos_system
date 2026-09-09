'use strict';
const crypto=require('crypto');
const {db}=require('../database');

let readyPromise=null;
async function ensureSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=db.batch([
    {sql:`CREATE TABLE IF NOT EXISTS business_resource_locks (
      resource_key TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      acquired_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`},
    {sql:'CREATE INDEX IF NOT EXISTS idx_business_resource_locks_acquired ON business_resource_locks(acquired_at)'}
  ],'write').catch(error=>{readyPromise=null;throw error;});
  return readyPromise;
}
function normalizeKeys(value){
  const source=Array.isArray(value)?value:[value];
  return [...new Set(source.map(v=>String(v||'').trim()).filter(Boolean))].sort();
}
async function acquireOne(resourceKey,ttlSeconds){
  await ensureSchema();
  const token=crypto.randomBytes(18).toString('hex');
  const ttl=Math.max(15,Math.min(900,Number(ttlSeconds)||120));
  await db.execute({sql:`DELETE FROM business_resource_locks
    WHERE resource_key=? AND acquired_at < datetime('now','-' || ? || ' seconds')`,args:[resourceKey,ttl]});
  await db.execute({sql:'INSERT OR IGNORE INTO business_resource_locks(resource_key,token) VALUES(?,?)',args:[resourceKey,token]});
  const {rows:[row]}=await db.execute({sql:'SELECT token,acquired_at FROM business_resource_locks WHERE resource_key=?',args:[resourceKey]});
  if(!row||row.token!==token)return null;
  return {resourceKey,token};
}
async function releaseOne(lock){
  if(!lock)return;
  try{await db.execute({sql:'DELETE FROM business_resource_locks WHERE resource_key=? AND token=?',args:[lock.resourceKey,lock.token]});}catch(error){console.error('Unable to release business resource lock',lock.resourceKey,error&&error.message);}
}
async function acquireMany(keys,ttlSeconds){
  const locks=[];
  try{
    for(const key of normalizeKeys(keys)){
      const lock=await acquireOne(key,ttlSeconds);
      if(!lock){for(const held of locks.reverse())await releaseOne(held);return null;}
      locks.push(lock);
    }
    return locks;
  }catch(error){for(const held of locks.reverse())await releaseOne(held);throw error;}
}
async function releaseMany(locks){for(const lock of [...(locks||[])].reverse())await releaseOne(lock);}
function withLifecycleLocks(keysFn,{ttlSeconds=120,label='business operation'}={}){
  return async(req,res,next)=>{
    try{
      const keys=normalizeKeys(await keysFn(req));
      if(!keys.length)return next();
      const locks=await acquireMany(keys,ttlSeconds);
      if(!locks){
        res.setHeader('Retry-After','2');
        return res.status(409).json({error:`Another ${label} is already changing the same record. Wait for it to finish, then refresh before trying again.`,code:'lifecycle_operation_busy'});
      }
      let released=false;
      const release=()=>{if(released)return;released=true;void releaseMany(locks);};
      // Release only after a complete response. If the client disconnects before
      // finish, retain the lock until its bounded TTL because the server-side
      // mutation may still be committing and its outcome is ambiguous.
      res.once('finish',release);
      next();
    }catch(error){next(error);}
  };
}

module.exports={ensureSchema,withLifecycleLocks,acquireMany,releaseMany,normalizeKeys};
