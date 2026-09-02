const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { db } = require('../database');
const { hashKey } = require('../lib/apiKeyAuth');
const { requirePermission } = require('../lib/permissions');
const { ensureSecurityAuditTable, recordSecurityAudit } = require('../lib/securityAudit');

// API keys are integration credentials, not a general Settings feature.
// Only explicit integration-settings authority may create, rotate, edit or revoke them.
// apiKeyAuth independently blocks machine credentials from this employee-only route.
router.use(requirePermission('settings_integrations'));

const VALID_SCOPES = [
  'products:read', 'products:write',
  'customers:read', 'customers:write',
  'orders:read', 'orders:write',
  'repairs:read', 'repairs:write',
];

function validScopes(scopes){
  return Array.isArray(scopes) && scopes.length > 0 && scopes.every(s => VALID_SCOPES.includes(s));
}
function parseScopes(value){
  try { const parsed=JSON.parse(value||'[]'); return Array.isArray(parsed)?parsed:[]; }
  catch (_) { return []; }
}
function reasonFrom(req){ return String(req.body?.reason||'').trim(); }
function requireReason(req,res){
  const reason=reasonFrom(req);
  if(reason.length<8){res.status(400).json({error:'A reason is required for API credential changes'});return null;}
  return reason;
}
function publicState(row){
  if(!row)return null;
  return {
    id:Number(row.id),
    name:String(row.name||''),
    key_prefix:String(row.key_prefix||''),
    scopes:parseScopes(row.scopes),
    is_active:Number(row.is_active)!==0,
  };
}
function newCredential(name,scopes){
  const raw='pos_'+crypto.randomBytes(20).toString('hex');
  return {raw,prefix:raw.slice(0,12),hash:hashKey(raw),name:String(name).trim(),scopes};
}
async function audit(tx,req,action,id,oldValue,newValue,reason){
  await recordSecurityAudit({
    executor:tx,
    actorEmployeeId:req.employee?.id||null,
    action,
    targetType:'api_key',
    targetId:id||null,
    oldValue,
    newValue,
    reason,
    requestId:req.requestId||null,
    method:req.method||null,
    path:String(req.originalUrl||req.path||'').split('?')[0],
    control:'api_key_governance',
  });
}

