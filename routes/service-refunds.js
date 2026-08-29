'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {can,requireAnyPermission}=require('../lib/permissions');
const {nextNumber}=require('../lib/nextNumber');
const {ensureLedger,postSourceJournal}=require('../lib/accounting-posting');

let readyPromise=null;
const r2=v=>Number(Number(v||0).toFixed(2));
const METHODS=new Set(['cash','account_credit','card','direct_deposit','check']);
const methodClass=v=>{const m=String(v||'').toLowerCase();if(m.includes('cash'))return'cash';if(m.includes('card')||m.includes('visa')||m.includes('master')||m.includes('amex'))return'card';if(m.includes('direct')||m.includes('bank')||m.includes('transfer'))return'direct_deposit';if(m.includes('check')||m.includes('cheque'))return'check';if(m.includes('credit')||m.includes('account'))return'account_credit';return m;};
async function ensureSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await ensureLedger();
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS service_refunds(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_order_id INTEGER NOT NULL REFERENCES work_orders(id),
        original_transaction_id INTEGER NOT NULL REFERENCES transactions(id),
        refund_amount REAL NOT NULL,
        refund_method TEXT NOT NULL,
        reason TEXT NOT NULL,
        evidence_reference TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending_approval',
        created_by_employee_id INTEGER REFERENCES employees(id),
        approved_by_employee_id INTEGER REFERENCES employees(id),
        financial_authorizer_employee_id INTEGER REFERENCES employees(id),
        rejected_by_employee_id INTEGER REFERENCES employees(id),
        refund_transaction_id INTEGER REFERENCES transactions(id),
        external_refund_reference TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        approved_at DATETIME,
        settled_at DATETIME,
        rejected_at DATETIME,
        rejection_reason TEXT
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS service_refund_events(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        service_refund_id INTEGER NOT NULL REFERENCES service_refunds(id),
        event_type TEXT NOT NULL,
        employee_id INTEGER REFERENCES employees(id),
        details TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:'CREATE INDEX IF NOT EXISTS idx_service_refund_work_order ON service_refunds(work_order_id,status,created_at)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_service_refund_original_tx ON service_refunds(original_transaction_id,status)'},
      {sql:'CREATE UNIQUE INDEX IF NOT EXISTS idx_service_refund_external_reference ON service_refunds(external_refund_reference) WHERE external_refund_reference IS NOT NULL'}
    ],'write');
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
async function independentAuthorizer(pin,actorId,creatorId){
  if(!String(pin||'').trim())return {error:'Independent financial authorization is required before approving a service refund.'};
  const {rows}=await db.execute({sql:'SELECT e.id,e.pin,sg.permissions FROM employees e LEFT JOIN security_groups sg ON sg.id=e.security_group_id WHERE e.active=1',args:[]});
  const a=rows.find(e=>String(e.pin)===String(pin).trim()&&(()=>{let p={};try{p=JSON.parse(e.permissions||'{}')}catch{}return can(p,'reports_financial')||can(p,'security_manage')||can(p,'wo_signoff')||can(p,'work_orders_manage');})());
  if(!a)return {error:'Invalid management PIN or insufficient refund authority.'};
  if(actorId&&String(a.id)===String(actorId))return {error:'The refund reviewer cannot provide their own independent financial authorization.'};
  if(creatorId&&String(a.id)===String(creatorId))return {error:'The employee who proposed the refund cannot financially authorize it.'};
  return {authorizer:a};
}
async function linkedPayments(workOrderId,executor=db){
  const {rows:[wo]}=await executor.execute({sql:'SELECT * FROM work_orders WHERE id=?',args:[workOrderId]});
  if(!wo)return null;
  const ids=[wo.assessment_transaction_id,wo.deposit_transaction_id,wo.final_transaction_id].filter(Boolean);
  if(!ids.length)return {wo,payments:[]};
  const ph=ids.map(()=>'?').join(',');
  const {rows}=await executor.execute({sql:`SELECT id,transaction_number,total,payment_method,created_at,status,notes FROM transactions WHERE id IN (${ph}) ORDER BY created_at,id`,args:ids});
  const payments=[];
  for(const t of rows){
    const {rows:[sum]}=await executor.execute({sql:`SELECT COALESCE(SUM(refund_amount),0) total FROM service_refunds WHERE original_transaction_id=? AND status IN ('approved','settled')`,args:[t.id]});
    const refunded=r2(sum?.total||0),paid=r2(t.total||0);
    payments.push({...t,refunded_amount:refunded,refundable_amount:r2(Math.max(0,paid-refunded))});
  }
  return {wo,payments};
}
function refundCreditCode(method){if(method==='cash')return '1000';if(method==='account_credit')return '2300';return '1050';}
router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Service refund controls failed to initialize',detail:e.message});}});

