'use strict';
const express=require('express'),crypto=require('node:crypto');
const {db}=require('../database');
const {requireAuth,can}=require('../lib/permissions');
const core=require('../lib/consumable-corrections'),recovery=require('../lib/consumable-recovery');
const {sql,fail}=core,router=express.Router();
function id(v){const n=Number(v);if(!Number.isSafeInteger(n)||n<1)throw fail('INVALID_ID','Select a positive source ID',400);return n;}
function reason(req){const s=String(req.body?.reason||'').trim();if(!s||s.length>1000)throw fail('REASON_REQUIRED','A reason of 1–1000 characters is required',400);return s;}
function has(req,p){return can(req.employee?.permissions,p);}
function demand(req,p){if(!p.split('|').some(x=>has(req,x)))throw fail('PERMISSION_DENIED','Permission required',403);}
function branch(req,row){if(!has(req,'branches')&&!has(req,'security_manage')&&(!req.employee.default_branch_id||Number(req.employee.default_branch_id)!==Number(row.branch_id)))throw fail('BRANCH_FORBIDDEN','An assigned matching branch or cross-branch authority is required',403);return row;}
function independent(req,row){if(Number(row.requested_by)===Number(req.employee.id))throw fail('SELF_APPROVAL','A different authorized employee must make this decision',403);}
function error(res,e){const conflict=/constraint|unique/i.test(e.message);res.status(e.status||(conflict?409:500)).json({error:e.status||conflict?e.message:'Unable to complete consumable recovery',code:e.code||'CONSUMABLE_RECOVERY_FAILED'});}
router.use(requireAuth,(req,res,next)=>req.apiKey||!req.employee?.id?res.status(403).json({error:'Staff session required'}):next());
router.use(async(req,res,next)=>{try{await recovery.ensureConsumableRecoverySchema();next();}catch(e){error(res,e);}});
function mutate(authorize,action){return async(req,res)=>{let tx;try{
 const key=String(req.get('Idempotency-Key')||'');if(!/^[\w:.-]{12,160}$/.test(key))throw fail('IDEMPOTENCY_KEY_REQUIRED','A stable Idempotency-Key of 12–160 safe characters is required',400);
 const op='recovery:'+req.method+':'+req.path+':'+key,hash=crypto.createHash('sha256').update(JSON.stringify({actor:req.employee.id,body:req.body||{}})).digest('hex');
 tx=await db.transaction('write');const source=await authorize(tx,req);const prior=(await tx.execute(sql('SELECT * FROM consumable_correction_operations WHERE operation_key=?',[op]))).rows[0];
 if(prior){if(prior.fingerprint!==hash)throw fail('IDEMPOTENCY_CONFLICT','This key was used with different content');await tx.commit();tx=null;return res.json({...JSON.parse(prior.response_json),replayed:true});}
 const result=await action(tx,req,source);await tx.execute(sql('INSERT INTO consumable_correction_operations(operation_key,fingerprint,response_json) VALUES(?,?,?)',[op,hash,JSON.stringify(result)]));await tx.commit();tx=null;res.json(result);
 }catch(e){if(tx)await tx.rollback().catch(()=>{});error(res,e);}};}
for(const action of ['cancel','reject'])router.post('/orders/:id/'+action,mutate(async(tx,req)=>{
 const row=(await tx.execute(sql('SELECT * FROM consumable_purchase_orders WHERE id=?',[id(req.params.id)]))).rows[0];if(!row)throw fail('PO_NOT_FOUND','Consumable order not found',404);branch(req,row);
 // Authorization uses immutable decision evidence on replay, before looking up the operation key.
 const prior=(await tx.execute(sql("SELECT event_type,details FROM consumable_order_events WHERE po_id=? AND event_type IN('cancelled','rejected') ORDER BY id DESC LIMIT 1",[row.id]))).rows[0];
 let original=row.status;if(row.status==='cancelled'&&prior){try{original=JSON.parse(prior.details).source_status;}catch{}}
 if(action==='reject'||['approved','partial','received'].includes(original)){demand(req,'purchasing_approve');independent(req,row);}else{demand(req,'purchasing_create');if(Number(row.requested_by)!==Number(req.employee.id))throw fail('REQUESTER_REQUIRED','Only the requester can cancel an unapproved order',403);}return row;
},async(tx,req,row)=>{
 if(action==='reject'?row.status!=='submitted':!['draft','submitted','approved'].includes(row.status))throw fail('INVALID_TRANSITION','Only eligible unreceived orders may be closed');
 const received=(await tx.execute(sql("SELECT 1 FROM consumable_po_lines WHERE po_id=? AND quantity_received>0 UNION ALL SELECT 1 FROM consumable_movements WHERE po_id=? AND action='receive' LIMIT 1",[row.id,row.id]))).rows[0];if(received)throw fail('ORDER_ALREADY_RECEIVED','An order with any received quantity cannot be closed');
 const why=reason(req);await tx.execute(sql("UPDATE consumable_purchase_orders SET status='cancelled' WHERE id=? AND status=?",[row.id,row.status]));await tx.execute(sql('INSERT INTO consumable_order_events(po_id,event_type,actor_employee_id,details) VALUES(?,?,?,?)',[row.id,action==='reject'?'rejected':'cancelled',req.employee.id,JSON.stringify({reason:why,source_status:row.status})]));return{id:row.id,status:'cancelled',closure_action:action==='reject'?'rejected':'cancelled',reason:why};
}));
for(const action of ['cancel','reject'])router.post('/returns/:id/'+action,mutate(async(tx,req)=>{
 const row=branch(req,await core.getReturn(tx,id(req.params.id)));
 if(action==='reject'||['approved','dispatched'].includes(row.source_status)){demand(req,'purchasing_approve');independent(req,row);}else{demand(req,'purchasing_create');if(Number(row.requested_by)!==Number(req.employee.id))throw fail('REQUESTER_REQUIRED','Only the requester can cancel an unapproved return',403);}return row;
},async(tx,req,row)=>{
 if(action==='reject'?row.status!=='requested':!['requested','approved'].includes(row.status))throw fail('INVALID_TRANSITION','Only eligible nondispatched returns may be closed');
 const status=action==='reject'?'rejected':'cancelled',why=reason(req);await tx.execute(sql("INSERT INTO consumable_document_closures(entity_type,entity_id,action,reason,actor_employee_id) VALUES('return',?,?,?,?)",[row.id,status,why,req.employee.id]));await core.event(tx,'return',row.id,status,req.employee.id,{reason:why});return core.getReturn(tx,row.id);
}));
router.post('/credits/:id/void',mutate(async(tx,req)=>{demand(req,'purchasing_receive|reports_financial');return branch(req,await core.getCredit(tx,id(req.params.id)));},async(tx,req,row)=>{
 if(row.status!=='captured')throw fail('INVALID_TRANSITION','Only captured credits may be voided');const why=reason(req);await tx.execute(sql("INSERT INTO consumable_document_closures(entity_type,entity_id,action,reason,actor_employee_id) VALUES('credit',?,'voided',?,?)",[row.id,why,req.employee.id]));await core.event(tx,'credit',row.id,'voided',req.employee.id,{reason:why});return core.getCredit(tx,row.id);
}));
router.post('/issues/:id/return',mutate(async(tx,req)=>{demand(req,'inventory_adjust');return branch(req,await recovery.issue(tx,id(req.params.id)));},(tx,req,m)=>recovery.returnUnused(tx,m,req.body.quantity,reason(req),req.employee.id)));
module.exports=router;
