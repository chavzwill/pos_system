'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');
const {postSourceJournal,ensureLedger}=require('../lib/accounting-posting');

let readyPromise=null;
async function ensureSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await ensureLedger();
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS rental_refund_settlements(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agreement_id INTEGER NOT NULL UNIQUE REFERENCES rental_agreements(id),
        settlement_transaction_id INTEGER NOT NULL REFERENCES transactions(id),
        branch_id INTEGER REFERENCES branches(id),
        drawer_session_id INTEGER REFERENCES drawer_sessions(id),
        payment_method TEXT NOT NULL,
        amount REAL NOT NULL,
        reference_code TEXT,
        settled_by_employee_id INTEGER REFERENCES employees(id),
        settled_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:'CREATE INDEX IF NOT EXISTS idx_rental_refund_settlement_branch ON rental_refund_settlements(branch_id,settled_at)'}
    ],'write');
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Rental refund settlement initialization failed',detail:e.message});}});

router.post('/agreements/:id/refund-settle',requirePermission('transactions_refund'),async(req,res)=>{
  try{
    const agreementId=Number(req.params.id);
    const {rows:[agreement]}=await db.execute({sql:`SELECT ra.*,co.payment_method checkout_payment_method,se.total settlement_total,se.status settlement_status
      FROM rental_agreements ra LEFT JOIN transactions co ON co.id=ra.checkout_transaction_id LEFT JOIN transactions se ON se.id=ra.settlement_transaction_id
      WHERE ra.id=?`,args:[agreementId]});
    if(!agreement)return res.status(404).json({error:'Rental agreement not found'});
    if(agreement.status!=='returned')return res.status(409).json({error:'Rental must be fully returned before its refund can be settled'});
    if(!agreement.settlement_transaction_id||Number(agreement.settlement_total)>=-0.009)return res.status(409).json({error:'This rental has no external refund payable'});
    if(agreement.settlement_status==='voided')return res.status(409).json({error:'The rental settlement transaction is voided and cannot be refunded'});
    if(String(agreement.checkout_payment_method||'').toLowerCase()==='credit')return res.status(409).json({error:'Credit-account rental refunds are applied to the customer account, not paid through external refund settlement'});
    const {rows:[existing]}=await db.execute({sql:'SELECT * FROM rental_refund_settlements WHERE agreement_id=?',args:[agreementId]});
    if(existing)return res.json({...existing,replayed:true});

    const amount=Number((-Number(agreement.settlement_total)).toFixed(2));
    const method=String(req.body?.payment_method||agreement.checkout_payment_method||'').trim().toLowerCase();
    if(!['cash','card','bank_transfer','check'].includes(method))return res.status(400).json({error:'Unsupported rental refund method'});
    const original=String(agreement.checkout_payment_method||'').trim().toLowerCase();
    if(original&&method!==original)return res.status(409).json({error:`Rental refund must use the original tender method (${original})`});
    const reference=String(req.body?.reference_code||req.body?.approval_code||'').trim()||null;
    if(method!=='cash'&&!reference)return res.status(400).json({error:`${method} refund requires settlement/reference evidence`});

    let drawerSessionId=null;
    if(method==='cash'){
      if(!req.employee)return res.status(401).json({error:'Cash rental refunds require an authenticated employee'});
      const requested=Number(req.body?.drawer_session_id)||null;
      let drawer=null;
      if(requested){const {rows:[s]}=await db.execute({sql:"SELECT * FROM drawer_sessions WHERE id=? AND status='open'",args:[requested]});drawer=s||null;}
      else{const {rows:[s]}=await db.execute({sql:"SELECT * FROM drawer_sessions WHERE employee_id=? AND branch_id=? AND status='open' ORDER BY opened_at DESC LIMIT 1",args:[req.employee.id,agreement.branch_id]});drawer=s||null;}
      if(!drawer)return res.status(409).json({error:'Open the correct cash drawer before settling this rental refund'});
      if(Number(drawer.employee_id)!==Number(req.employee.id))return res.status(403).json({error:'Cash refund drawer belongs to another employee'});
      if(Number(drawer.branch_id)!==Number(agreement.branch_id))return res.status(409).json({error:'Cash refund drawer belongs to another branch'});
      drawerSessionId=drawer.id;
    }

    const tx=await db.transaction('write');let committed=false;
    try{
      if(drawerSessionId){const {rows:[live]}=await tx.execute({sql:"SELECT id FROM drawer_sessions WHERE id=? AND employee_id=? AND status='open'",args:[drawerSessionId,req.employee?.id||null]});if(!live)throw Object.assign(new Error('Cash drawer closed or changed before rental refund settlement'),{status:409});}
      const r=await tx.execute({sql:`INSERT INTO rental_refund_settlements(agreement_id,settlement_transaction_id,branch_id,drawer_session_id,payment_method,amount,reference_code,settled_by_employee_id)
        VALUES(?,?,?,?,?,?,?,?)`,args:[agreementId,agreement.settlement_transaction_id,agreement.branch_id||null,drawerSessionId,method,amount,reference,req.employee?.id||null]});
      const settlementId=Number(r.lastInsertRowid);
      await postSourceJournal({sourceType:'rental_refund_settlement',sourceId:settlementId,sourceReference:agreement.agreement_number,entryDate:new Date().toISOString().slice(0,10),description:`Rental refund paid ${agreement.agreement_number}`,branchId:agreement.branch_id,actorId:req.employee?.id||null,executor:tx,lines:[{code:'2400',debit:amount,credit:0,description:'Clear customer rental refund payable'},{code:method==='cash'?'1000':'1010',debit:0,credit:amount,description:method==='cash'?'Cash rental refund paid':'External rental refund paid'}]});
      await tx.commit();committed=true;
      const {rows:[saved]}=await db.execute({sql:'SELECT * FROM rental_refund_settlements WHERE id=?',args:[settlementId]});
      res.status(201).json(saved);
    }catch(e){if(!committed)await tx.rollback();res.status(e.status||400).json({error:e.message});}
  }catch(e){res.status(e.status||500).json({error:e.message});}
});

module.exports=router;
module.exports.ensureSchema=ensureSchema;