router.get('/:id/refunds',requireAnyPermission('work_orders','wo_assess','reports_financial','pos'),async(req,res)=>{
  try{
    const linked=await linkedPayments(req.params.id);if(!linked)return res.status(404).json({error:'Work order not found'});
    const {rows}=await db.execute({sql:`SELECT sr.*,t.transaction_number original_transaction_number,t.total original_transaction_total,t.payment_method original_payment_method,ce.first_name||' '||ce.last_name created_by_name,ae.first_name||' '||ae.last_name approved_by_name,fa.first_name||' '||fa.last_name financial_authorizer_name,rt.transaction_number refund_transaction_number FROM service_refunds sr JOIN transactions t ON t.id=sr.original_transaction_id LEFT JOIN transactions rt ON rt.id=sr.refund_transaction_id LEFT JOIN employees ce ON ce.id=sr.created_by_employee_id LEFT JOIN employees ae ON ae.id=sr.approved_by_employee_id LEFT JOIN employees fa ON fa.id=sr.financial_authorizer_employee_id WHERE sr.work_order_id=? ORDER BY sr.created_at DESC,sr.id DESC`,args:[req.params.id]});
    res.json({work_order_id:Number(req.params.id),payments:linked.payments,refunds:rows});
  }catch(e){res.status(500).json({error:e.message});}
});

router.post('/:id/refunds',requireAnyPermission('work_orders','wo_assess','pos'),async(req,res)=>{
  try{
    const originalId=Number(req.body?.original_transaction_id),amount=r2(req.body?.refund_amount),method=String(req.body?.refund_method||'').toLowerCase(),reason=String(req.body?.reason||'').trim(),evidence=String(req.body?.evidence_reference||'').trim();
    if(!originalId||!(amount>0))return res.status(400).json({error:'Original payment and a positive refund amount are required.'});
    if(!METHODS.has(method))return res.status(400).json({error:'Choose a supported refund method.'});
    if(reason.length<8||evidence.length<3)return res.status(400).json({error:'A meaningful refund reason and supporting evidence/reference are required.'});
    const linked=await linkedPayments(req.params.id);if(!linked)return res.status(404).json({error:'Work order not found'});
    const p=linked.payments.find(x=>Number(x.id)===originalId);if(!p)return res.status(409).json({error:'Refund must be linked to an actual payment from this work order.'});
    if(p.status==='voided')return res.status(409).json({error:'A voided original payment cannot be refunded.'});
    if(amount>Number(p.refundable_amount)+0.01)return res.status(409).json({error:`Refund exceeds the remaining refundable amount (${Number(p.refundable_amount).toFixed(2)}).`});
    const originalClass=methodClass(p.payment_method);
    if(method!=='account_credit'&&method!==originalClass)return res.status(409).json({error:`Refund method must return value to the original tender (${originalClass||p.payment_method}) or to controlled customer account credit. Cash substitution for a non-cash payment is not allowed.`});
    const result=await db.execute({sql:`INSERT INTO service_refunds(work_order_id,original_transaction_id,refund_amount,refund_method,reason,evidence_reference,created_by_employee_id) VALUES(?,?,?,?,?,?,?)`,args:[req.params.id,originalId,amount,method,reason,evidence,req.employee?.id||req.body?.employee_id||null]});
    const id=Number(result.lastInsertRowid);await db.execute({sql:'INSERT INTO service_refund_events(service_refund_id,event_type,employee_id,details) VALUES(?,?,?,?)',args:[id,'proposed',req.employee?.id||req.body?.employee_id||null,`refund=${amount.toFixed(2)}; method=${method}; original_tx=${p.transaction_number}; original_method=${p.payment_method}; ${reason}; evidence=${evidence}`]});
    const {rows:[row]}=await db.execute({sql:'SELECT * FROM service_refunds WHERE id=?',args:[id]});res.status(201).json(row);
  }catch(e){res.status(500).json({error:e.message});}
});

