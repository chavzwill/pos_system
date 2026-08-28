'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {can,requireAnyPermission}=require('../lib/permissions');
const {nextNumber}=require('../lib/nextNumber');

let readyPromise=null;
const r2=v=>Number(Number(v||0).toFixed(2));
const TYPES=new Set(['labor_waiver','consumables_waiver','parts_waiver','goodwill_credit','free_replacement','service_recovery','other']);
async function ensureSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=db.batch([
    {sql:`CREATE TABLE IF NOT EXISTS service_concessions(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_order_id INTEGER NOT NULL REFERENCES work_orders(id),
      concession_type TEXT NOT NULL,
      proposed_amount REAL NOT NULL DEFAULT 0,
      approved_amount REAL NOT NULL DEFAULT 0,
      reason TEXT NOT NULL,
      customer_resolution TEXT,
      status TEXT NOT NULL DEFAULT 'pending_approval',
      created_by_employee_id INTEGER REFERENCES employees(id),
      approved_by_employee_id INTEGER REFERENCES employees(id),
      financial_authorizer_employee_id INTEGER REFERENCES employees(id),
      rejected_by_employee_id INTEGER REFERENCES employees(id),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      approved_at DATETIME,
      rejected_at DATETIME,
      rejection_reason TEXT,
      applied_transaction_id INTEGER REFERENCES transactions(id)
    )`},
    {sql:`CREATE TABLE IF NOT EXISTS service_concession_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      concession_id INTEGER NOT NULL REFERENCES service_concessions(id),
      event_type TEXT NOT NULL,
      employee_id INTEGER REFERENCES employees(id),
      details TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`},
    {sql:'CREATE INDEX IF NOT EXISTS idx_service_concession_work_order ON service_concessions(work_order_id,status,created_at)'},
    {sql:'CREATE INDEX IF NOT EXISTS idx_service_concession_status ON service_concessions(status,approved_at)'}
  ],'write').catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
async function authorizer(pin,actorId,creatorId){
  if(!String(pin||'').trim())return {error:'Independent management authorization is required for a service concession.'};
  const {rows}=await db.execute({sql:'SELECT e.id,e.pin,sg.permissions FROM employees e LEFT JOIN security_groups sg ON sg.id=e.security_group_id WHERE e.active=1',args:[]});
  const a=rows.find(e=>String(e.pin)===String(pin).trim()&&(()=>{let p={};try{p=JSON.parse(e.permissions||'{}')}catch{}return can(p,'reports_financial')||can(p,'security_manage')||can(p,'wo_signoff')||can(p,'work_orders_manage');})());
  if(!a)return {error:'Invalid management PIN or insufficient concession authority.'};
  if(actorId&&String(a.id)===String(actorId))return {error:'The concession reviewer cannot provide their own independent financial authorization.'};
  if(creatorId&&String(a.id)===String(creatorId))return {error:'The employee who proposed the concession cannot financially authorize it.'};
  return {authorizer:a};
}
async function workOrderFinancials(id,executor=db){
  const {rows:[wo]}=await executor.execute({sql:`SELECT wo.*,(SELECT COALESCE(SUM(total),0) FROM work_order_items WHERE work_order_id=wo.id) parts_total FROM work_orders wo WHERE wo.id=?`,args:[id]});
  if(!wo)return null;
  const gross=r2(Number(wo.estimate_labor||0)+Number(wo.estimate_consumables||0)+Number(wo.parts_total||0));
  const {rows:[c]}=await executor.execute({sql:`SELECT COALESCE(SUM(approved_amount),0) total FROM service_concessions WHERE work_order_id=? AND status='approved'`,args:[id]});
  const approved=r2(c?.total||0);
  return {wo,gross,approved,deposit:r2(wo.deposit_amount||0),balance:r2(Math.max(0,gross-approved-Number(wo.deposit_amount||0)))};
}
router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Service concession controls failed to initialize',detail:e.message});}});

router.get('/:id/concessions',requireAnyPermission('work_orders','wo_assess','reports_financial'),async(req,res)=>{
  try{
    const f=await workOrderFinancials(req.params.id);if(!f)return res.status(404).json({error:'Work order not found'});
    const {rows}=await db.execute({sql:`SELECT sc.*,ce.first_name||' '||ce.last_name created_by_name,ae.first_name||' '||ae.last_name approved_by_name,fa.first_name||' '||fa.last_name financial_authorizer_name FROM service_concessions sc LEFT JOIN employees ce ON ce.id=sc.created_by_employee_id LEFT JOIN employees ae ON ae.id=sc.approved_by_employee_id LEFT JOIN employees fa ON fa.id=sc.financial_authorizer_employee_id WHERE sc.work_order_id=? ORDER BY sc.created_at DESC,sc.id DESC`,args:[req.params.id]});
    res.json({work_order_id:Number(req.params.id),gross_service_total:f.gross,deposit:f.deposit,approved_concession_total:f.approved,balance_after_concessions:f.balance,concessions:rows});
  }catch(e){res.status(500).json({error:e.message});}
});

