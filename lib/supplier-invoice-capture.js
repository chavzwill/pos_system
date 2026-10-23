'use strict';
// Captured supplier documents are deliberately outside the AP ledger.
const crypto=require('node:crypto');
const {db}=require('../database');
const {can}=require('./permissions');
const {normalizeSupplierInvoiceNumber:normalize}=require('./supplier-invoice-identity');
const sql=(sql,args=[])=>({sql,args});
const fail=(status,message)=>Object.assign(new Error(message),{status});
let ready;
function ensureSchema(){
 if(!ready)ready=db.batch([
  sql(`CREATE TABLE IF NOT EXISTS captured_supplier_invoices(
   id INTEGER PRIMARY KEY AUTOINCREMENT,purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id),
   supplier_id INTEGER NOT NULL REFERENCES suppliers(id),branch_id INTEGER NOT NULL REFERENCES branches(id),
   invoice_number TEXT NOT NULL,normalized_invoice_number TEXT NOT NULL,invoice_date TEXT NOT NULL,due_date TEXT,
   subtotal REAL NOT NULL,tax_amount REAL NOT NULL,freight_amount REAL NOT NULL,duty_amount REAL NOT NULL,
   other_landed_cost_amount REAL NOT NULL,tax_treatment TEXT,total REAL NOT NULL,notes TEXT,
   status TEXT NOT NULL DEFAULT 'captured' CHECK(status IN ('captured','posted','void')),
   supplier_invoice_id INTEGER UNIQUE REFERENCES supplier_invoices(id),captured_by INTEGER REFERENCES employees(id),
   created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,posted_at TEXT)`),
  sql("CREATE UNIQUE INDEX IF NOT EXISTS ux_captured_invoice_identity ON captured_supplier_invoices(supplier_id,normalized_invoice_number) WHERE status!='void'"),
  sql('CREATE INDEX IF NOT EXISTS idx_captured_invoice_po ON captured_supplier_invoices(purchase_order_id,status)'),
  sql(`CREATE TABLE IF NOT EXISTS captured_supplier_invoice_receipts(
   id INTEGER PRIMARY KEY AUTOINCREMENT,captured_invoice_id INTEGER NOT NULL REFERENCES captured_supplier_invoices(id),
   purchase_receipt_item_id INTEGER NOT NULL REFERENCES purchase_receipt_items(id),quantity_invoiced REAL NOT NULL CHECK(quantity_invoiced>0),
   invoice_unit_cost_cents INTEGER NOT NULL CHECK(invoice_unit_cost_cents>=0),invoice_line_cents INTEGER NOT NULL CHECK(invoice_line_cents>=0),
   linked_by_employee_id INTEGER REFERENCES employees(id),created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
   UNIQUE(captured_invoice_id,purchase_receipt_item_id))`),
  sql('CREATE INDEX IF NOT EXISTS idx_capture_receipts_item ON captured_supplier_invoice_receipts(purchase_receipt_item_id)'),
  sql(`CREATE TABLE IF NOT EXISTS captured_supplier_invoice_events(id INTEGER PRIMARY KEY AUTOINCREMENT,
   captured_invoice_id INTEGER NOT NULL REFERENCES captured_supplier_invoices(id),event_type TEXT NOT NULL,
   employee_id INTEGER REFERENCES employees(id),details TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`),
  sql('CREATE TABLE IF NOT EXISTS captured_supplier_invoice_operations(operation_key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,captured_invoice_id INTEGER NOT NULL REFERENCES captured_supplier_invoices(id),result_json TEXT NOT NULL)'),
  sql("CREATE TRIGGER IF NOT EXISTS trg_captured_invoice_financial_immutable BEFORE UPDATE OF purchase_order_id,supplier_id,branch_id,invoice_number,normalized_invoice_number,invoice_date,due_date,subtotal,tax_amount,freight_amount,duty_amount,other_landed_cost_amount,tax_treatment,total,notes ON captured_supplier_invoices BEGIN SELECT RAISE(ABORT,'Captured invoice details are immutable; void and recapture before posting'); END"),
  sql("CREATE TRIGGER IF NOT EXISTS trg_captured_invoice_no_delete BEFORE DELETE ON captured_supplier_invoices BEGIN SELECT RAISE(ABORT,'Captured invoices retain their audit history'); END"),
  sql("CREATE TRIGGER IF NOT EXISTS trg_captured_receipt_no_update BEFORE UPDATE ON captured_supplier_invoice_receipts BEGIN SELECT RAISE(ABORT,'Captured receipt evidence is immutable'); END"),
  sql("CREATE TRIGGER IF NOT EXISTS trg_captured_receipt_no_delete BEFORE DELETE ON captured_supplier_invoice_receipts BEGIN SELECT RAISE(ABORT,'Captured receipt evidence is immutable'); END")
 ],'write').catch(e=>{ready=null;throw e;});
 return ready;
}
function assertStaff(req){if(req.apiKey||!req.employee)throw fail(403,'Staff authentication is required for invoice capture');}
function assertBranch(req,row){
 assertStaff(req);
 if(req.employee.default_branch_id!=null&&Number(req.employee.default_branch_id)!==Number(row.branch_id)&&!can(req.employee.permissions,'branches')&&!can(req.employee.permissions,'security_manage'))throw fail(403,'Invoice belongs to another receiving branch');
}
function id(value){const n=Number(value);if(!Number.isSafeInteger(n)||n<=0)throw fail(400,'A positive record ID is required');return n;}
async function getPo(executor,req,poId){
 const row=(await executor.execute(sql('SELECT * FROM purchase_orders WHERE id=?',[id(poId)]))).rows[0];
 if(!row)throw fail(404,'Purchase order not found');assertBranch(req,row);
 if(!row.supplier_id||!row.branch_id||row.status==='cancelled')throw fail(409,'An active PO with supplier and receiving branch is required');
 return row;
}
async function getCapture(executor,req,captureId){
 const row=(await executor.execute(sql('SELECT * FROM captured_supplier_invoices WHERE id=?',[id(captureId)]))).rows[0];
 if(!row)throw fail(404,'Captured invoice not found');assertBranch(req,row);return row;
}
async function validateCapturePo(executor,req,doc){
 const po=await getPo(executor,req,doc.purchase_order_id);
 if(Number(po.supplier_id)!==Number(doc.supplier_id)||Number(po.branch_id)!==Number(doc.branch_id))throw fail(409,'PO supplier or receiving branch changed after invoice capture; void and recapture before matching or posting');
 return po;
}
function cents(value){
 const s=String(value??0).trim();if(!/^\d{1,9}(?:\.\d{1,2})?$/.test(s))throw fail(400,'Invoice amounts must be non-negative, with up to two decimal places');return Math.round(Number(s)*100);
}
function date(value,optional=false){
 if(optional&&(value===undefined||value===null||value===''))return null;
 const s=String(value||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(Date.parse(s))||new Date(s).toISOString().slice(0,10)!==s)throw fail(400,'Invoice dates must be valid YYYY-MM-DD dates');return s;
}
function document(body,po){
 const number=String(body.invoice_number||'').trim(),normalized=normalize(number);
 if(!normalized||number.length>160)throw fail(400,'A supplier invoice number of up to 160 characters is required');
 const fields=['subtotal','tax_amount','freight_amount','duty_amount','other_landed_cost_amount'];
 const amounts=fields.map(f=>cents(body[f]));const sum=amounts.reduce((a,b)=>a+b,0),total=body.total===undefined?sum:cents(body.total);
 if(total<=0||sum!==total)throw fail(400,'Invoice components must equal a positive invoice total');
 const treatment=amounts[1]?String(body.tax_treatment||''):null;
 if(amounts[1]&&!['recoverable','landed_cost','expense'].includes(treatment))throw fail(400,'Choose a tax treatment for the supplier tax');
 if(body.supplier_id!=null&&Number(body.supplier_id)!==Number(po.supplier_id))throw fail(409,'Invoice supplier does not match the PO');
 if(body.branch_id!=null&&Number(body.branch_id)!==Number(po.branch_id))throw fail(409,'Invoice branch does not match the PO');
 return{purchase_order_id:Number(po.id),supplier_id:Number(po.supplier_id),branch_id:Number(po.branch_id),invoice_number:number,normalized_invoice_number:normalized,invoice_date:date(body.invoice_date),due_date:date(body.due_date,true),...Object.fromEntries(fields.map((f,i)=>[f,amounts[i]/100])),tax_treatment:treatment,total:total/100,notes:String(body.notes||'').trim().slice(0,4000)};
}
function operation(req,prefix,body){
 const key=String(req.headers['idempotency-key']||'');if(!/^[A-Za-z0-9_.:-]{12,160}$/.test(key))throw fail(400,'Provide a stable Idempotency-Key of 12–160 safe characters');
 return{key:prefix+':'+key,fingerprint:crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex')};
}
async function replay(tx,op){
 const row=(await tx.execute(sql('SELECT * FROM captured_supplier_invoice_operations WHERE operation_key=?',[op.key]))).rows[0];
 if(!row)return null;if(row.fingerprint!==op.fingerprint)throw fail(409,'Operation key already used for different invoice content');return JSON.parse(row.result_json);
}
async function remember(tx,op,captureId,result){await tx.execute(sql('INSERT INTO captured_supplier_invoice_operations VALUES(?,?,?,?)',[op.key,op.fingerprint,captureId,JSON.stringify(result)]));}
async function event(tx,req,captureId,type,details){await tx.execute(sql('INSERT INTO captured_supplier_invoice_events(captured_invoice_id,event_type,employee_id,details) VALUES(?,?,?,?)',[captureId,type,req.employee.id,JSON.stringify(details)]));}
async function transaction(work){const tx=await db.transaction('write');try{const result=await work(tx);await tx.commit();return result;}catch(e){try{await tx.rollback();}catch{}throw e;}finally{tx.close();}}
async function capture(req){
 return transaction(async tx=>{
  const po=await getPo(tx,req,req.body.purchase_order_id),doc=document(req.body,po),op=operation(req,'capture',doc);
  const previous=await replay(tx,op);if(previous)return{...previous,replayed:true};
  const supplier=(await tx.execute(sql('SELECT active FROM suppliers WHERE id=?',[po.supplier_id]))).rows[0];if(!supplier||Number(supplier.active)===0)throw fail(409,'Supplier is unavailable');
  const existing=(await tx.execute(sql("SELECT invoice_number FROM supplier_invoices WHERE supplier_id=? AND status!='void'",[doc.supplier_id]))).rows;
  if(existing.some(x=>normalize(x.invoice_number)===doc.normalized_invoice_number))throw fail(409,'Supplier invoice has already been posted');
  const claim=(await tx.execute(sql('SELECT claim_token FROM supplier_invoice_identity_claims WHERE supplier_id=? AND normalized_invoice_number=?',[doc.supplier_id,doc.normalized_invoice_number]))).rows[0];
  if(claim)throw fail(409,'Supplier invoice is already posted or being posted; reconcile its identity before capturing');
  const fields=Object.keys(doc);const r=await tx.execute(sql(`INSERT INTO captured_supplier_invoices(${fields.join(',')},captured_by) VALUES(${fields.map(()=>'?').join(',')},?)`,[...fields.map(f=>doc[f]),req.employee.id]));
  const captureId=Number(r.lastInsertRowid);await event(tx,req,captureId,'captured',{total:doc.total});
  const saved=(await tx.execute(sql('SELECT * FROM captured_supplier_invoices WHERE id=?',[captureId]))).rows[0];await remember(tx,op,captureId,saved);return saved;
 });
}
// Counts pending evidence and posted allocations exactly once: posting transfers
// evidence while changing the source status in the same write transaction.
async function allocatedQuantity(tx,receiptItemId){
 const row=(await tx.execute(sql(`SELECT
  COALESCE((SELECT SUM(quantity_invoiced) FROM supplier_invoice_receipt_allocations WHERE purchase_receipt_item_id=?),0)+
  COALESCE((SELECT SUM(a.quantity_invoiced) FROM captured_supplier_invoice_receipts a JOIN captured_supplier_invoices d ON d.id=a.captured_invoice_id WHERE a.purchase_receipt_item_id=? AND d.status='captured'),0) allocated`,[receiptItemId,receiptItemId]))).rows[0];return Number(row.allocated);
}
async function allocate(req){
 return transaction(async tx=>{
  const doc=await getCapture(tx,req,req.params.id);await validateCapturePo(tx,req,doc);
  const raw=req.body.lines;if(!Array.isArray(raw)||!raw.length||raw.length>100)throw fail(400,'Select one to 100 receipt lines');
  const entries=raw.map(x=>{const q=String(x.quantity_invoiced??'');if(!/^\d{1,9}(?:\.\d{1,6})?$/.test(q)||Number(q)<=0)throw fail(400,'Billed quantities must be positive with up to six decimal places');return{item:id(x.receipt_item_id),quantity:Number(q),unit:cents(x.invoice_unit_cost)};});
  if(new Set(entries.map(x=>x.item)).size!==entries.length)throw fail(400,'A receipt line may appear only once');
  const op=operation(req,'allocate:'+doc.id,entries),previous=await replay(tx,op);if(previous)return{...previous,replayed:true};
  if(doc.status!=='captured')throw fail(409,'Only unposted captured invoices can receive new evidence');
  for(const line of entries){
   const receipt=(await tx.execute(sql('SELECT pri.quantity_received,pr.po_id,pr.supplier_id,pr.branch_id FROM purchase_receipt_items pri JOIN purchase_receipts pr ON pr.id=pri.receipt_id WHERE pri.id=?',[line.item]))).rows[0];
   if(!receipt||Number(receipt.po_id)!==Number(doc.purchase_order_id)||Number(receipt.branch_id)!==Number(doc.branch_id)||Number(receipt.supplier_id)!==Number(doc.supplier_id))throw fail(409,'Receipt line does not belong to this PO, supplier and branch');
   if(await allocatedQuantity(tx,line.item)+line.quantity>Number(receipt.quantity_received)+1e-6)throw fail(409,'Billed quantity exceeds available accepted receipt quantity');
   const amount=Math.round(line.quantity*line.unit);if(!Number.isSafeInteger(amount))throw fail(400,'Invoice amount exceeds supported precision');
   await tx.execute(sql('INSERT INTO captured_supplier_invoice_receipts(captured_invoice_id,purchase_receipt_item_id,quantity_invoiced,invoice_unit_cost_cents,invoice_line_cents,linked_by_employee_id) VALUES(?,?,?,?,?,?)',[doc.id,line.item,line.quantity,line.unit,amount,req.employee.id]));
  }
  await event(tx,req,doc.id,'receipts_linked',entries);const result={id:doc.id,status:'captured',payment_cleared:false};await remember(tx,op,doc.id,result);return result;
 });
}
async function voidCapture(req){return transaction(async tx=>{
 const doc=await getCapture(tx,req,req.params.id);if(doc.status==='void')return{...doc,replayed:true};if(doc.status!=='captured')throw fail(409,'Posted invoices require the Finance correction workflow');
 const reason=String(req.body.reason||'').trim();if(reason.length<5)throw fail(400,'Enter a meaningful reason for voiding this captured invoice');
 await tx.execute(sql("UPDATE captured_supplier_invoices SET status='void' WHERE id=? AND status='captured'",[doc.id]));await event(tx,req,doc.id,'voided',{reason});return{id:doc.id,status:'void'};
});}
async function list(executor,req,poId){
 await getPo(executor,req,poId);
 const invoices=(await executor.execute(sql(`SELECT d.*,COALESCE((SELECT SUM(a.invoice_line_cents) FROM captured_supplier_invoice_receipts a WHERE a.captured_invoice_id=d.id),0) allocated_cents FROM captured_supplier_invoices d WHERE d.purchase_order_id=? AND d.status='captured' ORDER BY d.id DESC`,[poId]))).rows;
 const links=(await executor.execute(sql("SELECT a.* FROM captured_supplier_invoice_receipts a JOIN captured_supplier_invoices d ON d.id=a.captured_invoice_id WHERE d.purchase_order_id=? AND d.status='captured' ORDER BY a.id",[poId]))).rows;
 return{invoices,links};
}
// Called before existing loss-prevention guards, so their duplicate/exception
// checks inspect the stored document, never financial values supplied at posting.
async function preparePosting(req){
 if(req.body.captured_invoice_id!=null){
  assertStaff(req);
  if(!can(req.employee.permissions,'reports_financial'))throw fail(403,'Finance permission is required to post a captured invoice');
  const doc=await getCapture(db,req,req.body.captured_invoice_id);
  if(doc.status==='void')throw fail(409,'Captured invoice was voided');
  if(doc.status==='posted')return{...(await db.execute(sql('SELECT * FROM supplier_invoices WHERE id=?',[doc.supplier_invoice_id]))).rows[0],replayed:true};
  await validateCapturePo(db,req,doc);
  req.invoiceCaptureId=Number(doc.id);
  req.body={...doc,match_override_reason:req.body.match_override_reason};
 }else{
  const normalized=normalize(req.body.invoice_number),supplierId=Number(req.body.supplier_id);
  const pending=(await db.execute(sql("SELECT id FROM captured_supplier_invoices WHERE supplier_id=? AND normalized_invoice_number=? AND status='captured'",[supplierId,normalized]))).rows[0];
  if(pending)throw fail(409,'This invoice is already captured. Finance must post the captured record.');
 }
 return null;
}
async function finishPosting(tx,req,invoiceId){
 if(!req.invoiceCaptureId){
  const pending=(await tx.execute(sql("SELECT id FROM captured_supplier_invoices WHERE supplier_id=? AND normalized_invoice_number=? AND status='captured'",[Number(req.body.supplier_id),normalize(req.body.invoice_number)]))).rows[0];
  if(pending)throw fail(409,'This invoice was captured during posting; Finance must post its captured record');
  return null;
 }
 const doc=await getCapture(tx,req,req.invoiceCaptureId);await validateCapturePo(tx,req,doc);
 if(doc.status!=='captured')throw fail(409,'Captured invoice has already been posted or voided');
 const lines=(await tx.execute(sql('SELECT * FROM captured_supplier_invoice_receipts WHERE captured_invoice_id=?',[doc.id]))).rows;
 for(const line of lines){
  const receipt=(await tx.execute(sql('SELECT pri.*,pr.po_id,pr.supplier_id,pr.branch_id FROM purchase_receipt_items pri JOIN purchase_receipts pr ON pr.id=pri.receipt_id WHERE pri.id=?',[line.purchase_receipt_item_id]))).rows[0];
  if(!receipt||Number(receipt.po_id)!==Number(doc.purchase_order_id)||Number(receipt.branch_id)!==Number(doc.branch_id)||Number(receipt.supplier_id)!==Number(doc.supplier_id)||await allocatedQuantity(tx,line.purchase_receipt_item_id)>Number(receipt.quantity_received)+1e-6)throw fail(409,'Receipt evidence changed; review before posting');
  await tx.execute(sql('INSERT INTO supplier_invoice_receipt_allocations(supplier_invoice_id,purchase_order_id,purchase_receipt_item_id,quantity_invoiced,invoice_unit_cost_cents,invoice_line_cents,linked_by_employee_id) VALUES(?,?,?,?,?,?,?)',[invoiceId,doc.purchase_order_id,line.purchase_receipt_item_id,line.quantity_invoiced,line.invoice_unit_cost_cents,line.invoice_line_cents,line.linked_by_employee_id]));
 }
 const sum=lines.reduce((s,x)=>s+Number(x.invoice_line_cents),0),expected=Math.round(doc.subtotal*100);
 const differences=(await tx.execute(sql('SELECT COUNT(*) n FROM captured_supplier_invoice_receipts a JOIN purchase_receipt_items pri ON pri.id=a.purchase_receipt_item_id WHERE a.captured_invoice_id=? AND a.invoice_unit_cost_cents!=ROUND(pri.unit_cost*100)',[doc.id]))).rows[0].n;
 const matchStatus=!lines.length?'unmatched_receipt':sum!==expected?'receipt_amount_variance':Number(differences)?'receipt_unit_cost_variance':'matched';
 await tx.execute(sql("UPDATE captured_supplier_invoices SET status='posted',supplier_invoice_id=?,posted_at=CURRENT_TIMESTAMP WHERE id=? AND status='captured'",[invoiceId,doc.id]));
 await event(tx,req,doc.id,'posted_to_ap',{supplier_invoice_id:invoiceId,match_status:matchStatus});
 return{matchStatus,variance:(sum-expected)/100,receivedValue:sum/100};
}
module.exports={ensureSchema,assertStaff,assertBranch,id,getPo,getCapture,capture,allocate,voidCapture,list,preparePosting,finishPosting,allocatedQuantity};