router.get('/', async (req, res) => {
  try {
    const { rows } = await db.execute({
      sql: 'SELECT id, name, key_prefix, scopes, created_at, last_used_at, is_active FROM api_keys ORDER BY created_at DESC',
      args: [],
    });
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Unable to load API keys' }); }
});

router.post('/', async (req, res) => {
  const reason=requireReason(req,res);if(!reason)return;
  try {
    const { name, scopes = ['products:read'] } = req.body||{};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required' });
    if (!validScopes(scopes)) return res.status(400).json({ error: 'At least one valid explicit API scope is required' });
    const credential=newCredential(name,scopes);
    await ensureSecurityAuditTable();
    const tx=await db.transaction('write');
    try{
      const result=await tx.execute({
        sql:'INSERT INTO api_keys (name, key_prefix, key_hash, scopes) VALUES (?, ?, ?, ?)',
        args:[credential.name,credential.prefix,credential.hash,JSON.stringify(scopes)],
      });
      const id=Number(result.lastInsertRowid);
      await audit(tx,req,'api_key_created',id,null,{id,name:credential.name,key_prefix:credential.prefix,scopes,is_active:true},reason);
      await tx.commit();
      res.status(201).json({id,key:credential.raw,prefix:credential.prefix,name:credential.name,scopes});
    }catch(error){await tx.rollback().catch(()=>{});throw error;}
  } catch (e) { res.status(500).json({ error: 'Unable to create API key' }); }
});

router.post('/:id/rotate', async (req,res)=>{
  const reason=requireReason(req,res);if(!reason)return;
  try{
    await ensureSecurityAuditTable();
    const tx=await db.transaction('write');
    try{
      const {rows:[current]}=await tx.execute({sql:'SELECT id,name,key_prefix,scopes,is_active FROM api_keys WHERE id=?',args:[req.params.id]});
      if(!current){await tx.rollback().catch(()=>{});return res.status(404).json({error:'API key not found'});}
      if(Number(current.is_active)===0){await tx.rollback().catch(()=>{});return res.status(409).json({error:'Revoked API keys cannot be rotated. Create a new credential instead.'});}
      const scopes=parseScopes(current.scopes);
      if(!validScopes(scopes))throw new Error('Stored API key scopes are invalid');
      const credential=newCredential(current.name,scopes);
      await tx.execute({sql:'UPDATE api_keys SET key_prefix=?,key_hash=?,last_used_at=NULL WHERE id=?',args:[credential.prefix,credential.hash,current.id]});
      await audit(tx,req,'api_key_rotated',current.id,publicState(current),{...publicState(current),key_prefix:credential.prefix},reason);
      await tx.commit();
      res.json({id:Number(current.id),key:credential.raw,prefix:credential.prefix,name:current.name,scopes});
    }catch(error){await tx.rollback().catch(()=>{});throw error;}
  }catch(e){res.status(500).json({error:'Unable to rotate API key'});}
});

router.patch('/:id', async (req, res) => {
  const reason=requireReason(req,res);if(!reason)return;
  try {
    const { name, scopes, is_active } = req.body||{};
    if(name!==undefined&&!String(name||'').trim())return res.status(400).json({error:'Name cannot be empty'});
    if(scopes!==undefined&&!validScopes(scopes))return res.status(400).json({error:'At least one valid explicit API scope is required'});
    if(name===undefined&&scopes===undefined&&is_active===undefined)return res.status(400).json({error:'Nothing to update'});

    await ensureSecurityAuditTable();
    const tx=await db.transaction('write');
    try{
      const {rows:[current]}=await tx.execute({sql:'SELECT id,name,key_prefix,scopes,is_active FROM api_keys WHERE id=?',args:[req.params.id]});
      if(!current){await tx.rollback().catch(()=>{});return res.status(404).json({error:'API key not found'});}
      const next={...current};
      if(name!==undefined)next.name=String(name).trim();
      if(scopes!==undefined)next.scopes=JSON.stringify(scopes);
      if(is_active!==undefined)next.is_active=is_active?1:0;
      const oldState=publicState(current),newState=publicState(next);
      if(JSON.stringify(oldState)===JSON.stringify(newState)){
        await tx.rollback().catch(()=>{});return res.json({success:true,changed:false});
      }
      await tx.execute({sql:'UPDATE api_keys SET name=?,scopes=?,is_active=? WHERE id=?',args:[next.name,next.scopes,next.is_active,current.id]});
      const action=oldState.is_active&&!newState.is_active?'api_key_revoked':(!oldState.is_active&&newState.is_active?'api_key_reactivated':'api_key_updated');
      await audit(tx,req,action,current.id,oldState,newState,reason);
      await tx.commit();
      res.json({success:true,changed:true});
    }catch(error){await tx.rollback().catch(()=>{});throw error;}
  } catch (e) { res.status(500).json({ error: 'Unable to update API key' }); }
});

router.delete('/:id', async (req, res) => {
  const reason=requireReason(req,res);if(!reason)return;
  try {
    await ensureSecurityAuditTable();
    const tx=await db.transaction('write');
    try{
      const {rows:[current]}=await tx.execute({sql:'SELECT id,name,key_prefix,scopes,is_active FROM api_keys WHERE id=?',args:[req.params.id]});
      if(!current){await tx.rollback().catch(()=>{});return res.status(404).json({error:'API key not found'});}
      if(Number(current.is_active)===0){await tx.rollback().catch(()=>{});return res.json({success:true,changed:false});}
      await tx.execute({sql:'UPDATE api_keys SET is_active=0 WHERE id=?',args:[current.id]});
      await audit(tx,req,'api_key_revoked',current.id,publicState(current),{...publicState(current),is_active:false},reason);
      await tx.commit();
      res.json({success:true,changed:true});
    }catch(error){await tx.rollback().catch(()=>{});throw error;}
  } catch (e) { res.status(500).json({ error: 'Unable to revoke API key' }); }
});

module.exports = router;
