'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {can,requirePermission}=require('../lib/permissions');
const {findEmployeeByPin}=require('../lib/pinAuth');
const {ensureLandedCostReconciliationSchema,reconcileSupplierInvoiceLandedCosts,capitalizableAmount}=require('../lib/landed-cost-reconciliation');
const {ensureSupplierRecoverablesSchema}=require('../lib/supplier-recoverables');
const creditNotes=require('./supplier-credit-notes');
const normalize=v=>String(v||'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'');
const money=v=>Number(Number(v||0).toFixed(2));
let readyPromise=null;
async function ensureSchema(){if(readyPromise)return readyPromise;readyPromise=(async()=>{await db.batch([
  {sql:`CREATE TABLE IF NOT EXISTS supplier_payment_override_events(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payment_id INTEGER NOT NULL UNIQUE REFERENCES supplier_payments(id),
    supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
    normalized_reference TEXT NOT NULL,
    prior_payment_ids TEXT NOT NULL,
    authorizer_employee_id INTEGER NOT NULL REFERENCES employees(id),
    reason TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`},
  {sql:'CREATE INDEX IF NOT EXISTS idx_supplier_payment_override_ref ON supplier_payment_override_events(supplier_id,normalized_reference,created_at)'},
  {sql:`CREATE TABLE IF NOT EXISTS supplier_payment_similarity_override_events(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payment_id INTEGER NOT NULL UNIQUE REFERENCES supplier_payments(id),
    supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
    payment_date DATE NOT NULL,
    amount REAL NOT NULL,
    trigger_type TEXT NOT NULL,
    prior_payment_ids TEXT NOT NULL,
    authorizer_employee_id INTEGER NOT NULL REFERENCES employees(id),
    reason TEXT NOT NULL,
    evidence_json TEXT NOT NULL DEFAULT '{}',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`},
  {sql:'CREATE INDEX IF NOT EXISTS idx_supplier_payment_similarity ON supplier_payment_similarity_override_events(supplier_id,payment_date,amount,created_at)'},
  {sql:`CREATE TABLE IF NOT EXISTS supplier_payment_credit_override_events(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payment_id INTEGER NOT NULL UNIQUE REFERENCES supplier_payments(id),
    supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
    payment_amount REAL NOT NULL,
    open_ap REAL NOT NULL DEFAULT 0,
    offset_ready_recoverables REAL NOT NULL DEFAULT 0,
    unmatched_credit_notes REAL NOT NULL DEFAULT 0,
    matched_unsettled_credit REAL NOT NULL DEFAULT 0,
    identified_unconfirmed_claims REAL NOT NULL DEFAULT 0,
    authorizer_employee_id INTEGER NOT NULL REFERENCES employees(id),
    reason TEXT NOT NULL,
    evidence_json TEXT NOT NULL DEFAULT '{}',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`},
  {sql:'CREATE INDEX IF NOT EXISTS idx_supplier_payment_credit_override ON supplier_payment_credit_override_events(supplier_id,created_at)'}
],'write');await ensureLandedCostReconciliationSchema();await ensureSupplierRecoverablesSchema();if(creditNotes.ensureSchema)await creditNotes.ensureSchema();})().catch(e=>{readyPromise=null;throw e;});return readyPromise;}
router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Supplier-payment loss-prevention initialization failed',detail:e.message});}});
router.use(require('./supplier-payment-operation-guard'));
async function settingNumber(key,fallback){const {rows:[r]}=await db.execute({sql:'SELECT value FROM settings WHERE key=?',args:[key]});const n=Number(r?.value);return Number.isFinite(n)?n:fallback;}
function dayDiff(a,b){const x=Date.parse(`${a}T00:00:00Z`),y=Date.parse(`${b}T00:00:00Z`);return Number.isFinite(x)&&Number.isFinite(y)?Math.abs(x-y)/86400000:Infinity;}
async function authorize(req,message){
  const reason=String(req.body?.duplicate_payment_override_reason||req.body?.payment_similarity_override_reason||'').trim();
  const pin=String(req.body?.duplicate_payment_override_pin||req.body?.payment_similarity_override_pin||'').trim();
  if(!pin)throw Object.assign(new Error(message),{status:409});
  if(reason.length<5)throw Object.assign(new Error('A meaningful supplier-payment override reason is required.'),{status:400});
  const {rows:employees}=await db.execute({sql:`SELECT e.id,e.first_name,e.last_name,e.pin,sg.permissions FROM employees e LEFT JOIN security_groups sg ON sg.id=e.security_group_id WHERE e.active=1`,args:[]});
  const authorizer=await findEmployeeByPin(employees,pin,e=>{let p={};try{p=JSON.parse(e.permissions||'{}');}catch{}return can(p,'reports_financial')||can(p,'security_manage');});
  if(!authorizer)throw Object.assign(new Error('Invalid supervisor PIN or insufficient supplier-payment approval authority.'),{status:403});
  if(req.employee&&String(req.employee.id)===String(authorizer.id))throw Object.assign(new Error('Independent supervisor authorization is required for a suspicious supplier payment.'),{status:403});
  return {authorizer,reason};
}
async function supplierCreditPosition(supplierId){
  const {rows:[ap]}=await db.execute({sql:`SELECT COALESCE(SUM(MAX(0,si.total-COALESCE(a.paid,0))),0) amount
    FROM supplier_invoices si
    LEFT JOIN (SELECT supplier_invoice_id,SUM(amount) paid FROM (
      SELECT supplier_invoice_id,amount FROM supplier_payment_allocations
      UNION ALL SELECT supplier_invoice_id,amount FROM supplier_recoverable_ap_allocations
    ) q GROUP BY supplier_invoice_id) a ON a.supplier_invoice_id=si.id
    WHERE si.supplier_id=? AND si.status!='void'`,args:[supplierId]});
  const {rows:[ready]}=await db.execute({sql:`SELECT COALESCE(SUM(MAX(0,c.confirmed_amount-c.recovered_amount)),0) amount
    FROM supplier_recoverable_claims c
    JOIN supplier_recoverable_accounting_basis b ON b.claim_id=c.id
    WHERE c.supplier_id=? AND c.status IN ('confirmed','partially_recovered')`,args:[supplierId]});
  const {rows:[unmatched]}=await db.execute({sql:`SELECT COALESCE(SUM(MAX(0,n.amount-n.applied_amount)),0) amount
    FROM supplier_credit_notes n WHERE n.supplier_id=?`,args:[supplierId]});
  const {rows:[matched]}=await db.execute({sql:`SELECT COALESCE(SUM(MAX(0,a.amount-a.settled_amount)),0) amount
    FROM supplier_credit_note_applications a
    JOIN supplier_credit_notes n ON n.id=a.credit_note_id
    WHERE n.supplier_id=?`,args:[supplierId]});
  const {rows:[identified]}=await db.execute({sql:`SELECT COALESCE(SUM(identified_amount),0) amount
    FROM supplier_recoverable_claims WHERE supplier_id=? AND status='identified'`,args:[supplierId]});
  const position={
    open_ap:money(ap?.amount),
    offset_ready_recoverables:money(ready?.amount),
    unmatched_credit_notes:money(unmatched?.amount),
    matched_unsettled_credit:money(matched?.amount),
    identified_unconfirmed_claims:money(identified?.amount)
  };
  position.requires_override=position.offset_ready_recoverables>0.009||position.unmatched_credit_notes>0.009;
  return position;
}
async function authorizeCreditPosition(req,position){
  if(!position.requires_override)return null;
  const reason=String(req.body?.supplier_credit_override_reason||'').trim();
  const pin=String(req.body?.supplier_credit_override_pin||'').trim();
  const message=`This supplier has ${position.offset_ready_recoverables.toFixed(2)} of offset-ready recoverables and ${position.unmatched_credit_notes.toFixed(2)} of unmatched formal credit notes. Apply available supplier credit before sending additional cash, or obtain independent finance approval.`;
  if(!pin)throw Object.assign(new Error(message),{status:409,code:'SUPPLIER_CREDIT_POSITION_REVIEW',position});
  if(reason.length<10)throw Object.assign(new Error('A meaningful reason is required to pay a supplier while usable supplier credit remains.'),{status:400});
  const {rows:employees}=await db.execute({sql:`SELECT e.id,e.first_name,e.last_name,e.pin,sg.permissions FROM employees e LEFT JOIN security_groups sg ON sg.id=e.security_group_id WHERE e.active=1`,args:[]});
  const authorizer=await findEmployeeByPin(employees,pin,e=>{let p={};try{p=JSON.parse(e.permissions||'{}');}catch{}return can(p,'reports_financial')||can(p,'security_manage');});
  if(!authorizer)throw Object.assign(new Error('Invalid supervisor PIN or insufficient finance authority for supplier-credit override.'),{status:403});
  if(req.employee&&String(req.employee.id)===String(authorizer.id))throw Object.assign(new Error('Independent supervisor authorization is required when paying through usable supplier credit.'),{status:403});
  return {authorizer,reason,message};
}
router.get('/payments/credit-position',requirePermission('reports_financial'),async(req,res)=>{
  try{
    const supplierId=Number(req.query.supplier_id);
    if(!supplierId)return res.status(400).json({error:'supplier_id is required'});
    res.json(await supplierCreditPosition(supplierId));
  }catch(e){res.status(500).json({error:e.message});}
});
function wrapCreditOverrideEvidence(res,{supplierId,paymentAmount,position,creditAuth}){
  if(!creditAuth)return;
  const priorJson=res.json.bind(res);let creditHandled=false;
  res.json=function(payload){
    if(creditHandled)return priorJson(payload);creditHandled=true;
    if(res.statusCode>=200&&res.statusCode<300&&payload?.id){
      return db.execute({sql:`INSERT INTO supplier_payment_credit_override_events(
        payment_id,supplier_id,payment_amount,open_ap,offset_ready_recoverables,unmatched_credit_notes,
        matched_unsettled_credit,identified_unconfirmed_claims,authorizer_employee_id,reason,evidence_json
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,args:[
        payload.id,supplierId,paymentAmount,position.open_ap,position.offset_ready_recoverables,
        position.unmatched_credit_notes,position.matched_unsettled_credit,position.identified_unconfirmed_claims,
        creditAuth.authorizer.id,creditAuth.reason,JSON.stringify({position,decision:'pay_cash_despite_supplier_credit'})
      ]}).then(()=>priorJson({...payload,supplier_credit_override_recorded:true,supplier_credit_position:position}))
        .catch(err=>{if(!res.headersSent){res.status(500);return priorJson({error:'Supplier payment posted but supplier-credit override evidence failed to persist; reconciliation required',payment_id:payload.id,detail:err.message});}});
    }
    return priorJson(payload);
  };
}
async function ensurePaymentLandedCosts(req,supplierId){
  const allocations=Array.isArray(req.body?.allocations)?req.body.allocations.filter(x=>Number(x.invoice_id)>0&&Number(x.amount)>0):[];
  for(const allocation of allocations){
    const invoiceId=Number(allocation.invoice_id);
    const {rows:[invoice]}=await db.execute({sql:`SELECT id,supplier_id,tax_amount,freight_amount,duty_amount,other_landed_cost_amount,tax_treatment FROM supplier_invoices WHERE id=? AND status!='void'`,args:[invoiceId]});
    if(!invoice||Number(invoice.supplier_id)!==supplierId)continue;
    if(capitalizableAmount(invoice)<=0)continue;
    const tx=await db.transaction('write');
    try{
      const result=await reconcileSupplierInvoiceLandedCosts(tx,invoiceId,{actorId:req.employee?.id||null});
      await tx.commit();
      if(result.status!=='allocated')throw Object.assign(new Error(`Supplier invoice ${invoiceId} has unresolved landed cost (${result.expected_amount.toFixed(2)}). ${result.reason||'Receipt-line reconciliation is required before payment.'}`),{status:409});
    }catch(e){try{await tx.rollback();}catch{}throw e;}
  }
}
router.post('/payments',async(req,res,next)=>{
  try{
    const supplierId=Number(req.body?.supplier_id),normalized=normalize(req.body?.reference),amount=money(req.body?.amount),paymentDate=String(req.body?.payment_date||'').trim();
    if(!supplierId||!(amount>0)||!paymentDate)return next();
    await ensurePaymentLandedCosts(req,supplierId);
    const creditPosition=await supplierCreditPosition(supplierId);
    const creditAuth=await authorizeCreditPosition(req,creditPosition);
    delete req.body.supplier_credit_override_pin;delete req.body.supplier_credit_override_reason;
    wrapCreditOverrideEvidence(res,{supplierId,paymentAmount:amount,position:creditPosition,creditAuth});
    const [windowDays,pctTolerance,absoluteTolerance]=await Promise.all([
      settingNumber('loss_control_supplier_payment_similarity_days',2),
      settingNumber('loss_control_supplier_payment_similarity_amount_pct',0.25),
      settingNumber('loss_control_supplier_payment_similarity_amount_abs',100)
    ]);
    const allowedDays=Math.max(0,Math.min(14,windowDays));
    const amountTolerance=Math.max(0,Number(absoluteTolerance||0),amount*Math.max(0,Number(pctTolerance||0))/100);
    const {rows:all}=await db.execute({sql:`SELECT id,payment_number,reference,amount,payment_date,payment_method,recorded_by,created_at FROM supplier_payments WHERE supplier_id=? ORDER BY id`,args:[supplierId]});
    const exactReference=normalized?all.filter(x=>normalize(x.reference)===normalized):[];
    const sameDayAmount=all.filter(x=>String(x.payment_date)===paymentDate&&Math.abs(money(x.amount)-amount)<=0.009);
    const nearDateAmount=all.filter(x=>{
      const d=dayDiff(String(x.payment_date),paymentDate),delta=Math.abs(money(x.amount)-amount);
      return d<=allowedDays&&delta<=amountTolerance+0.009;
    });
    const priorMap=new Map();for(const p of [...exactReference,...sameDayAmount,...nearDateAmount])priorMap.set(Number(p.id),p);const prior=[...priorMap.values()];
    if(!prior.length)return next();
    const triggers=[];
    if(exactReference.length)triggers.push('duplicate_reference');
    if(sameDayAmount.length)triggers.push('same_supplier_amount_date');
    if(nearDateAmount.some(x=>String(x.payment_date)!==paymentDate||Math.abs(money(x.amount)-amount)>0.009))triggers.push('near_supplier_amount_date');
    const message=exactReference.length
      ?`Payment reference ${req.body?.reference} has already been recorded for this supplier. Independent approval is required before another payment can use it.`
      :sameDayAmount.length
        ?`A payment of ${amount.toFixed(2)} is already recorded for this supplier on ${paymentDate}. Independent approval is required before posting another same-day payment for the same amount.`
        :`A materially similar payment was recorded for this supplier within ${allowedDays} day(s). Independent approval is required before posting another payment of ${amount.toFixed(2)}.`;
    const ev=await authorize(req,message);
    delete req.body.duplicate_payment_override_pin;delete req.body.duplicate_payment_override_reason;delete req.body.payment_similarity_override_pin;delete req.body.payment_similarity_override_reason;
    const originalJson=res.json.bind(res);let handled=false;
    res.json=function(payload){
      if(handled)return originalJson(payload);handled=true;
      if(res.statusCode>=200&&res.statusCode<300&&payload?.id)return (async()=>{
        if(exactReference.length)await db.execute({sql:`INSERT INTO supplier_payment_override_events(payment_id,supplier_id,normalized_reference,prior_payment_ids,authorizer_employee_id,reason) VALUES(?,?,?,?,?,?)`,args:[payload.id,supplierId,normalized,JSON.stringify(exactReference.map(x=>x.id)),ev.authorizer.id,ev.reason]});
        await db.execute({sql:`INSERT INTO supplier_payment_similarity_override_events(payment_id,supplier_id,payment_date,amount,trigger_type,prior_payment_ids,authorizer_employee_id,reason,evidence_json) VALUES(?,?,?,?,?,?,?,?,?)`,args:[payload.id,supplierId,paymentDate,amount,triggers.join('+'),JSON.stringify(prior.map(x=>x.id)),ev.authorizer.id,ev.reason,JSON.stringify({reference:req.body?.reference||null,normalized_reference:normalized||null,window_days:allowedDays,amount_tolerance:money(amountTolerance),amount_tolerance_pct:Number(pctTolerance||0),amount_tolerance_abs:Number(absoluteTolerance||0),prior:prior.map(x=>({id:x.id,payment_number:x.payment_number,reference:x.reference,amount:money(x.amount),payment_date:x.payment_date,payment_method:x.payment_method,day_difference:dayDiff(String(x.payment_date),paymentDate),amount_difference:money(Math.abs(money(x.amount)-amount))}))})]});
        return originalJson({...payload,supplier_payment_similarity_override_recorded:true,override_triggers:triggers});
      })().catch(err=>{if(!res.headersSent){res.status(500);return originalJson({error:'Supplier payment posted but duplicate/similarity override evidence failed to persist; reconciliation required',payment_id:payload.id,detail:err.message});}});
      return originalJson(payload);
    };
    next();
  }catch(e){res.status(e.status||500).json({error:e.message});}
});
module.exports=router;
module.exports.ensureSchema=ensureSchema;
