'use strict';
// Three-way supplier invoice -> PO -> individual receipt line evidence.
// This augments, never duplicates, the authoritative supplier ledger liability.
const express=require('express');
const crypto=require('node:crypto');
const {db}=require('../database');
const {requireAnyPermission,can}=require('../lib/permissions');
const {ensurePurchaseReceiptBaseSchema}=require('../lib/purchase-receipt-base-schema');
const {ensureSupplierLedgerBase}=require('../lib/supplier-ledger-base-schema');
const {ensureSchema:ensureInvoiceMatchControls}=require('./supplier-invoice-loss-prevention');
const router=express.Router();
const sql=(sql,args=[])=>({sql,args});
const id=(v,name='Record')=>{const n=Number(v);if(!Number.isSafeInteger(n)||n<=0)throw failure(400,'INVALID_ID',name+' ID must be a positive integer');return n;};
const failure=(status,code,message)=>Object.assign(new Error(message),{status,code});
const cash=n=>Math.round(Number(n)*100);
const money=c=>Number((c/100).toFixed(2));
function qty(value){
 const s=String(value??'').trim();
 if(!/^\d{1,9}(?:\.\d{1,6})?$/.test(s)||Number(s)<=0)throw failure(400,'INVALID_QUANTITY','Invoice matched quantity must be positive, with up to six decimal places');
 return Number(s);
}
function unitCost(value){
 const s=String(value??'').trim();
 if(!/^\d{1,9}(?:\.\d{1,2})?$/.test(s))throw failure(400,'INVALID_UNIT_COST','Invoiced unit cost must use up to two decimal places');
 return cash(s);
}
function assertBranch(req,po){
 const own=req.employee?.default_branch_id;
 if(own!=null&&Number(own)!==Number(po.branch_id)&&!can(req.employee?.permissions,'branches')&&!can(req.employee?.permissions,'security_manage'))throw failure(403,'BRANCH_FORBIDDEN','Purchase order belongs to another branch');
}
function report(res,e){
 const conflict=/UNIQUE|SQLITE_CONSTRAINT/.test(String(e?.message||''));
 const status=e.status||(conflict?409:500);
 if(status>=500)console.error('supplier_invoice_receipt_link_error',{code:e.code||'unknown'});
 return res.status(status).json({code:e.code||(conflict?'DUPLICATE_LINK':'INVOICE_RECEIPT_LINK_FAILED'),error:status>=500?'Unable to reconcile invoice and received goods.':e.message});
}
let ready=null;
async function ensureSchema(){
 if(ready)return ready;
 ready=(async()=>{
  await ensureSupplierLedgerBase();
  await ensurePurchaseReceiptBaseSchema();
  await ensureInvoiceMatchControls();
  await require('../lib/supplier-invoice-capture').ensureSchema();
  await db.batch([
   sql("CREATE TABLE IF NOT EXISTS supplier_invoice_receipt_allocations(id INTEGER PRIMARY KEY AUTOINCREMENT,supplier_invoice_id INTEGER NOT NULL REFERENCES supplier_invoices(id),purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id),purchase_receipt_item_id INTEGER NOT NULL REFERENCES purchase_receipt_items(id),quantity_invoiced REAL NOT NULL CHECK(quantity_invoiced>0),invoice_unit_cost_cents INTEGER NOT NULL CHECK(invoice_unit_cost_cents>=0),invoice_line_cents INTEGER NOT NULL CHECK(invoice_line_cents>=0),linked_by_employee_id INTEGER REFERENCES employees(id),created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(supplier_invoice_id,purchase_receipt_item_id))"),
   sql('CREATE INDEX IF NOT EXISTS idx_supplier_invoice_receipt_allocations_line ON supplier_invoice_receipt_allocations(purchase_receipt_item_id)'),
   sql('CREATE INDEX IF NOT EXISTS idx_supplier_invoice_receipt_allocations_po ON supplier_invoice_receipt_allocations(purchase_order_id,supplier_invoice_id)'),
   sql("CREATE TRIGGER IF NOT EXISTS trg_invoice_receipt_allocation_no_update BEFORE UPDATE ON supplier_invoice_receipt_allocations BEGIN SELECT RAISE(ABORT,'Supplier invoice receipt allocations are immutable'); END"),
   sql("CREATE TRIGGER IF NOT EXISTS trg_invoice_receipt_allocation_no_delete BEFORE DELETE ON supplier_invoice_receipt_allocations BEGIN SELECT RAISE(ABORT,'Supplier invoice receipt allocations cannot be deleted'); END"),
   sql("CREATE TABLE IF NOT EXISTS supplier_invoice_receipt_operations(operation_key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result_json TEXT NOT NULL,created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)")
  ],'write');
 })().catch(e=>{ready=null;throw e;});
 return ready;
}
router.use((req,res,next)=>req.apiKey?res.status(403).json({error:'Staff authentication required for invoice evidence',code:'STAFF_ONLY'}):next());
router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){report(res,e);}});
async function getPo(executor,req,poId){
 const {rows:[po]}=await executor.execute(sql('SELECT id,po_number,supplier_id,branch_id,status FROM purchase_orders WHERE id=?',[poId]));
 if(!po)throw failure(404,'PO_NOT_FOUND','Purchase order was not found');
 assertBranch(req,po);
 if(!po.supplier_id||!po.branch_id)throw failure(409,'PO_MISSING_AUTHORITY','PO supplier and receiving branch must be set before linking invoices');
 return po;
}
async function receipts(executor,poId){
 const {rows}=await executor.execute(sql("SELECT pr.id receipt_id,pr.receipt_number,pr.received_at,pri.id receipt_item_id,pri.po_item_id,pri.product_id,pri.product_name,pri.sku,pri.quantity_received,pri.unit_cost,COALESCE((SELECT SUM(a.quantity_invoiced) FROM supplier_invoice_receipt_allocations a WHERE a.purchase_receipt_item_id=pri.id),0)+COALESCE((SELECT SUM(ca.quantity_invoiced) FROM captured_supplier_invoice_receipts ca JOIN captured_supplier_invoices cd ON cd.id=ca.captured_invoice_id WHERE ca.purchase_receipt_item_id=pri.id AND cd.status='captured'),0) allocated_qty FROM purchase_receipts pr JOIN purchase_receipt_items pri ON pri.receipt_id=pr.id WHERE pr.po_id=? ORDER BY pr.id DESC,pri.id",[poId]));
 return rows.map(x=>({...x,remaining_qty:Math.max(0,Number((Number(x.quantity_received)-Number(x.allocated_qty)).toFixed(6)))}));
}
async function invoiceChoices(executor,po,allowUnassigned){
 const {rows}=await executor.execute(sql("SELECT si.id,si.invoice_number,si.invoice_date,si.subtotal,si.total,si.status,si.purchase_order_id,si.supplier_id,si.branch_id,COALESCE(m.match_status,'unreviewed') match_status,COALESCE((SELECT SUM(a.invoice_line_cents) FROM supplier_invoice_receipt_allocations a WHERE a.supplier_invoice_id=si.id),0) allocated_cents,COALESCE((SELECT SUM(pa.amount) FROM supplier_payment_allocations pa WHERE pa.supplier_invoice_id=si.id),0) paid_amount FROM supplier_invoices si LEFT JOIN supplier_invoice_match_controls m ON m.supplier_invoice_id=si.id WHERE si.supplier_id=? AND si.status!='void' AND (si.purchase_order_id=? OR (si.purchase_order_id IS NULL AND ?=1)) AND (si.branch_id=? OR si.branch_id IS NULL) ORDER BY CASE WHEN si.purchase_order_id=? THEN 0 ELSE 1 END,si.id DESC LIMIT 150",[po.supplier_id,po.id,allowUnassigned?1:0,po.branch_id,po.id]));
 return rows.map(x=>({...x,unmatched_subtotal_cents:cash(x.subtotal)-Number(x.allocated_cents)}));
}
router.get('/orders/:poId',requireAnyPermission('purchasing','purchasing_receive','reports_financial'),async(req,res)=>{
 try{
  const po=await getPo(db,req,id(req.params.poId,'PO'));
  const [invoiceRows,receivedRows]=await Promise.all([invoiceChoices(db,po,can(req.employee?.permissions,'reports_financial')),receipts(db,po.id)]);
  const {rows:links}=await db.execute(sql("SELECT a.id,a.supplier_invoice_id,a.purchase_receipt_item_id,a.quantity_invoiced,a.invoice_unit_cost_cents,a.invoice_line_cents,a.created_at FROM supplier_invoice_receipt_allocations a WHERE a.purchase_order_id=? ORDER BY a.id DESC LIMIT 400",[po.id]));
  const captured=await require('../lib/supplier-invoice-capture').list(db,req,po.id);
  res.json({po,invoices:invoiceRows,receipt_items:receivedRows,links,captured_invoices:captured.invoices,captured_links:captured.links,can_post:can(req.employee?.permissions,'reports_financial'),can_capture:can(req.employee?.permissions,'reports_financial')||can(req.employee?.permissions,'purchasing_receive'),scope:'captured_and_posted_supplier_invoices'});
 }catch(e){report(res,e);}
});
router.post('/orders/:poId/invoices/:invoiceId/allocate',requireAnyPermission('purchasing_receive','reports_financial'),async(req,res)=>{
 let tx,committed=false;
 try{
  const poId=id(req.params.poId,'PO'),invoiceId=id(req.params.invoiceId,'Invoice');
  const key=String(req.headers['idempotency-key']||'').trim();
  if(!/^[A-Za-z0-9_.:-]{12,160}$/.test(key))throw failure(400,'IDEMPOTENCY_KEY_REQUIRED','Provide a stable Idempotency-Key of 12–160 safe characters');
  const rows=req.body?.lines;
  if(!Array.isArray(rows)||!rows.length||rows.length>100)throw failure(400,'INVOICE_LINES_REQUIRED','Select one to 100 receipt lines to match');
  const entries=rows.map(x=>({receiptItemId:id(x.receipt_item_id,'Receipt line'),quantity:qty(x.quantity_invoiced),unitCents:unitCost(x.invoice_unit_cost)}));
  if(new Set(entries.map(x=>x.receiptItemId)).size!==entries.length)throw failure(400,'DUPLICATE_RECEIPT_LINE','A receipt item can appear only once in an invoice match request');
  const fingerprint=crypto.createHash('sha256').update(JSON.stringify({poId,invoiceId,lines:entries})).digest('hex');
  const opKey='receipt-invoice:'+invoiceId+':'+key;
  tx=await db.transaction('write');
  // Authorization must precede the replay path: an operation key is not
  // an authorization credential and must not disclose another branch's data.
  const po=await getPo(tx,req,poId);
  const previous=(await tx.execute(sql('SELECT fingerprint,result_json FROM supplier_invoice_receipt_operations WHERE operation_key=?',[opKey]))).rows[0];
  if(previous){
   if(previous.fingerprint!==fingerprint)throw failure(409,'IDEMPOTENCY_CONFLICT','Operation key was already used for different invoice matching content');
   await tx.commit();committed=true;
   return res.json({...JSON.parse(previous.result_json),replayed:true});
  }
  const {rows:[invoice]}=await tx.execute(sql('SELECT * FROM supplier_invoices WHERE id=?',[invoiceId]));
  if(!invoice||String(invoice.status)==='void')throw failure(404,'INVOICE_NOT_FOUND','Posted supplier invoice was not found');
  if(Number(invoice.supplier_id)!==Number(po.supplier_id))throw failure(409,'SUPPLIER_MISMATCH','Invoice supplier does not match the purchase order');
  if(invoice.purchase_order_id&&Number(invoice.purchase_order_id)!==po.id)throw failure(409,'PO_MISMATCH','Invoice belongs to a different purchase order');
  if(invoice.branch_id&&Number(invoice.branch_id)!==Number(po.branch_id))throw failure(409,'BRANCH_MISMATCH','Invoice belongs to a different receiving branch');
  const {rows:[paid]}=await tx.execute(sql('SELECT COUNT(*) n FROM supplier_payment_allocations WHERE supplier_invoice_id=?',[invoiceId]));
  if(Number(paid.n)>0)throw failure(409,'PAID_INVOICE_LOCKED','Paid invoices require a controlled correction/credit workflow, not new receipt allocations');
  if(!entries.every(x=>Number.isSafeInteger(Math.round(x.quantity*x.unitCents))))throw failure(400,'INVOICE_COST_OVERFLOW','Invoice line amount exceeds supported precision');
  for(const line of entries){
   const {rows:[receipt]}=await tx.execute(sql('SELECT pri.id,pri.quantity_received,pri.unit_cost,pr.po_id,pr.branch_id,pr.supplier_id FROM purchase_receipt_items pri JOIN purchase_receipts pr ON pr.id=pri.receipt_id WHERE pri.id=?',[line.receiptItemId]));
   if(!receipt||Number(receipt.po_id)!==po.id||Number(receipt.branch_id)!==Number(po.branch_id)||(receipt.supplier_id&&Number(receipt.supplier_id)!==Number(po.supplier_id)))throw failure(409,'INVALID_RECEIPT','The selected receipt line does not belong to this PO and supplier');
   if(await require('../lib/supplier-invoice-capture').allocatedQuantity(tx,line.receiptItemId)+line.quantity>Number(receipt.quantity_received)+0.000001)throw failure(409,'RECEIPT_ALREADY_BILLED','Total invoiced quantity cannot exceed accepted received quantity');
   const amount=Math.round(line.quantity*line.unitCents);
   if(!Number.isSafeInteger(amount)||amount<0)throw failure(400,'INVOICE_COST_OVERFLOW','Calculated invoice line amount is invalid');
   await tx.execute(sql('INSERT INTO supplier_invoice_receipt_allocations(supplier_invoice_id,purchase_order_id,purchase_receipt_item_id,quantity_invoiced,invoice_unit_cost_cents,invoice_line_cents,linked_by_employee_id) VALUES(?,?,?,?,?,?,?)',[invoiceId,po.id,line.receiptItemId,line.quantity,line.unitCents,amount,req.employee?.id||null]));
  }
  if(!invoice.purchase_order_id){
   if(!can(req.employee?.permissions,'reports_financial'))throw failure(403,'FINANCE_AUTHORITY_REQUIRED','Only finance staff may assign an unlinked supplier invoice to a purchase order');
   const upd=await tx.execute(sql('UPDATE supplier_invoices SET purchase_order_id=?,branch_id=COALESCE(branch_id,?) WHERE id=? AND purchase_order_id IS NULL',[po.id,po.branch_id,invoiceId]));
   if(Number(upd.rowsAffected)!==1)throw failure(409,'INVOICE_PO_CHANGED','Invoice PO link changed during reconciliation');
  }
  const {rows:[sum]}=await tx.execute(sql('SELECT COALESCE(SUM(invoice_line_cents),0) total_cents,COUNT(*) lines FROM supplier_invoice_receipt_allocations WHERE supplier_invoice_id=?',[invoiceId]));
  const {rows:[differences]}=await tx.execute(sql("SELECT COUNT(*) n FROM supplier_invoice_receipt_allocations a JOIN purchase_receipt_items pri ON pri.id=a.purchase_receipt_item_id WHERE a.supplier_invoice_id=? AND a.invoice_unit_cost_cents!=ROUND(pri.unit_cost*100)",[invoiceId]));
  const expected=cash(invoice.subtotal),matched=Number(sum.total_cents),variance=matched-expected;
  const status=variance===0&&Number(differences.n)===0?'matched':variance!==0?'receipt_amount_variance':'receipt_unit_cost_variance';
  const changed=await tx.execute(sql('UPDATE supplier_invoice_match_controls SET purchase_order_id=?,match_status=?,received_merchandise_value=?,remaining_received_value_before_invoice=?,merchandise_variance=?,updated_at=CURRENT_TIMESTAMP WHERE supplier_invoice_id=?',[po.id,status,money(matched),money(expected-matched),money(variance),invoiceId]));
  if(Number(changed.rowsAffected)!==1)throw failure(409,'MATCH_RECORD_MISSING','Invoice match controls must exist before linking receipt evidence');
  await tx.execute(sql('INSERT INTO supplier_invoice_match_events(supplier_invoice_id,event_type,employee_id,details) VALUES(?,?,?,?)',[invoiceId,status==='matched'?'receipt_lines_matched':'receipt_variance_review_required',req.employee?.id||null,JSON.stringify({po_id:po.id,receipt_item_ids:entries.map(x=>x.receiptItemId),invoiced_subtotal_cents:expected,linked_cents:matched,variance_cents:variance,unit_cost_differences:Number(differences.n)})]));
  const response={invoice_id:invoiceId,po_id:po.id,match_status:status,linked_lines:Number(sum.lines),invoice_subtotal_cents:expected,matched_receipt_cents:matched,variance_cents:variance,unit_cost_differences:Number(differences.n),payment_cleared:status==='matched'};
  await tx.execute(sql('INSERT INTO supplier_invoice_receipt_operations(operation_key,fingerprint,result_json) VALUES(?,?,?)',[opKey,fingerprint,JSON.stringify(response)]));
  await tx.commit();committed=true;
  res.status(201).json(response);
 }catch(e){if(tx&&!committed)try{await tx.rollback()}catch{};report(res,e);}
});
module.exports=router;
module.exports.ensureReceiptInvoiceLinkSchema=ensureSchema;