router.post('/refunds/:refundId/approve',requireAnyPermission('wo_signoff','reports_financial','work_orders_manage'),async(req,res)=>{
  try{
    const {rows:[r]}=await db.execute({sql:'SELECT * FROM service_refunds WHERE id=?',args:[req.params.refundId]});if(!r)return res.status(404).json({error:'Service refund not found'});if(r.status!=='pending_approval')return res.status(409).json({error:'Refund is not pending approval'});
    const approvalReason=String(req.body?.approval_reason||'').trim();if(approvalReason.length<8)return res.status(400).json({error:'A meaningful approval reason is required.'});
    const actor=req.employee?.id||req.body?.employee_id||null,auth=await independentAuthorizer(req.body?.financial_authorizer_pin,actor,r.created_by_employee_id);if(auth.error)return res.status(409).json({error:auth.error,control:'service_refund_segregation'});
    const linked=await linkedPayments(r.work_order_id);const p=linked?.payments?.find(x=>Number(x.id)===Number(r.original_transaction_id));if(!p)return res.status(409).json({error:'Original work-order payment is no longer available for refund review.'});
    if(Number(r.refund_amount)>Number(p.refundable_amount)+0.01)return res.status(409).json({error:`Another refund changed the available amount. Only ${Number(p.refundable_amount).toFixed(2)} remains refundable.`});
    await db.execute({sql:`UPDATE service_refunds SET status='approved',approved_by_employee_id=?,financial_authorizer_employee_id=?,approved_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending_approval'`,args:[actor,auth.authorizer.id,r.id]});
    await db.execute({sql:'INSERT INTO service_refund_events(service_refund_id,event_type,employee_id,details) VALUES(?,?,?,?)',args:[r.id,'approved',actor,approvalReason]});
    const {rows:[row]}=await db.execute({sql:'SELECT * FROM service_refunds WHERE id=?',args:[r.id]});res.json(row);
  }catch(e){res.status(500).json({error:e.message});}
});

router.post('/refunds/:refundId/reject',requireAnyPermission('wo_signoff','reports_financial','work_orders_manage'),async(req,res)=>{
  try{const reason=String(req.body?.reason||'').trim();if(reason.length<8)return res.status(400).json({error:'A meaningful rejection reason is required.'});const actor=req.employee?.id||req.body?.employee_id||null;const x=await db.execute({sql:`UPDATE service_refunds SET status='rejected',rejected_by_employee_id=?,rejected_at=CURRENT_TIMESTAMP,rejection_reason=? WHERE id=? AND status='pending_approval'`,args:[actor,reason,req.params.refundId]});if(!Number(x.rowsAffected||0))return res.status(409).json({error:'Refund is not pending approval'});await db.execute({sql:'INSERT INTO service_refund_events(service_refund_id,event_type,employee_id,details) VALUES(?,?,?,?)',args:[req.params.refundId,'rejected',actor,reason]});res.json({success:true,status:'rejected'});}catch(e){res.status(500).json({error:e.message});}
});