router.post('/:id/concessions',requireAnyPermission('work_orders','wo_assess'),async(req,res)=>{
  try{
    const type=String(req.body?.concession_type||'').trim(),amount=r2(req.body?.proposed_amount),reason=String(req.body?.reason||'').trim(),resolution=String(req.body?.customer_resolution||'').trim();
    if(!TYPES.has(type))return res.status(400).json({error:'Choose a valid concession type.'});
    if(!(amount>0))return res.status(400).json({error:'A positive proposed concession amount is required.'});
    if(reason.length<8)return res.status(400).json({error:'Document why the concession is commercially justified.'});
    const f=await workOrderFinancials(req.params.id);if(!f)return res.status(404).json({error:'Work order not found'});
    if(['picked_up','cancelled'].includes(String(f.wo.status)))return res.status(409).json({error:`A concession cannot be proposed after the work order is ${f.wo.status}.`});
    if(amount>f.gross+0.01)return res.status(409).json({error:`The proposed concession cannot exceed the current service value (${f.gross.toFixed(2)}).`});
    const result=await db.execute({sql:`INSERT INTO service_concessions(work_order_id,concession_type,proposed_amount,reason,customer_resolution,created_by_employee_id) VALUES(?,?,?,?,?,?)`,args:[req.params.id,type,amount,reason,resolution||null,req.employee?.id||req.body?.employee_id||null]});
    const id=Number(result.lastInsertRowid);await db.execute({sql:'INSERT INTO service_concession_events(concession_id,event_type,employee_id,details) VALUES(?,?,?,?)',args:[id,'proposed',req.employee?.id||req.body?.employee_id||null,`${type}; proposed=${amount.toFixed(2)}; ${reason}`]});
    const {rows:[row]}=await db.execute({sql:'SELECT * FROM service_concessions WHERE id=?',args:[id]});res.status(201).json(row);
  }catch(e){res.status(500).json({error:e.message});}
});

router.post('/concessions/:concessionId/approve',requireAnyPermission('wo_signoff','reports_financial','work_orders_manage'),async(req,res)=>{
  try{
    const {rows:[c]}=await db.execute({sql:'SELECT * FROM service_concessions WHERE id=?',args:[req.params.concessionId]});if(!c)return res.status(404).json({error:'Service concession not found'});if(c.status!=='pending_approval')return res.status(409).json({error:'Concession is not pending approval'});
    const approvalReason=String(req.body?.approval_reason||'').trim();if(approvalReason.length<8)return res.status(400).json({error:'A meaningful approval reason is required.'});
    const actor=req.employee?.id||req.body?.employee_id||null,auth=await authorizer(req.body?.financial_authorizer_pin,actor,c.created_by_employee_id);if(auth.error)return res.status(409).json({error:auth.error,control:'service_concession_segregation'});
    const approved=r2(req.body?.approved_amount??c.proposed_amount);if(!(approved>0))return res.status(400).json({error:'Approved concession amount must be positive.'});
    const f=await workOrderFinancials(c.work_order_id);if(!f)return res.status(404).json({error:'Work order not found'});if(['picked_up','cancelled'].includes(String(f.wo.status)))return res.status(409).json({error:`Concession cannot be approved after the work order is ${f.wo.status}.`});
    if(f.approved+approved>f.gross+0.01)return res.status(409).json({error:'Approved concessions would exceed the current gross service value.'});
    await db.execute({sql:`UPDATE service_concessions SET status='approved',approved_amount=?,approved_by_employee_id=?,financial_authorizer_employee_id=?,approved_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending_approval'`,args:[approved,actor,auth.authorizer.id,c.id]});
    await db.execute({sql:'INSERT INTO service_concession_events(concession_id,event_type,employee_id,details) VALUES(?,?,?,?)',args:[c.id,'approved',actor,`approved=${approved.toFixed(2)}; ${approvalReason}`]});
    const {rows:[row]}=await db.execute({sql:'SELECT * FROM service_concessions WHERE id=?',args:[c.id]});res.json(row);
  }catch(e){res.status(500).json({error:e.message});}
});

router.post('/concessions/:concessionId/reject',requireAnyPermission('wo_signoff','reports_financial','work_orders_manage'),async(req,res)=>{
  try{const reason=String(req.body?.reason||'').trim();if(reason.length<8)return res.status(400).json({error:'A meaningful rejection reason is required.'});const actor=req.employee?.id||req.body?.employee_id||null;const r=await db.execute({sql:`UPDATE service_concessions SET status='rejected',rejected_by_employee_id=?,rejected_at=CURRENT_TIMESTAMP,rejection_reason=? WHERE id=? AND status='pending_approval'`,args:[actor,reason,req.params.concessionId]});if(!Number(r.rowsAffected||0))return res.status(409).json({error:'Concession is not pending approval'});await db.execute({sql:'INSERT INTO service_concession_events(concession_id,event_type,employee_id,details) VALUES(?,?,?,?)',args:[req.params.concessionId,'rejected',actor,reason]});res.json({success:true,status:'rejected'});}catch(e){res.status(500).json({error:e.message});}
});

