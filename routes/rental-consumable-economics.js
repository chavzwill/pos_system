'use strict';
const router=require('express').Router(),crypto=require('node:crypto');
const {db}=require('../database'),{can}=require('../lib/permissions');
const {ensureCostReviewSchema,readAssetCosts,stmt,fail,cents,integer}=require('../lib/rental-consumable-economics');
function id(v){const n=Number(v);if(!Number.isSafeInteger(n)||n<1)throw fail('INVALID_ID','Select a positive source ID',400);return n;}
function staff(req){if(!req.employee?.id)throw fail('AUTHENTICATION_REQUIRED','Staff session required',401);if(req.apiKey)throw fail('STAFF_ONLY','Staff session required',403);}
function branch(req,a){const p=req.employee.permissions,home=Number(req.employee.default_branch_id);if(!can(p,'branches')&&!can(p,'security_manage')&&(!Number.isSafeInteger(home)||home<1||home!==Number(a.branch_id)))throw fail('BRANCH_FORBIDDEN','Use your assigned branch or cross-branch authority',403);return a;}
function read(req){staff(req);if(!['reports','rentals','reports_financial'].some(p=>can(req.employee.permissions,p)))throw fail('PERMISSION_DENIED','Rental reporting permission required',403);}
async function asset(ex,req,value){const a=(await ex.execute(stmt('SELECT * FROM rental_assets WHERE id=?',[id(value)]))).rows[0];if(!a)throw fail('ASSET_NOT_FOUND','Rental asset not found',404);return branch(req,a);}
function error(res,e){res.status(e.status||500).json({error:e.status?e.message:'Unable to review rental asset costs',code:e.code||'ASSET_COST_FAILED'});}
router.get('/assets/:id/cost-evidence',async(req,res)=>{try{read(req);const a=await asset(db,req,req.params.id),data=(await readAssetCosts(db,a)).get(Number(a.id));res.json({asset:{id:a.id,asset_number:a.asset_number,branch_id:a.branch_id},...data});}catch(e){error(res,e);}});
function reviewSource(type){return async(req,res)=>{
 let tx;try{
  staff(req);if(!can(req.employee.permissions,'reports_financial'))throw fail('PERMISSION_DENIED','Finance permission required',403);
  const key=String(req.get('Idempotency-Key')||'');if(!/^[\w:.-]{12,160}$/.test(key))throw fail('IDEMPOTENCY_KEY_REQUIRED','A stable operation key is required',400);
  // Initialize only review storage, never receiving, inventory or accounting modules.
  await ensureCostReviewSchema();tx=await db.transaction('write');const a=await asset(tx,req,req.params.id),mid=id(req.params.sourceId);
  const m=(await tx.execute(stmt(type==='maintenance'?'SELECT * FROM rental_asset_maintenance WHERE id=? AND asset_id=?':"SELECT *,amount direct_cost FROM rental_asset_economic_events WHERE id=? AND asset_id=? AND event_type IN ('other_direct_cost','unrecovered_damage_loss')",[mid,a.id]))).rows[0];if(!m)throw fail('MAINTENANCE_NOT_FOUND','Maintenance source not found',404);
  const op='asset-cost:'+type+':'+a.id+':'+mid+':'+key,hash=crypto.createHash('sha256').update(JSON.stringify({actor:req.employee.id,body:req.body})).digest('hex');
  const prior=(await tx.execute(stmt('SELECT * FROM rental_asset_cost_review_operations WHERE operation_key=?',[op]))).rows[0];
  if(prior){if(prior.fingerprint!==hash)throw fail('IDEMPOTENCY_CONFLICT','Operation key was used with different content');await tx.commit();tx=null;return res.json({...JSON.parse(prior.response_json),replayed:true});}
  if(!Number.isSafeInteger(req.body.recorded_cost_cents)||!Number.isSafeInteger(req.body.non_consumable_cost_cents))throw fail('INVALID_COST_SPLIT','Cost values must be integer cents',400);
  const recorded=integer(req.body.recorded_cost_cents),external=integer(req.body.non_consumable_cost_cents);
  if(req.body.recorded_cost_cents==null||req.body.non_consumable_cost_cents==null||external>recorded)throw fail('INVALID_COST_SPLIT','External maintenance must be between zero and the recorded cost',400);
  const latest=(await tx.execute(stmt('SELECT id FROM rental_asset_cost_reviews WHERE source_type=? AND source_id=? ORDER BY id DESC LIMIT 1',[type,mid]))).rows[0];
  const expected=req.body.expected_review_id==null?null:id(req.body.expected_review_id);
  if(cents(m.direct_cost)!==recorded||(latest?Number(latest.id):null)!==expected)throw fail('STALE_COST_REVIEW','Maintenance cost or review changed. Refresh the original evidence before reviewing again');
  const reason=String(req.body.reason||'').trim(),evidence=String(req.body.evidence_ref||'').trim();
  if(reason.length<10||reason.length>1000||evidence.length<3||evidence.length>500||['unknown','none','n/a','tbd'].includes(evidence.toLowerCase()))throw fail('EVIDENCE_REQUIRED','Provide a meaningful reason and source reference for this cost split',400);
  const inserted=await tx.execute(stmt('INSERT INTO rental_asset_cost_reviews(asset_id,source_type,source_id,recorded_cost_cents,non_consumable_cost_cents,previous_review_id,reason,evidence_ref,actor_employee_id) VALUES(?,?,?,?,?,?,?,?,?)',[a.id,type,mid,recorded,external,latest?.id||null,reason,evidence,req.employee.id]));
  const row=(await tx.execute(stmt('SELECT * FROM rental_asset_cost_reviews WHERE id=?',[Number(inserted.lastInsertRowid)]))).rows[0];
  await tx.execute(stmt('INSERT INTO rental_asset_cost_review_operations(operation_key,fingerprint,response_json) VALUES(?,?,?)',[op,hash,JSON.stringify(row)]));await tx.commit();tx=null;res.json(row);
 }catch(e){if(tx)await tx.rollback().catch(()=>{});error(res,e);}
};}
router.post('/assets/:id/maintenance/:sourceId/cost-review',reviewSource('maintenance'));
router.post('/assets/:id/economic-events/:sourceId/cost-review',reviewSource('economic_event'));
module.exports=router;
module.exports.authorizeRead=read;
module.exports.assertBranch=branch;