router.post('/refunds/:refundId/settle',requireAnyPermission('pos','reports_financial','wo_assess'),async(req,res)=>{
  try{
    const {rows:[r]}=await db.execute({sql:`SELECT sr.*,wo.customer_id,wo.branch_id,wo.wo_number,wo.status work_order_status,t.transaction_number original_transaction_number,t.payment_method original_payment_method FROM service_refunds sr JOIN work_orders wo ON wo.id=sr.work_order_id JOIN transactions t ON t.id=sr.original_transaction_id WHERE sr.id=?`,args:[req.params.refundId]});if(!r)return res.status(404).json({error:'Service refund not found'});if(r.status!=='approved')return res.status(409).json({error:`Refund is ${r.status}, not approved for settlement.`});
    const method=String(r.refund_method).toLowerCase(),actor=Number(req.body?.employee_id||req.employee?.id)||null,drawerId=Number(req.body?.drawer_session_id)||null,externalRef=String(req.body?.external_refund_reference||'').trim().toUpperCase();
    if(method==='cash'&&(!actor||!drawerId))return res.status(409).json({error:'Cash refund requires the cashier and an open drawer session.'});
    if(['card','direct_deposit','check'].includes(method)&&externalRef.length<3)return res.status(409).json({error:'Non-cash refund settlement requires the external refund/remittance reference proving the money was returned.'});
    if(externalRef){const {rows:[dup]}=await db.execute({sql:'SELECT id FROM service_refunds WHERE external_refund_reference=? AND id<>?',args:[externalRef,r.id]});if(dup)return res.status(409).json({error:'That external refund/remittance reference has already been used on another service refund.'});}
    const tx=await db.transaction('write');let committed=false;
    try{
      const {rows:[fresh]}=await tx.execute({sql:'SELECT * FROM service_refunds WHERE id=?',args:[r.id]});if(!fresh||fresh.status!=='approved'||fresh.refund_transaction_id)throw Object.assign(new Error('Refund status changed; reload before settlement.'),{status:409});
      if(method==='cash'){
        const {rows:[drawer]}=await tx.execute({sql:`SELECT * FROM drawer_sessions WHERE id=? AND status='open'`,args:[drawerId]});if(!drawer||Number(drawer.employee_id)!==actor||Number(drawer.branch_id)!==Number(r.branch_id))throw Object.assign(new Error('Cash refund requires the signed-in cashier’s open drawer at the work-order branch.'),{status:409});
      }
      if(externalRef){const {rows:[dup]}=await tx.execute({sql:'SELECT id FROM service_refunds WHERE external_refund_reference=? AND id<>?',args:[externalRef,r.id]});if(dup)throw Object.assign(new Error('External refund/remittance reference was used while this refund was being settled.'),{status:409});}
      const {rows:[sum]}=await tx.execute({sql:`SELECT COALESCE(SUM(refund_amount),0) total FROM service_refunds WHERE original_transaction_id=? AND status='settled'`,args:[r.original_transaction_id]});
      const {rows:[orig]}=await tx.execute({sql:'SELECT total FROM transactions WHERE id=?',args:[r.original_transaction_id]});if(Number(sum?.total||0)+Number(r.refund_amount)>Number(orig?.total||0)+0.01)throw Object.assign(new Error('Refund ceiling changed; cumulative refunds would exceed the original payment.'),{status:409});
      const number=await nextNumber(tx,'transactions','transaction_number','TXN-',6),amount=r2(r.refund_amount);
      const tr=await tx.execute({sql:`INSERT INTO transactions(transaction_number,customer_id,employee_id,branch_id,drawer_session_id,subtotal,tax_amount,total,payment_method,amount_tendered,change_amount,notes,source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:[number,r.customer_id,actor,r.branch_id,method==='cash'?drawerId:null,-amount,0,-amount,`service_refund_${method}`,-amount,0,`Service refund ${r.wo_number}; original ${r.original_transaction_number}; ${r.reason}`,'service_refund']});const refundTxId=Number(tr.lastInsertRowid);
      await tx.execute({sql:`INSERT INTO transaction_items(transaction_id,product_name,sku,quantity,unit_price,tax_amount,total) VALUES(?,?,?,?,?,?,?)`,args:[refundTxId,'Service Refund','WO-REFUND',1,-amount,0,-amount]});
      if(method==='account_credit')await tx.execute({sql:'UPDATE customers SET account_balance=account_balance-? WHERE id=?',args:[amount,r.customer_id]});
      const completed=['complete','awaiting_pickup','picked_up'].includes(String(r.work_order_status));
      let debitCode='4100',debitDescription='Reduce repair service revenue';
      if(!completed){const {rows:[wo]}=await tx.execute({sql:'SELECT deposit_transaction_id,assessment_transaction_id FROM work_orders WHERE id=?',args:[r.work_order_id]});if(Number(wo?.deposit_transaction_id)===Number(r.original_transaction_id)){debitCode='2200';debitDescription='Refund unapplied customer repair deposit';}else if(Number(wo?.assessment_transaction_id)===Number(r.original_transaction_id)){debitCode='4100';debitDescription='Reverse assessment service revenue';}}
      const creditCode=refundCreditCode(method),creditDescription=method==='cash'?'Cash refunded to customer':method==='account_credit'?'Create customer account/store credit':'External refund/remittance clearing';
      await postSourceJournal({sourceType:'service_refund',sourceId:r.id,sourceReference:`SR-${r.id}`,entryDate:new Date().toISOString().slice(0,10),description:`Service refund ${r.wo_number}`,branchId:r.branch_id,actorId:actor,executor:tx,lines:[{code:debitCode,debit:amount,credit:0,description:debitDescription},{code:creditCode,debit:0,credit:amount,description:creditDescription}]});
      await tx.execute({sql:`UPDATE service_refunds SET status='settled',refund_transaction_id=?,external_refund_reference=?,settled_at=CURRENT_TIMESTAMP WHERE id=? AND status='approved'`,args:[refundTxId,externalRef||null,r.id]});
      await tx.execute({sql:'INSERT INTO service_refund_events(service_refund_id,event_type,employee_id,details) VALUES(?,?,?,?)',args:[r.id,'settled',actor,`refund_tx=${number}; amount=${amount.toFixed(2)}; method=${method}; external_ref=${externalRef||'n/a'}`]});
      await tx.commit();committed=true;res.json({success:true,service_refund_id:r.id,refund_transaction_id:refundTxId,refund_transaction_number:number,amount,refund_method:method,external_refund_reference:externalRef||null});
    }catch(e){if(!committed)await tx.rollback();throw e;}
  }catch(e){res.status(e.status||500).json({error:e.message});}
});

module.exports=router;