// Registered before the legacy work-order router. This is the authoritative
// final-payment path whenever the hardening router is mounted first.
router.patch('/:id/final-payment',requireAnyPermission('wo_assess','pos'),async(req,res)=>{
  try{
    const {payment_method,amount_tendered,employee_id,drawer_session_id,branch_id}=req.body||{};
    const f=await workOrderFinancials(req.params.id);if(!f)return res.status(404).json({error:'Work order not found'});const wo=f.wo;if(wo.status!=='awaiting_pickup')return res.status(400).json({error:`This work order is ${wo.status}, not awaiting pickup`});
    const balance=f.balance,grossRemaining=r2(Math.max(0,f.gross-f.deposit)),concession=Math.min(f.approved,grossRemaining);
    const tx=await db.transaction('write');let committed=false;
    try{
      const {rows:[fresh]}=await tx.execute({sql:'SELECT status FROM work_orders WHERE id=?',args:[wo.id]});if(!fresh||fresh.status!=='awaiting_pickup')throw Object.assign(new Error('Work order status changed; reload before collecting payment.'),{status:409});
      let txId=null,transactionNumber=null;
      if(balance>0){
        const method=payment_method||'cash',tendered=Number(amount_tendered??balance);if(!Number.isFinite(tendered)||tendered+0.009<balance)throw Object.assign(new Error(`Amount tendered cannot be less than the final balance (${balance.toFixed(2)}).`),{status:409});
        if(method==='cash'&&drawer_session_id){const {rows:[drawer]}=await tx.execute({sql:`SELECT * FROM drawer_sessions WHERE id=? AND status='open'`,args:[drawer_session_id]});if(!drawer||Number(drawer.employee_id)!==Number(employee_id||req.employee?.id)||Number(drawer.branch_id)!==Number(branch_id||wo.branch_id))throw Object.assign(new Error('Cash payment requires the signed-in cashier’s open drawer at this work-order branch.'),{status:409});}
        transactionNumber=await nextNumber(tx,'transactions','transaction_number','TXN-',6);const change=r2(Math.max(0,tendered-balance));
        const tr=await tx.execute({sql:`INSERT INTO transactions(transaction_number,customer_id,employee_id,branch_id,drawer_session_id,subtotal,tax_amount,total,payment_method,amount_tendered,change_amount,notes,source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:[transactionNumber,wo.customer_id,employee_id||req.employee?.id||null,branch_id||wo.branch_id||null,method==='cash'?(drawer_session_id||null):null,balance,0,balance,method,tendered,change,`Work order final payment ${wo.wo_number}; approved concessions ${concession.toFixed(2)}`,'pos']});txId=Number(tr.lastInsertRowid);
        await tx.execute({sql:`INSERT INTO transaction_items(transaction_id,product_name,sku,quantity,unit_price,tax_amount,total) VALUES(?,?,?,?,?,?,?)`,args:[txId,'Work Order Balance Before Concessions','WO-FINAL-GROSS',1,grossRemaining,0,grossRemaining]});
        if(concession>0)await tx.execute({sql:`INSERT INTO transaction_items(transaction_id,product_name,sku,quantity,unit_price,tax_amount,total) VALUES(?,?,?,?,?,?,?)`,args:[txId,'Approved Service Concession','WO-CONCESSION',1,-concession,0,-concession]});
        await tx.execute({sql:`UPDATE service_concessions SET applied_transaction_id=? WHERE work_order_id=? AND status='approved' AND applied_transaction_id IS NULL`,args:[txId,wo.id]});
      }
      await tx.execute({sql:`UPDATE work_orders SET final_transaction_id=?,status='picked_up',picked_up_at=CURRENT_TIMESTAMP WHERE id=?`,args:[txId,wo.id]});
      await tx.execute({sql:`INSERT INTO work_order_status_log(work_order_id,status,comment,employee_id) VALUES(?,?,?,?)`,args:[wo.id,'picked_up',balance>0?`Final payment collected (${payment_method||'cash'}) — ${balance.toFixed(2)} after approved concessions of ${concession.toFixed(2)}`:`Item picked up — no balance due after approved concessions of ${concession.toFixed(2)}`,employee_id||req.employee?.id||null]});
      await tx.commit();committed=true;
      res.json({...wo,status:'picked_up',final_transaction_id:txId,concession_total:concession,final_balance_collected:balance,transaction_number:transactionNumber});
    }catch(e){if(!committed)await tx.rollback();throw e;}
  }catch(e){res.status(e.status||500).json({error:e.message});}
});

module.exports=router;
