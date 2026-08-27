'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {can}=require('../lib/permissions');

let readyPromise=null;
const money=v=>Number(Number(v||0).toFixed(2));
const normalizeInvoiceNumber=v=>String(v||'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'');
function actor(req){return req.employee?.id||null;}
function mayOverride(req){return !!req.apiKey||!!req.employee&&can(req.employee.permissions,'purchasing_approve');}
async function ensureSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=db.batch([
    {sql:`CREATE TABLE IF NOT EXISTS supplier_invoice_match_controls(
      supplier_invoice_id INTEGER PRIMARY KEY REFERENCES supplier_invoices(id),
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
      purchase_order_id INTEGER REFERENCES purchase_orders(id),
      normalized_invoice_number TEXT NOT NULL,
      match_status TEXT NOT NULL,
      po_merchandise_value REAL,
      received_merchandise_value REAL,
      prior_billed_merchandise_value REAL NOT NULL DEFAULT 0,
      invoice_merchandise_value REAL NOT NULL DEFAULT 0,
      remaining_received_value_before_invoice REAL,
      merchandise_variance REAL NOT NULL DEFAULT 0,
      override_reason TEXT,
      override_by_employee_id INTEGER REFERENCES employees(id),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(supplier_id,normalized_invoice_number)
    )`},
    {sql:`CREATE TABLE IF NOT EXISTS supplier_invoice_match_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_invoice_id INTEGER NOT NULL REFERENCES supplier_invoices(id),
      event_type TEXT NOT NULL,
      employee_id INTEGER REFERENCES employees(id),
      details TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`},
    {sql:'CREATE INDEX IF NOT EXISTS idx_supplier_invoice_match_po ON supplier_invoice_match_controls(purchase_order_id,match_status)'},
    {sql:'CREATE INDEX IF NOT EXISTS idx_supplier_invoice_match_status ON supplier_invoice_match_controls(match_status,created_at)'}
  ],'write').catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Supplier invoice loss-prevention initialization failed',detail:e.message});}});

async function duplicateFor(supplierId,normalized){
  const {rows}=await db.execute({sql:`SELECT id,invoice_number,total,status FROM supplier_invoices WHERE supplier_id=? AND status!='void'`,args:[supplierId]});
  return rows.find(r=>normalizeInvoiceNumber(r.invoice_number)===normalized)||null;
}
async function receiptValue(poId){
  const {rows:[exists]}=await db.execute({sql:"SELECT name FROM sqlite_master WHERE type='table' AND name='purchase_receipt_items'",args:[]});
  if(!exists)return null;
  const {rows:[row]}=await db.execute({sql:`SELECT COALESCE(SUM(pri.line_cost),0) value FROM purchase_receipt_items pri JOIN purchase_receipts pr ON pr.id=pri.receipt_id WHERE pr.po_id=?`,args:[poId]});
  return money(row?.value||0);
}
async function priorBilled(poId){
  const {rows:[row]}=await db.execute({sql:`SELECT COALESCE(SUM(subtotal),0) value FROM supplier_invoices WHERE purchase_order_id=? AND status!='void'`,args:[poId]});
  return money(row?.value||0);
}
async function evaluateInvoice(req){
  const b=req.body||{},supplierId=Number(b.supplier_id),poId=b.purchase_order_id?Number(b.purchase_order_id):null,subtotal=money(b.subtotal||0);
  const normalized=normalizeInvoiceNumber(b.invoice_number);
  if(!supplierId||!normalized)return null;
  const duplicate=await duplicateFor(supplierId,normalized);
  if(duplicate){const e=new Error(`Potential duplicate supplier invoice: ${duplicate.invoice_number} is already recorded for this supplier.`);e.status=409;throw e;}
  const {rows:[supplier]}=await db.execute({sql:'SELECT id,name,active FROM suppliers WHERE id=?',args:[supplierId]});
  if(!supplier||Number(supplier.active)===0){const e=new Error('Supplier invoice references an unavailable supplier.');e.status=409;throw e;}
  if(!poId)return {supplierId,poId:null,normalized,subtotal,matchStatus:'unmatched_po',poValue:null,receivedValue:null,priorBilled:0,remainingReceived:null,variance:0,overrideReason:null,overrideBy:null};
  const {rows:[po]}=await db.execute({sql:'SELECT * FROM purchase_orders WHERE id=?',args:[poId]});
  if(!po){const e=new Error('Purchase order not found for supplier invoice match.');e.status=404;throw e;}
  if(Number(po.supplier_id||0)!==supplierId){const e=new Error('Supplier invoice supplier does not match the purchase order supplier.');e.status=409;throw e;}
  if(po.status==='cancelled'){const e=new Error('Supplier invoice cannot be matched to a cancelled purchase order.');e.status=409;throw e;}
  const poValue=money(po.subtotal||po.total||0),receivedValue=await receiptValue(poId),prior=await priorBilled(poId);
  const remainingPo=money(Math.max(0,poValue-prior));
  const remainingReceived=receivedValue==null?null:money(Math.max(0,receivedValue-prior));
  const tolerancePct=Math.max(0,Number((await db.execute({sql:"SELECT value FROM settings WHERE key='supplier_invoice_match_tolerance_pct'",args:[]})).rows[0]?.value||0));
  const tolerance=money(poValue*tolerancePct/100);
  const poOver=money(Math.max(0,subtotal-remainingPo));
  const receiptOver=remainingReceived==null?0:money(Math.max(0,subtotal-remainingReceived));
  const variance=Math.max(poOver,receiptOver);
  let matchStatus='matched';
  if(receivedValue==null||receivedValue<=0)matchStatus='unmatched_receipt';
  if(variance>tolerance+0.01){
    if(!mayOverride(req)){const e=new Error(`Supplier invoice merchandise exceeds matched PO/receipt value by ${variance.toFixed(2)}. Purchasing approval is required before posting this exception.`);e.status=409;throw e;}
    const reason=String(b.match_override_reason||'').trim();
    if(reason.length<5){const e=new Error('A meaningful supplier invoice match override reason is required.');e.status=400;throw e;}
    matchStatus='approved_exception';
    return {supplierId,poId,normalized,subtotal,matchStatus,poValue,receivedValue,priorBilled:prior,remainingReceived,variance,overrideReason:reason,overrideBy:actor(req)};
  }
  if(matchStatus==='matched'&&subtotal>remainingPo+0.01)matchStatus='approved_exception';
  return {supplierId,poId,normalized,subtotal,matchStatus,poValue,receivedValue,priorBilled:prior,remainingReceived,variance,overrideReason:null,overrideBy:null};
}
async function persistMatch(invoiceId,ev){
  if(!invoiceId||!ev)return;
  await db.execute({sql:`INSERT INTO supplier_invoice_match_controls(supplier_invoice_id,supplier_id,purchase_order_id,normalized_invoice_number,match_status,po_merchandise_value,received_merchandise_value,prior_billed_merchandise_value,invoice_merchandise_value,remaining_received_value_before_invoice,merchandise_variance,override_reason,override_by_employee_id)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:[invoiceId,ev.supplierId,ev.poId,ev.normalized,ev.matchStatus,ev.poValue,ev.receivedValue,ev.priorBilled,ev.subtotal,ev.remainingReceived,ev.variance,ev.overrideReason,ev.overrideBy]});
  await db.execute({sql:'INSERT INTO supplier_invoice_match_events(supplier_invoice_id,event_type,employee_id,details) VALUES(?,?,?,?)',args:[invoiceId,ev.matchStatus==='matched'?'three_way_matched':ev.matchStatus,ev.overrideBy||null,JSON.stringify({po_merchandise_value:ev.poValue,received_merchandise_value:ev.receivedValue,prior_billed:ev.priorBilled,invoice_merchandise_value:ev.subtotal,variance:ev.variance,override_reason:ev.overrideReason})]});
}

router.post('/invoices',async(req,res,next)=>{
  let ev;try{ev=await evaluateInvoice(req);}catch(e){return res.status(e.status||500).json({error:e.message});}
  if(!ev)return next();
  delete req.body.match_override_reason;
  const originalJson=res.json.bind(res);let handled=false;
  res.json=function(payload){if(handled)return originalJson(payload);handled=true;if(res.statusCode>=200&&res.statusCode<300&&payload?.id)return persistMatch(payload.id,ev).then(()=>originalJson({...payload,invoice_match_status:ev.matchStatus,invoice_match_variance:ev.variance})).catch(err=>{if(!res.headersSent){res.status(500);return originalJson({error:'Supplier invoice posted but match evidence failed to persist; reconciliation required',supplier_invoice_id:payload.id,detail:err.message});}});return originalJson(payload);};
  next();
});

router.post('/payments',async(req,res,next)=>{
  try{
    const supplierId=Number(req.body?.supplier_id),amount=money(req.body?.amount||0);if(!supplierId||amount<=0)return next();
    let allocations=Array.isArray(req.body?.allocations)?req.body.allocations.filter(x=>Number(x.amount)>0):[];
    if(allocations.length){
      for(const a of allocations){const {rows:[m]}=await db.execute({sql:`SELECT c.match_status FROM supplier_invoice_match_controls c JOIN supplier_invoices si ON si.id=c.supplier_invoice_id WHERE c.supplier_invoice_id=? AND si.supplier_id=?`,args:[Number(a.invoice_id),supplierId]});if(!m||!['matched','approved_exception'].includes(String(m.match_status)))return res.status(409).json({error:`Supplier invoice ${a.invoice_id} is not cleared by PO/receipt matching and cannot be paid yet.`});}
      return next();
    }
    const {rows:open}=await db.execute({sql:`SELECT si.id,MAX(0,si.total-COALESCE(a.paid,0)) balance_due FROM supplier_invoices si JOIN supplier_invoice_match_controls c ON c.supplier_invoice_id=si.id
      LEFT JOIN (SELECT supplier_invoice_id,SUM(amount) paid FROM supplier_payment_allocations GROUP BY supplier_invoice_id) a ON a.supplier_invoice_id=si.id
      WHERE si.supplier_id=? AND si.status!='void' AND c.match_status IN ('matched','approved_exception') AND MAX(0,si.total-COALESCE(a.paid,0))>0.001 ORDER BY COALESCE(si.due_date,si.invoice_date),si.id`,args:[supplierId]});
    let left=amount;allocations=[];for(const inv of open){if(left<=0.001)break;const applied=Math.min(left,Number(inv.balance_due));allocations.push({invoice_id:inv.id,amount:money(applied)});left=money(left-applied);}
    if(!allocations.length)return res.status(409).json({error:'No matched supplier invoices are eligible for payment. Review PO/receipt matching first.'});
    req.body.allocations=allocations;
    next();
  }catch(e){res.status(500).json({error:e.message});}
});

router.get('/invoice-matches',async(req,res)=>{
  try{const args=[];let sql=`SELECT c.*,si.invoice_number,si.invoice_date,si.total,si.status,s.name supplier_name,po.po_number FROM supplier_invoice_match_controls c JOIN supplier_invoices si ON si.id=c.supplier_invoice_id JOIN suppliers s ON s.id=c.supplier_id LEFT JOIN purchase_orders po ON po.id=c.purchase_order_id WHERE 1=1`;if(req.query.status){sql+=' AND c.match_status=?';args.push(req.query.status);}if(req.query.supplier_id){sql+=' AND c.supplier_id=?';args.push(req.query.supplier_id);}sql+=' ORDER BY c.created_at DESC,c.supplier_invoice_id DESC LIMIT 500';const {rows}=await db.execute({sql,args});res.json(rows);}catch(e){res.status(500).json({error:e.message});}
});

module.exports=router;
module.exports.ensureSchema=ensureSchema;
module.exports.normalizeInvoiceNumber=normalizeInvoiceNumber;
