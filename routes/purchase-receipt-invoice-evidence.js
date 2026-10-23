'use strict';
// Supplier invoice evidence is separate from accounts payable. A receipt may
// reference an invoice before AP posting; linking it never posts a second bill.
const express=require('express');
const {db}=require('../database');
const {ensureSupplierLedgerBase}=require('../lib/supplier-ledger-base-schema');
const {ensurePurchaseReceiptBaseSchema}=require('../lib/purchase-receipt-base-schema');
const {normalizeSupplierInvoiceNumber}=require('../lib/supplier-invoice-identity');
const {requirePermission,requireAnyPermission,can}=require('../lib/permissions');
const router=express.Router(),q=(sql,args=[])=>({sql,args});
let ready=null;
function fail(code,message,status=400){const e=new Error(message);e.code=code;e.status=status;throw e;}
function id(v,label){const n=Number(v);if(!Number.isSafeInteger(n)||n<=0)fail('INVALID_ID',label+' must be a valid positive ID');return n;}
function str(v,label,max=200,required=true){const s=String(v??'').trim();if(s.length>max||(required&&!s))fail('INVALID_TEXT',label+' is required and must be at most '+max+' characters');return s||null;}
function iso(v){const s=str(v,'Invoice date',10);if(!/^\d{4}-\d\d-\d\d$/.test(s)||Number.isNaN(Date.parse(s+'T12:00:00Z'))||new Date(s+'T12:00:00Z').toISOString().slice(0,10)!==s)fail('INVALID_DATE','Invoice date must be a valid YYYY-MM-DD');return s;}
function cents(v,label){const s=String(v??'').trim();if(!/^\d{1,9}(?:\.\d{1,2})?$/.test(s))fail('INVALID_AMOUNT',label+' must be a non-negative amount with at most two decimals');const[a,b='']=s.split('.');const n=Number(a)*100+Number(b.padEnd(2,'0'));if(!Number.isSafeInteger(n)||n<0)fail('INVALID_AMOUNT',label+' is outside the allowed range');return n;}
function asMoney(c){return Number((Number(c)/100).toFixed(2));}
function moneyCents(n){const x=Math.round(Number(n)*100);if(!Number.isSafeInteger(x)||x<0)fail('INVALID_LEDGER_AMOUNT','Posted invoice amount cannot be reconciled safely',409);return x;}
function gate(req,po){const branch=req.employee?.default_branch_id;if(branch!=null&&Number(branch)!==Number(po.branch_id)&&!can(req.employee?.permissions,'branches')&&!can(req.employee?.permissions,'security_manage'))fail('BRANCH_FORBIDDEN','This purchase order belongs to a different branch',403);}
async function lookupPO(tx,req,poId){const{rows:[po]}=await tx.execute(q('SELECT id,supplier_id,branch_id,po_number,status FROM purchase_orders WHERE id=?',[poId]));if(!po)fail('PO_NOT_FOUND','Purchase order not found',404);gate(req,po);return po;}
async function receipt(tx,req,receiptId){const{rows:[row]}=await tx.execute(q('SELECT id,receipt_number,po_id,supplier_id,branch_id,total_cost,received_at FROM purchase_receipts WHERE id=?',[receiptId]));if(!row)fail('RECEIPT_NOT_FOUND','Goods receipt not found',404);const po=await lookupPO(tx,req,row.po_id);if(Number(row.supplier_id||po.supplier_id)!==Number(po.supplier_id)||Number(row.branch_id||po.branch_id)!==Number(po.branch_id))fail('RECEIPT_AUTHORITY_MISMATCH','Goods receipt supplier or branch does not match the purchase order',409);return{row,po};}
async function matchingInvoice(tx,supplierId,normalized){const{rows}=await tx.execute(q("SELECT id,supplier_id,purchase_order_id,branch_id,invoice_number,invoice_date,subtotal,status FROM supplier_invoices WHERE supplier_id=? AND status!='void'",[supplierId]));return rows.find(x=>normalizeSupplierInvoiceNumber(x.invoice_number)===normalized)||null;}
function validatePosted(invoice,po,normalized){if(!invoice)fail('INVOICE_NOT_POSTED','No posted AP invoice matches this supplier invoice reference',409);if(invoice.purchase_order_id==null||Number(invoice.purchase_order_id)!==Number(po.id))fail('INVOICE_PO_MISMATCH','Posted supplier invoice is attached to another purchase order',409);if(Number(invoice.supplier_id)!==Number(po.supplier_id)||invoice.branch_id!=null&&Number(invoice.branch_id)!==Number(po.branch_id))fail('INVOICE_BRANCH_MISMATCH','Invoice supplier or receiving branch does not match the PO',409);if(normalizeSupplierInvoiceNumber(invoice.invoice_number)!==normalized)fail('INVOICE_IDENTITY_MISMATCH','Invoice number does not match the posted invoice',409);}
async function totals(tx,supplier,normalized,poId,excludeId){const{rows}=await tx.execute(q('SELECT id,po_id,allocated_value_cents,invoice_subtotal_cents FROM purchase_receipt_invoice_evidence WHERE supplier_id=? AND normalized_invoice_number=?',[supplier,normalized]));if(rows.some(r=>Number(r.po_id)!==Number(poId)))fail('INVOICE_REUSED_ON_ANOTHER_PO','The same supplier invoice number is already associated with another PO',409);const active=rows.filter(r=>Number(r.id)!==Number(excludeId));return{allocated:active.reduce((a,b)=>a+Number(b.allocated_value_cents),0),recorded:active};}
async function ensureSchema(){
 if(ready)return ready;
 ready=(async()=>{
  await ensureSupplierLedgerBase();await ensurePurchaseReceiptBaseSchema();
  await db.batch([
   q("CREATE TABLE IF NOT EXISTS purchase_receipt_invoice_evidence(id INTEGER PRIMARY KEY AUTOINCREMENT,po_id INTEGER NOT NULL REFERENCES purchase_orders(id),receipt_id INTEGER NOT NULL REFERENCES purchase_receipts(id),supplier_id INTEGER NOT NULL REFERENCES suppliers(id),invoice_number TEXT NOT NULL,normalized_invoice_number TEXT NOT NULL,invoice_date TEXT NOT NULL,invoice_subtotal_cents INTEGER NOT NULL,allocated_value_cents INTEGER NOT NULL,posted_invoice_id INTEGER REFERENCES supplier_invoices(id),notes TEXT,recorded_by_employee_id INTEGER REFERENCES employees(id),recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,confirmed_by_employee_id INTEGER REFERENCES employees(id),confirmed_at TEXT,UNIQUE(receipt_id,supplier_id,normalized_invoice_number),CHECK(invoice_subtotal_cents>0),CHECK(allocated_value_cents>0),CHECK(invoice_subtotal_cents>=allocated_value_cents))"),
   q('CREATE INDEX IF NOT EXISTS idx_receipt_invoice_evidence_po ON purchase_receipt_invoice_evidence(po_id,receipt_id)'),
   q('CREATE INDEX IF NOT EXISTS idx_receipt_invoice_identity ON purchase_receipt_invoice_evidence(supplier_id,normalized_invoice_number)'),
   q("CREATE TABLE IF NOT EXISTS purchase_receipt_invoice_events(id INTEGER PRIMARY KEY AUTOINCREMENT,evidence_id INTEGER NOT NULL REFERENCES purchase_receipt_invoice_evidence(id),event_type TEXT NOT NULL,posted_invoice_id INTEGER REFERENCES supplier_invoices(id),actor_employee_id INTEGER REFERENCES employees(id),details TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"),
   q("CREATE TRIGGER IF NOT EXISTS trg_receipt_invoice_evidence_no_delete BEFORE DELETE ON purchase_receipt_invoice_evidence BEGIN SELECT RAISE(ABORT,'Supplier invoice receiving evidence cannot be deleted'); END"),
   q("CREATE TRIGGER IF NOT EXISTS trg_receipt_invoice_events_no_update BEFORE UPDATE ON purchase_receipt_invoice_events BEGIN SELECT RAISE(ABORT,'Invoice link audit is append-only'); END"),
   q("CREATE TRIGGER IF NOT EXISTS trg_receipt_invoice_events_no_delete BEFORE DELETE ON purchase_receipt_invoice_events BEGIN SELECT RAISE(ABORT,'Invoice link audit cannot be deleted'); END")
  ],'write');
 })().catch(e=>{ready=null;throw e;});
 return ready;
}
function trouble(res,e){const constraint=/UNIQUE|SQLITE_CONSTRAINT/i.test(String(e?.message||''));const status=e.status||(constraint?409:500);if(status>=500)console.error('purchase_receipt_invoice_evidence_failure',{code:e.code||'unknown'});return res.status(status).json({code:e.code||(constraint?'DUPLICATE_INVOICE_LINK':'RECEIPT_INVOICE_ERROR'),error:status>=500?'Unable to complete the supplier invoice link safely.':e.message});}
router.use((req,res,next)=>req.apiKey?res.status(403).json({code:'STAFF_SESSION_REQUIRED',error:'Receiving invoice evidence requires a staff session'}):next());
router.use(async(req,res,next)=>{try{await ensureSchema();next()}catch(e){trouble(res,e)}});
router.get('/orders/:id',requirePermission('purchasing'),async(req,res)=>{
 try{
  const poId=id(req.params.id,'PO'),po=await lookupPO(db,req,poId);
  const [receipts,invoices,evidence]=await Promise.all([
   db.execute(q('SELECT id,receipt_number,received_at,total_cost,received_by_employee_id FROM purchase_receipts WHERE po_id=? ORDER BY id DESC',[poId])),
   db.execute(q("SELECT id,invoice_number,invoice_date,subtotal,total,status FROM supplier_invoices WHERE purchase_order_id=? AND supplier_id=? AND status!='void' ORDER BY id DESC",[poId,po.supplier_id])),
   db.execute(q('SELECT e.*,si.status posted_invoice_status FROM purchase_receipt_invoice_evidence e LEFT JOIN supplier_invoices si ON si.id=e.posted_invoice_id WHERE e.po_id=? ORDER BY e.receipt_id DESC,e.id DESC',[poId]))
  ]);
  const evidenceByReceipt=new Map();for(const ev of evidence.rows){const key=Number(ev.receipt_id);evidenceByReceipt.set(key,(evidenceByReceipt.get(key)||0)+Number(ev.allocated_value_cents));}
  res.json({po,receipts:receipts.rows.map(x=>({...x,invoice_allocated_cents:evidenceByReceipt.get(Number(x.id))||0,unmatched_receipt_cents:moneyCents(x.total_cost)-(evidenceByReceipt.get(Number(x.id))||0)})),posted_invoices:invoices.rows,evidence:evidence.rows.map(x=>({...x,finance_status:x.posted_invoice_id&&x.posted_invoice_status!=='void'?'linked_posted':'pending_ap'})),note:'Receiving evidence does not post AP, modify retail stock, or pay the supplier.'});
 }catch(e){trouble(res,e);}
});
router.post('/receipts/:receiptId',requirePermission('purchasing_receive'),async(req,res)=>{
 let tx,done=false;
 try{
  const receiptId=id(req.params.receiptId,'Receipt'),b=req.body||{},invoiceNumber=str(b.invoice_number,'Supplier invoice number',120),normalized=normalizeSupplierInvoiceNumber(invoiceNumber);
  if(normalized.length<2)fail('INVOICE_IDENTITY_INVALID','Invoice number must contain at least two letters or digits');
  const invoiceDate=iso(b.invoice_date),invoiceSubtotal=cents(b.invoice_subtotal,'Invoice merchandise subtotal'),allocated=cents(b.allocated_value,'Value allocated to this receipt');
  if(invoiceSubtotal<=0||allocated<=0||allocated>invoiceSubtotal)fail('ALLOCATION_INVALID','Allocate a positive amount no greater than invoice merchandise subtotal');
  const notes=str(b.notes,'Receiving invoice note',1000,false);
  tx=await db.transaction('write');const {row,po}=await receipt(tx,req,receiptId);
  const prev=(await tx.execute(q('SELECT * FROM purchase_receipt_invoice_evidence WHERE receipt_id=? AND supplier_id=? AND normalized_invoice_number=?',[receiptId,po.supplier_id,normalized]))).rows[0];
  if(prev){
   const same=String(prev.invoice_date)===invoiceDate&&Number(prev.invoice_subtotal_cents)===invoiceSubtotal&&Number(prev.allocated_value_cents)===allocated&&(prev.notes||null)===(notes||null);
   if(!same)fail('INVOICE_LINK_CONFLICT','An invoice link already exists for this receipt with different values. Request an audited correction.',409);
   await tx.commit();done=true;return res.json({...prev,replayed:true,finance_status:prev.posted_invoice_id?'linked_posted':'pending_ap'});
  }
  const invoice=await matchingInvoice(tx,po.supplier_id,normalized);
  if(invoice)validatePosted(invoice,po,normalized);
  const checks=await totals(tx,po.supplier_id,normalized,po.id,null);
  if(checks.recorded.some(x=>Number(x.invoice_subtotal_cents)!==invoiceSubtotal))fail('INVOICE_TOTAL_CONFLICT','The same invoice number was recorded with a different merchandise subtotal',409);
  if(checks.allocated+allocated>invoiceSubtotal)fail('INVOICE_OVERALLOCATED','The invoice has already been allocated up to its merchandise value; review the receipt differences',409);
  if(invoice&&Math.abs(moneyCents(invoice.subtotal)-invoiceSubtotal)>1)fail('POSTED_INVOICE_TOTAL_MISMATCH','Invoice merchandise subtotal does not match the AP posting; review with Finance',409);
  const result=await tx.execute(q('INSERT INTO purchase_receipt_invoice_evidence(po_id,receipt_id,supplier_id,invoice_number,normalized_invoice_number,invoice_date,invoice_subtotal_cents,allocated_value_cents,posted_invoice_id,notes,recorded_by_employee_id,confirmed_by_employee_id,confirmed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',[po.id,receiptId,po.supplier_id,invoiceNumber,normalized,invoiceDate,invoiceSubtotal,allocated,invoice?.id||null,notes,req.employee?.id||null,invoice?.id?req.employee?.id||null:null,invoice?.id?new Date().toISOString():null]));
  const evidenceId=Number(result.lastInsertRowid);
  await tx.execute(q('INSERT INTO purchase_receipt_invoice_events(evidence_id,event_type,posted_invoice_id,actor_employee_id,details) VALUES(?,?,?,?,?)',[evidenceId,invoice?'linked_posted':'recorded_pending_ap',invoice?.id||null,req.employee?.id||null,JSON.stringify({invoice_number:invoiceNumber,receipt:row.receipt_number,allocated_value_cents:allocated,invoice_subtotal_cents:invoiceSubtotal})]));
  await tx.commit();done=true;
  res.status(201).json({id:evidenceId,po_id:po.id,receipt_id:receiptId,invoice_number:invoiceNumber,allocated_value_cents:allocated,finance_status:invoice?'linked_posted':'pending_ap',posted_invoice_id:invoice?.id||null,receipt_variance_cents:moneyCents(row.total_cost)-allocated});
 }catch(e){if(tx&&!done)await tx.rollback().catch(()=>{});trouble(res,e);}
});
router.post('/evidence/:id/confirm',requireAnyPermission('purchasing_approve','reports_financial'),async(req,res)=>{
 let tx,done=false;
 try{
  const evidenceId=id(req.params.id,'Evidence'),postedId=id(req.body?.supplier_invoice_id,'Posted supplier invoice');
  tx=await db.transaction('write');
  const {rows:[ev]}=await tx.execute(q('SELECT * FROM purchase_receipt_invoice_evidence WHERE id=?',[evidenceId]));
  if(!ev)fail('EVIDENCE_NOT_FOUND','Receipt invoice reference does not exist',404);
  const po=await lookupPO(tx,req,ev.po_id);
  const {rows:[inv]}=await tx.execute(q("SELECT * FROM supplier_invoices WHERE id=? AND status!='void'",[postedId]));
  validatePosted(inv,po,ev.normalized_invoice_number);
  if(Math.abs(moneyCents(inv.subtotal)-Number(ev.invoice_subtotal_cents))>1)fail('POSTED_INVOICE_TOTAL_MISMATCH','Posted invoice merchandise subtotal conflicts with the recorded receipt invoice',409);
  if(ev.posted_invoice_id!=null){
   if(Number(ev.posted_invoice_id)!==postedId)fail('LINK_ALREADY_CONFIRMED','Evidence is already linked to another posted invoice',409);
   await tx.commit();done=true;return res.json({id:evidenceId,posted_invoice_id:postedId,status:'linked_posted',replayed:true});
  }
  const changed=await tx.execute(q("UPDATE purchase_receipt_invoice_evidence SET posted_invoice_id=?,confirmed_by_employee_id=?,confirmed_at=CURRENT_TIMESTAMP WHERE id=? AND posted_invoice_id IS NULL",[postedId,req.employee?.id||null,evidenceId]));
  if(Number(changed.rowsAffected)!==1)fail('CONCURRENT_RECONCILIATION','Receipt invoice was linked by someone else',409);
  await tx.execute(q("INSERT INTO purchase_receipt_invoice_events(evidence_id,event_type,posted_invoice_id,actor_employee_id,details) VALUES(?,'ap_link_confirmed',?,?,?)",[evidenceId,postedId,req.employee?.id||null,'Linked to existing AP invoice; no new payable was created']));
  await tx.commit();done=true;res.json({id:evidenceId,posted_invoice_id:postedId,status:'linked_posted'});
 }catch(e){if(tx&&!done)await tx.rollback().catch(()=>{});trouble(res,e);}
});
module.exports=router;
