'use strict';
const crypto=require('node:crypto');
const {db}=require('../database');
const {can}=require('./permissions');
const {ensureLedger,postSourceJournal}=require('./accounting-posting');
const {settlementCarryingCents}=require('./supplier-return-settlement');
const {ensureUomSchema}=require('./unit-of-measure');
const {receivedBaseQuantity}=require('./supplier-returns');
const sql=(sql,args=[])=>({sql,args});
const fail=(status,message)=>Object.assign(new Error(message),{status});
let ready;
function ensureSupplierReturnReplacementSchema(){
 if(!ready)ready=(async()=>{
  await ensureLedger();await ensureUomSchema();
  await db.batch([
   sql("INSERT OR IGNORE INTO ledger_accounts(code,name,account_type,normal_balance,system_account) VALUES('1270','Supplier Return Clearing','asset','debit',1)"),
   sql("INSERT OR IGNORE INTO ledger_accounts(code,name,account_type,normal_balance,system_account) VALUES('5280','Supplier Return Variance','expense','debit',1)"),
   sql(`CREATE TABLE IF NOT EXISTS supplier_return_replacements(id INTEGER PRIMARY KEY AUTOINCREMENT,
    return_id INTEGER NOT NULL REFERENCES supplier_returns(id),return_item_id INTEGER NOT NULL REFERENCES supplier_return_items(id),
    replacement_receipt_item_id INTEGER NOT NULL REFERENCES purchase_receipt_items(id),quantity REAL NOT NULL CHECK(quantity>0),
    original_value REAL NOT NULL CHECK(original_value>=0),replacement_value REAL NOT NULL CHECK(replacement_value>=0),
    variance_reason TEXT NOT NULL,branch_id INTEGER NOT NULL,supplier_id INTEGER NOT NULL,
    created_by_employee_id INTEGER NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,operation_key TEXT NOT NULL UNIQUE)`),
   sql('CREATE INDEX IF NOT EXISTS idx_supplier_replacement_return ON supplier_return_replacements(return_item_id)'),
   sql('CREATE INDEX IF NOT EXISTS idx_supplier_replacement_receipt ON supplier_return_replacements(replacement_receipt_item_id)'),
   sql('CREATE TABLE IF NOT EXISTS supplier_return_replacement_operations(operation_key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,replacement_id INTEGER NOT NULL REFERENCES supplier_return_replacements(id),result_json TEXT NOT NULL)'),
   ...['supplier_return_replacements','supplier_return_replacement_operations'].flatMap(t=>[
    sql(`CREATE TRIGGER IF NOT EXISTS ${t}_immutable_update BEFORE UPDATE ON ${t} BEGIN SELECT RAISE(ABORT,'Replacement evidence is immutable'); END`),
    sql(`CREATE TRIGGER IF NOT EXISTS ${t}_immutable_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT,'Replacement evidence retains its audit history'); END`)
   ])
  ],'write');
 })().catch(e=>{ready=null;throw e;});return ready;
}
function id(value){const n=Number(value);if(!Number.isSafeInteger(n)||n<=0)throw fail(400,'A positive record ID is required');return n;}
function quantity(value){const s=String(value??'').trim();if(!/^\d{1,9}(?:\.\d{1,4})?$/.test(s)||Number(s)<=0)throw fail(400,'Replacement quantity must be positive with at most four decimal places');return Number(s);}
function assertStaff(req){if(req.apiKey||!req.employee||!can(req.employee.permissions,'reports_financial'))throw fail(403,'A Finance staff session is required to reconcile replacement receipts');}
function assertBranch(req,row){assertStaff(req);if((req.employee.default_branch_id==null||Number(req.employee.default_branch_id)!==Number(row.branch_id))&&!can(req.employee.permissions,'branches')&&!can(req.employee.permissions,'security_manage'))throw fail(403,'Return belongs to another receiving branch');}
async function getReturn(executor,req,returnId){assertStaff(req);const row=(await executor.execute(sql('SELECT * FROM supplier_returns WHERE id=?',[id(returnId)]))).rows[0];if(!row)throw fail(404,'Supplier return not found');assertBranch(req,row);return row;}
async function exists(executor,table){return !!(await executor.execute(sql("SELECT name FROM sqlite_master WHERE type='table' AND name=?",[table]))).rows[0];}
async function usedCredit(executor,returnItemId){if(!await exists(executor,'supplier_credit_items'))return 0;return Number((await executor.execute(sql("SELECT COALESCE(SUM(i.quantity),0) n FROM supplier_credit_items i JOIN supplier_credit_notes d ON d.id=i.credit_note_id WHERE i.return_item_id=? AND d.status IN ('captured','posted')",[returnItemId]))).rows[0].n);}
async function billed(executor,receiptItemId){let total=0;if(await exists(executor,'supplier_invoice_receipt_allocations'))total+=Number((await executor.execute(sql('SELECT COALESCE(SUM(quantity_invoiced),0) n FROM supplier_invoice_receipt_allocations WHERE purchase_receipt_item_id=?',[receiptItemId]))).rows[0].n);if(await exists(executor,'captured_supplier_invoice_receipts'))total+=Number((await executor.execute(sql("SELECT COALESCE(SUM(a.quantity_invoiced),0) n FROM captured_supplier_invoice_receipts a JOIN captured_supplier_invoices d ON d.id=a.captured_invoice_id WHERE a.purchase_receipt_item_id=? AND d.status='captured'",[receiptItemId]))).rows[0].n);return total;}
const cents=v=>Math.round(Number(v)*100);
async function postReplacementJournal(executor,rowOrId,actorId){
 const row=typeof rowOrId==='object'?rowOrId:(await executor.execute(sql('SELECT * FROM supplier_return_replacements WHERE id=?',[id(rowOrId)]))).rows[0];
 if(!row)throw fail(404,'Replacement evidence not found');
 const original=cents(row.original_value),replacement=cents(row.replacement_value),difference=original-replacement;
 if(!Number.isSafeInteger(original)||!Number.isSafeInteger(replacement)||original<0||replacement<0)throw fail(409,'Invalid replacement carrying value evidence');
 if(difference&&!String(row.variance_reason||'').trim())throw fail(409,'Finance must explain the replacement carrying value difference');
 const lines=[];if(replacement)lines.push({code:'1250',debit:replacement/100,credit:0,description:'Clear the actual replacement receipt'});if(original)lines.push({code:'1270',debit:0,credit:original/100,description:'Settle dispatched supplier return carrying value'});if(difference)lines.push({code:'5280',debit:Math.max(difference,0)/100,credit:Math.max(-difference,0)/100,description:row.variance_reason});
 // A zero-value exchange has no financial effect and needs no artificial journal.
 if(!lines.length)return null;
 return postSourceJournal({sourceType:'supplier_return_replacement',sourceId:row.id,sourceReference:String(row.return_id),entryDate:String(row.created_at||new Date().toISOString()).slice(0,10),description:`Supplier return ${row.return_id} replacement reconciliation`,branchId:row.branch_id,actorId:row.created_by_employee_id||actorId,lines,executor});
}
async function listReplacements(executor,returnId){return(await executor.execute(sql('SELECT * FROM supplier_return_replacements WHERE return_id=? ORDER BY id',[id(returnId)]))).rows;}
async function linkReplacement(req){
 assertStaff(req);await ensureSupplierReturnReplacementSchema();
 const body=req.body||{},returnId=id(req.params.id),data={return_id:returnId,return_item_id:id(body.return_item_id),replacement_receipt_item_id:id(body.replacement_receipt_item_id),quantity:quantity(body.quantity),variance_reason:String(body.variance_reason||'').trim()};
 if(data.variance_reason.length>4000)throw fail(400,'Variance reason is too long');
 const key=String(req.headers?.['idempotency-key']||'');if(!/^[A-Za-z0-9_.:-]{12,160}$/.test(key))throw fail(400,'Provide a stable Idempotency-Key of 12–160 safe characters');
 const operationKey='replacement:'+key,fingerprint=crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
 const tx=await db.transaction('write');try{
  const doc=await getReturn(tx,req,returnId);
  const old=(await tx.execute(sql('SELECT * FROM supplier_return_replacement_operations WHERE operation_key=?',[operationKey]))).rows[0];
  if(old){if(old.fingerprint!==fingerprint)throw fail(409,'Operation key already used for different replacement evidence');const result={...JSON.parse(old.result_json),replayed:true};await tx.commit();return result;}
  if(doc.status!=='dispatched')throw fail(409,'Dispatch the approved return before linking replacement receipts');
  const line=(await tx.execute(sql('SELECT * FROM supplier_return_items WHERE id=? AND return_id=?',[data.return_item_id,doc.id]))).rows[0];
  if(!line)throw fail(409,'Return item does not belong to this return');
  const receipt=(await tx.execute(sql(`SELECT i.*,r.po_id,r.supplier_id,r.branch_id,p.status po_status,p.supplier_id po_supplier_id,p.branch_id po_branch_id FROM purchase_receipt_items i JOIN purchase_receipts r ON r.id=i.receipt_id JOIN purchase_orders p ON p.id=r.po_id WHERE i.id=?`,[data.replacement_receipt_item_id]))).rows[0];
  if(!receipt||Number(receipt.po_id)===Number(doc.po_id)||Number(receipt.supplier_id)!==Number(doc.supplier_id)||Number(receipt.branch_id)!==Number(doc.branch_id)||Number(receipt.po_supplier_id)!==Number(doc.supplier_id)||Number(receipt.po_branch_id)!==Number(doc.branch_id)||Number(receipt.product_id)!==Number(line.product_id)||!['approved','partial','received'].includes(receipt.po_status))throw fail(409,'Replacement must be an actual receipt from a separate approved PO for the same supplier, branch and product');
  let receiptQuantity=await receivedBaseQuantity(tx,receipt),unitCost=Number(receipt.unit_cost);
  if(await exists(tx,'uom_usage_snapshots')){const snap=(await tx.execute(sql("SELECT * FROM uom_usage_snapshots WHERE source_type='purchase_receipt' AND source_id=? AND source_line_id=? ORDER BY id DESC LIMIT 1",[String(receipt.receipt_id),String(receipt.id)]))).rows[0];if(snap){receiptQuantity=Number(snap.base_quantity);unitCost=Number(snap.base_unit_price);if(Math.abs(receiptQuantity-Number(receipt.quantity_received))>0.00001)throw fail(409,'Receipt quantity conversion evidence requires review before replacement reconciliation');}}
  if(!Number.isFinite(receiptQuantity)||receiptQuantity<=0||!Number.isFinite(unitCost)||unitCost<0||Math.abs(cents(receiptQuantity*unitCost)-cents(receipt.line_cost))>1)throw fail(409,'Replacement receipt carrying value lacks consistent preserved evidence');
  const used=(await tx.execute(sql('SELECT COALESCE(SUM(quantity),0) n FROM supplier_return_replacements WHERE return_item_id=?',[line.id]))).rows[0];
  if(Number(used.n)+await usedCredit(tx,line.id)+data.quantity>Number(line.quantity)+0.000001)throw fail(409,'Replacement and credit quantities exceed the dispatched return quantity');
  const receiptUsed=(await tx.execute(sql('SELECT COALESCE(SUM(quantity),0) n FROM supplier_return_replacements WHERE replacement_receipt_item_id=?',[receipt.id]))).rows[0];
  if(Number(receiptUsed.n)+await billed(tx,receipt.id)+data.quantity>receiptQuantity+0.000001)throw fail(409,'Replacement quantity exceeds uninvoiced and unreserved receipt quantity');
  const fullOriginal=Number(line.tracked_value);if(line.tracked_value==null||!Number.isFinite(fullOriginal)||fullOriginal<0||!line.stock_movement_id)throw fail(409,'Dispatched return carrying value evidence is required');
  const originalValue=await settlementCarryingCents(tx,line,data.quantity)/100;
  const previousReceiptQuantity=Number(receiptUsed.n)+await billed(tx,receipt.id);
  const replacementValue=(cents(unitCost*(previousReceiptQuantity+data.quantity))-cents(unitCost*previousReceiptQuantity))/100;
  if(cents(originalValue)!==cents(replacementValue)&&data.variance_reason.length<5)throw fail(400,'Enter a meaningful Finance reason for the carrying value difference');
  const inserted=await tx.execute(sql('INSERT INTO supplier_return_replacements(return_id,return_item_id,replacement_receipt_item_id,quantity,original_value,replacement_value,variance_reason,branch_id,supplier_id,created_by_employee_id,operation_key) VALUES(?,?,?,?,?,?,?,?,?,?,?)',[doc.id,line.id,receipt.id,data.quantity,originalValue,replacementValue,data.variance_reason,doc.branch_id,doc.supplier_id,req.employee.id,operationKey]));
  const row=(await tx.execute(sql('SELECT * FROM supplier_return_replacements WHERE id=?',[Number(inserted.lastInsertRowid)]))).rows[0];
  await postReplacementJournal(tx,row,req.employee.id);
  await tx.execute(sql('INSERT INTO supplier_return_replacement_operations VALUES(?,?,?,?)',[operationKey,fingerprint,row.id,JSON.stringify(row)]));
  await tx.commit();return row;
 }catch(e){try{await tx.rollback();}catch{}throw e;}finally{tx.close();}
}
async function replacementDocument(req){assertStaff(req);await ensureSupplierReturnReplacementSchema();const doc=await getReturn(db,req,req.params.id);const replacements=await listReplacements(db,doc.id);const candidates=(await db.execute(sql(`SELECT i.id receipt_item_id,i.product_id,i.product_name,i.quantity_received,r.receipt_number,p.po_number,COALESCE((SELECT SUM(x.quantity) FROM supplier_return_replacements x WHERE x.replacement_receipt_item_id=i.id),0) linked_quantity FROM purchase_receipt_items i JOIN purchase_receipts r ON r.id=i.receipt_id JOIN purchase_orders p ON p.id=r.po_id WHERE r.supplier_id=? AND r.branch_id=? AND r.po_id!=? AND p.status IN ('approved','partial','received') AND EXISTS(SELECT 1 FROM supplier_return_items ri WHERE ri.return_id=? AND ri.product_id=i.product_id) ORDER BY i.id DESC LIMIT 200`,[doc.supplier_id,doc.branch_id,doc.po_id,doc.id]))).rows;for(const candidate of candidates){candidate.billed_quantity=await billed(db,candidate.receipt_item_id);candidate.available_quantity=Math.max(0,Number(candidate.quantity_received)-Number(candidate.linked_quantity)-candidate.billed_quantity);}return{replacements,candidate_receipts:candidates};}
module.exports={ensureSupplierReturnReplacementSchema,postReplacementJournal,listReplacements,linkReplacement,replacementDocument};
