'use strict';
const router=require('express').Router();
const {db}=require('../database');
const {can}=require('../lib/permissions');
const TTL=7*24*60*60*1000,MAX_BYTES=256*1024,MAX_DRAFTS=20;
let schema;
function allowed(employee,key){return key==='purchasing-pr'?can(employee.permissions,'pr_create'):key==='purchasing-po'?can(employee.permissions,'purchasing_create'):key.startsWith('receiving-')?can(employee.permissions,'purchasing_receive'):can(employee.permissions,'purchasing_receive')||can(employee.permissions,'reports_financial');}
function validKey(key){return /^(?:purchasing-(?:po|pr)|(?:receiving|invoice)-[1-9]\d{0,14})$/.test(key);}
function ensure(){if(!schema)schema=db.execute({sql:`CREATE TABLE IF NOT EXISTS purchasing_work_drafts (
 employee_id INTEGER NOT NULL,branch_id INTEGER NOT NULL,draft_key TEXT NOT NULL,
 payload TEXT,revision INTEGER NOT NULL,expires_at INTEGER NOT NULL,
 PRIMARY KEY(employee_id,branch_id,draft_key))`,args:[]}).catch(e=>{schema=null;throw e;});return schema;}
router.use(async(req,res,next)=>{res.set('Cache-Control','private, no-store');if(!req.employee||req.apiKey)return res.status(401).json({error:'A signed-in employee is required'});if(!Number.isSafeInteger(Number(req.employee.default_branch_id))||Number(req.employee.default_branch_id)<1)return res.status(403).json({error:'An assigned branch is required for saved drafts'});if(req.get('X-TT-Draft-Owner')!==String(req.employee.id)+':'+String(req.employee.default_branch_id))return res.status(409).json({error:'The signed-in employee or branch changed. Reopen the app before continuing.',code:'DRAFT_OWNER_CHANGED'});if(!['purchase_requests','pr_create','purchasing','purchasing_create','purchasing_receive','reports_financial'].some(key=>can(req.employee.permissions,key)))return res.status(403).json({error:'Missing purchasing draft permission'});try{await ensure();next();}catch(e){res.status(503).json({error:'Draft storage is unavailable. Your business submission has not been sent.'});}});
router.get('/',async(req,res)=>{try{await db.execute({sql:'UPDATE purchasing_work_drafts SET payload=NULL WHERE employee_id=? AND branch_id=? AND expires_at<=? AND payload IS NOT NULL',args:[req.employee.id,req.employee.default_branch_id,Date.now()]});const {rows}=await db.execute({sql:'SELECT draft_key,payload,revision,expires_at FROM purchasing_work_drafts WHERE employee_id=? AND branch_id=?',args:[req.employee.id,req.employee.default_branch_id]});res.json({drafts:rows.filter(x=>allowed(req.employee,x.draft_key)).map(x=>({key:x.draft_key,value:x.payload&&Number(x.expires_at)>Date.now()?JSON.parse(x.payload):null,revision:Number(x.revision),expires_at:Number(x.expires_at)}))});}catch(e){res.status(503).json({error:'Unable to load saved drafts'});}});
async function mutate(req,res,remove){const key=req.params.key,revision=req.body?.revision,value=req.body?.value;if(!validKey(key))return res.status(400).json({error:'Invalid purchasing draft key'});if(!allowed(req.employee,key))return res.status(403).json({error:'Missing permission for this draft'});if(!Number.isSafeInteger(revision)||revision<0||revision>=Number.MAX_SAFE_INTEGER)return res.status(400).json({error:'Invalid draft revision'});if(!remove&&(!value||typeof value!=='object'||Array.isArray(value)))return res.status(400).json({error:'Draft must be an object'});const payload=remove?null:JSON.stringify(value);if(payload&&Buffer.byteLength(payload)>MAX_BYTES)return res.status(413).json({error:'Draft is too large to save. Reduce the number of entries.'});const args=[req.employee.id,req.employee.default_branch_id,key];const expires=Date.now()+TTL;
 try{
  // A single atomic statement enforces revision and live-count limits across instances.
  const {rows}=await db.execute({sql:`INSERT INTO purchasing_work_drafts(employee_id,branch_id,draft_key,payload,revision,expires_at)
   SELECT ?,?,?,?,1,? WHERE EXISTS(SELECT 1 FROM purchasing_work_drafts WHERE employee_id=? AND branch_id=? AND draft_key=?) OR (?=0 AND (? IS NULL OR (SELECT COUNT(*) FROM purchasing_work_drafts WHERE employee_id=? AND branch_id=? AND payload IS NOT NULL AND expires_at>?)<?))
   ON CONFLICT(employee_id,branch_id,draft_key) DO UPDATE SET payload=excluded.payload,revision=purchasing_work_drafts.revision+1,expires_at=excluded.expires_at
   WHERE purchasing_work_drafts.revision=? AND (? IS NULL OR (purchasing_work_drafts.payload IS NOT NULL AND purchasing_work_drafts.expires_at>?) OR (SELECT COUNT(*) FROM purchasing_work_drafts WHERE employee_id=? AND branch_id=? AND payload IS NOT NULL AND expires_at>?)<?)
   RETURNING revision,expires_at`,args:[...args,payload,expires,...args,revision,payload,args[0],args[1],Date.now(),MAX_DRAFTS,revision,payload,Date.now(),args[0],args[1],Date.now(),MAX_DRAFTS]});
  if(rows.length)return res.json({revision:Number(rows[0].revision),expires_at:Number(rows[0].expires_at)});
  const {rows:[existing]}=await db.execute({sql:'SELECT revision FROM purchasing_work_drafts WHERE employee_id=? AND branch_id=? AND draft_key=?',args});
  if(Number(existing?.revision||0)!==revision)return res.status(409).json({error:'This draft changed in another tab. Reopen the app to load its latest version.',code:'DRAFT_CONFLICT'});
  return res.status(429).json({error:'You have 20 saved drafts. Finish or discard a draft before saving another.'});
 }catch(e){res.status(503).json({error:'Draft storage is unavailable. Business submission has not been sent.'});}
}
router.put('/:key',(req,res)=>mutate(req,res,false));
router.delete('/:key',(req,res)=>mutate(req,res,true));
module.exports=router;
