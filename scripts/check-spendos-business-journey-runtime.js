'use strict';
const fs=require('fs'),path=require('path');
const root=path.join(__dirname,'..');
const dbPath=path.join(root,'spendos-business-journey-runtime.db');
try{fs.rmSync(dbPath);}catch{}
process.env.TURSO_DATABASE_URL='file:'+dbPath;
const {db,ensureReady}=require('../database');
const {ensureCostAllocationSchema,normalizeAllocations,insertAllocations,copyAllocations,recordInvoiceReconciliation}=require('../lib/cost-allocations');
const {ensureSupplierRecoverablesSchema,createShortageClaim}=require('../lib/supplier-recoverables');
const {confirmRecoverable}=require('../lib/supplier-recoverable-confirmation');
const {enqueuePurchaseRequested,enqueueSpendEvent}=require('../lib/spendos-outbox');
const {syncPurchasingAccounting}=require('../lib/accounting-purchasing');
const accountingSync=require('../routes/accounting-source-sync');

async function ensureRuntimeSchemas(){
  await db.batch([
    {sql:`CREATE TABLE IF NOT EXISTS purchase_receipts(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_number TEXT NOT NULL UNIQUE,
      po_id INTEGER NOT NULL REFERENCES purchase_orders(id),
      supplier_id INTEGER REFERENCES suppliers(id),
      branch_id INTEGER REFERENCES branches(id),
      received_by_employee_id INTEGER REFERENCES employees(id),
      received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      total_cost REAL NOT NULL DEFAULT 0
    )`},
    {sql:`CREATE TABLE IF NOT EXISTS purchase_receipt_items(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_id INTEGER NOT NULL REFERENCES purchase_receipts(id),
      po_item_id INTEGER NOT NULL REFERENCES purchase_order_items(id),
      product_id INTEGER REFERENCES products(id),
      product_name TEXT,
      sku TEXT,
      quantity_received INTEGER NOT NULL,
      unit_cost REAL NOT NULL,
      line_cost REAL NOT NULL
    )`},
    {sql:`CREATE TABLE IF NOT EXISTS supplier_invoices(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
      purchase_order_id INTEGER REFERENCES purchase_orders(id),
      branch_id INTEGER REFERENCES branches(id),
      invoice_number TEXT NOT NULL,
      invoice_date DATE NOT NULL,
      due_date DATE,
      subtotal REAL NOT NULL DEFAULT 0,
      tax_amount REAL NOT NULL DEFAULT 0,
      freight_amount REAL NOT NULL DEFAULT 0,
      duty_amount REAL NOT NULL DEFAULT 0,
      other_landed_cost_amount REAL NOT NULL DEFAULT 0,
      tax_treatment TEXT,
      total REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'posted',
      notes TEXT,
      posted_by INTEGER REFERENCES employees(id),
      posted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(supplier_id,invoice_number)
    )`},
    {sql:`CREATE TABLE IF NOT EXISTS supplier_payments(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_number TEXT NOT NULL UNIQUE,
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
      branch_id INTEGER REFERENCES branches(id),
      payment_date DATE NOT NULL,
      amount REAL NOT NULL,
      payment_method TEXT,
      reference TEXT,
      notes TEXT,
      recorded_by INTEGER REFERENCES employees(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`},
    {sql:`CREATE TABLE IF NOT EXISTS supplier_payment_allocations(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_id INTEGER NOT NULL REFERENCES supplier_payments(id),
      supplier_invoice_id INTEGER NOT NULL REFERENCES supplier_invoices(id),
      amount REAL NOT NULL
    )`}
  ],'write');
}
async function seedBase(){
  const b=await db.execute({sql:`INSERT INTO branches(branch_code,name,currency) VALUES('SBJ','SpendOS Journey','JMD')`,args:[]});
  const branchId=Number(b.lastInsertRowid);
  const e=await db.execute({sql:`INSERT INTO employees(employee_number,first_name,last_name,username,pin,role,active)
    VALUES('ESBJ','Spend','Tester','spend.journey','123456','manager',1)`,args:[]});
  const employeeId=Number(e.lastInsertRowid);
  const s=await db.execute({sql:`INSERT INTO suppliers(supplier_number,name,active) VALUES('SSBJ','Journey Supplier',1)`,args:[]});
  const supplierId=Number(s.lastInsertRowid);
  const p=await db.execute({sql:`INSERT INTO products(sku,name,price,cost,stock_qty,min_stock,active) VALUES('JSKU','Journey Item',150,100,0,0,1)`,args:[]});
  return {branchId,employeeId,supplierId,productId:Number(p.lastInsertRowid)};
}
async function line(journalId,code){
  const {rows:[r]}=await db.execute({sql:`SELECT jl.*,la.code FROM journal_lines jl JOIN ledger_accounts la ON la.id=jl.ledger_account_id WHERE jl.journal_entry_id=? AND la.code=?`,args:[journalId,code]});
  return r||null;
}
async function journal(sourceType,sourceId){
  const {rows:[j]}=await db.execute({sql:`SELECT * FROM journal_entries WHERE source_type=? AND source_id=? AND status='posted'`,args:[sourceType,String(sourceId)]});
  return j||null;
}
async function main(){
  await ensureReady();await ensureCostAllocationSchema();await ensureSupplierRecoverablesSchema();await ensureRuntimeSchemas();
  const ids=await seedBase();
  const tx=await db.transaction('write');let committed=false;
  let prId,prLineId,poId,poLineId,receiptId,receiptLineId;
  try{
    let r=await tx.execute({sql:`INSERT INTO purchase_requests(pr_number,branch_id,employee_id,department,status,request_type,supplier_id,currency,spendos_version)
      VALUES('PR-JOURNEY',?,?,?,'approved','sale_items',?,'JMD',1)`,args:[ids.branchId,ids.employeeId,'Operations',ids.supplierId]});
    prId=Number(r.lastInsertRowid);
    r=await tx.execute({sql:`INSERT INTO purchase_request_items(pr_id,product_id,product_name,sku,quantity,unit_cost,item_type,total)
      VALUES(?,?,?,?,10,100,'sale',1000)`,args:[prId,ids.productId,'Journey Item','JSKU']});
    prLineId=Number(r.lastInsertRowid);
    const requestAlloc=normalizeAllocations([{target_type:'branch',target_id:String(ids.branchId),target_label:'SpendOS Journey',allocation_amount:1000,allocation_percent:100,purpose:'Branch operating stock',expense_category:'inventory'}],1000);
    await insertAllocations(tx,{sourceType:'purchase_request',sourceId:prId,sourceLineId:prLineId,allocations:requestAlloc,createdBy:ids.employeeId});
    await enqueuePurchaseRequested(tx,{id:prId,pr_number:'PR-JOURNEY',branch_id:ids.branchId,employee_id:ids.employeeId,department:'Operations',request_type:'sale_items',supplier_id:ids.supplierId,currency:'JMD',status:'approved',sourceVersion:1,items:[{product_id:ids.productId,product_name:'Journey Item',sku:'JSKU',quantity:10,unit_cost:100,total:1000,allocations:requestAlloc}]});

    r=await tx.execute({sql:`INSERT INTO purchase_orders(po_number,supplier_id,branch_id,employee_id,status,subtotal,total) VALUES('PO-JOURNEY',?,?,?,'partial',1000,1000)`,args:[ids.supplierId,ids.branchId,ids.employeeId]});
    poId=Number(r.lastInsertRowid);
    r=await tx.execute({sql:`INSERT INTO purchase_order_items(po_id,product_id,product_name,sku,quantity_ordered,quantity_received,unit_cost,total) VALUES(?,?,?,?,10,6,100,1000)`,args:[poId,ids.productId,'Journey Item','JSKU']});
    poLineId=Number(r.lastInsertRowid);
    await copyAllocations(tx,{fromSourceType:'purchase_request',fromSourceId:prId,fromSourceLineId:prLineId,toSourceType:'purchase_order',toSourceId:poId,toSourceLineId:poLineId,ratio:1,createdBy:ids.employeeId,valuationStatus:'committed'});

    r=await tx.execute({sql:`INSERT INTO purchase_receipts(receipt_number,po_id,supplier_id,branch_id,received_by_employee_id,total_cost) VALUES('RCV-JOURNEY',?,?,?,?,600)`,args:[poId,ids.supplierId,ids.branchId,ids.employeeId]});
    receiptId=Number(r.lastInsertRowid);
    r=await tx.execute({sql:`INSERT INTO purchase_receipt_items(receipt_id,po_item_id,product_id,product_name,sku,quantity_received,unit_cost,line_cost) VALUES(?,?,?,?,?,6,100,600)`,args:[receiptId,poLineId,ids.productId,'Journey Item','JSKU']});
    receiptLineId=Number(r.lastInsertRowid);
    const receiptAlloc=await copyAllocations(tx,{fromSourceType:'purchase_order',fromSourceId:poId,fromSourceLineId:poLineId,toSourceType:'purchase_receipt',toSourceId:receiptId,toSourceLineId:receiptLineId,ratio:0.6,createdBy:ids.employeeId,valuationStatus:'actual'});
    await enqueueSpendEvent(tx,{id:`total-tools:purchase-receipt:${receiptId}:1`,type:'purchase.received',occurredAt:new Date().toISOString(),tenantId:'total-tools',source:'total-tools-pos',sourceRecordId:String(receiptId),sourceVersion:1,actorId:String(ids.employeeId),locationId:String(ids.branchId),departmentId:null,payload:{receiptNumber:'RCV-JOURNEY',poId:String(poId),poNumber:'PO-JOURNEY',supplierId:String(ids.supplierId),currency:'JMD',totalCost:600,items:[{poItemId:String(poLineId),receiptItemId:String(receiptLineId),productId:String(ids.productId),sku:'JSKU',description:'Journey Item',quantity:6,unitCost:100,lineCost:600,allocations:receiptAlloc.map(a=>({targetType:a.target_type,targetId:a.target_id,targetLabel:a.target_label,amount:a.allocation_amount,quantity:a.allocation_quantity,percent:a.allocation_percent,purpose:a.purpose,expenseCategory:a.expense_category,valuationStatus:a.valuation_status}))}]}});

    await tx.commit();committed=true;
  }catch(e){if(!committed)try{await tx.rollback();}catch{}throw e;}

  const {rows:[po]}=await db.execute({sql:'SELECT * FROM purchase_orders WHERE id=?',args:[poId]});
  let claim=await createShortageClaim(db,{po,ownerEmployeeId:ids.employeeId,reason:'Supplier delivered 6 of 10 units'});
  if(!claim||Number(claim.identified_amount)!==400||claim.status!=='identified')throw new Error('Shortage claim evidence mismatch');
  claim=await confirmRecoverable(db,claim,{confirmedAmount:400,supplierDocumentNumber:'CN-JOURNEY-400',confirmationNote:'Supplier acknowledged shortage'});
  if(claim.status!=='confirmed'||Number(claim.confirmed_amount)!==400)throw new Error('Recoverable confirmation failed');

  const inv=await db.execute({sql:`INSERT INTO supplier_invoices(supplier_id,purchase_order_id,branch_id,invoice_number,invoice_date,due_date,subtotal,total,status,posted_by,tax_treatment)
    VALUES(?,?,?,'INV-JOURNEY',date('now'),date('now','+30 days'),1000,1000,'posted',?,'none')`,args:[ids.supplierId,poId,ids.branchId,ids.employeeId]});
  const invoiceId=Number(inv.lastInsertRowid);
  const rec=await recordInvoiceReconciliation(db,{supplierInvoiceId:invoiceId,purchaseOrderId:poId,invoiceSubtotal:1000});
  if(rec.receivedValue!==600||rec.allocatedReceivedValue!==600||rec.variance!==400||rec.status!=='variance')throw new Error('Invoice/receipt allocation reconciliation mismatch');

  const st=await db.execute({sql:`INSERT INTO supplier_recoverable_settlements(claim_id,settlement_type,amount,reference,settlement_date,evidence_json,recorded_by_employee_id)
    VALUES(?,'ap_offset',400,'CN-JOURNEY-400',date('now'),'{}',?)`,args:[claim.id,ids.employeeId]});
  const settlementId=Number(st.lastInsertRowid);
  await db.execute({sql:`INSERT INTO supplier_recoverable_ap_allocations(settlement_id,claim_id,supplier_invoice_id,amount) VALUES(?,?,?,400)`,args:[settlementId,claim.id,invoiceId]});
  await db.execute({sql:`UPDATE supplier_recoverable_claims SET recovered_amount=400,status='recovered',recovered_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?`,args:[claim.id]});

  const stats={purchase_receipts:{posted:0,existing:0},landed_cost_allocations:{posted:0,existing:0},landed_cost_revaluations:{processed:0},supplier_invoices:{posted:0,existing:0},supplier_payments:{posted:0,existing:0},supplier_return_dispatch:{posted:0,existing:0},supplier_recoverable_recognition:{posted:0,existing:0},supplier_recoverable_settlements:{posted:0,existing:0},errors:[],reconciliation_issues:[],evidence_gaps:[]};
  await syncPurchasingAccounting({actorId:ids.employeeId,stats});
  await accountingSync.syncSupplierInvoices({employee:{id:ids.employeeId}},stats);
  await accountingSync.syncSupplierRecoverables({employee:{id:ids.employeeId}},stats);
  if(stats.errors.length)throw new Error('Accounting sync errors: '+stats.errors.join('; '));

  const jr=await journal('purchase_receipt',receiptId),ji=await journal('supplier_invoice',invoiceId),jrr=await journal('supplier_recoverable_recognition',claim.id),jrs=await journal('supplier_recoverable_settlement',settlementId);
  if(!jr||!ji||!jrr||!jrs)throw new Error('Expected accounting journals were not all posted');
  const r1200=await line(jr.id,'1200'),r1250=await line(jr.id,'1250');
  const i1250=await line(ji.id,'1250'),i2000=await line(ji.id,'2000');
  const rr1150=await line(jrr.id,'1150'),rr1250=await line(jrr.id,'1250');
  const rs2000=await line(jrs.id,'2000'),rs1150=await line(jrs.id,'1150');
  if(Number(r1200.debit)!==600||Number(r1250.credit)!==600)throw new Error('Receipt accounting mismatch');
  if(Number(i1250.debit)!==1000||Number(i2000.credit)!==1000)throw new Error('Supplier invoice accounting mismatch');
  if(Number(rr1150.debit)!==400||Number(rr1250.credit)!==400)throw new Error('Recoverable recognition accounting mismatch');
  if(Number(rs2000.debit)!==400||Number(rs1150.credit)!==400)throw new Error('Recoverable AP-offset accounting mismatch');

  const {rows:[payCount]}=await db.execute({sql:'SELECT COUNT(*) count FROM supplier_payments',args:[]});
  if(Number(payCount.count)!==0)throw new Error('Cash supplier payment was fabricated');
  const {rows:[ap]}=await db.execute({sql:`SELECT si.total-COALESCE((SELECT SUM(amount) FROM supplier_payment_allocations WHERE supplier_invoice_id=si.id),0)-COALESCE((SELECT SUM(amount) FROM supplier_recoverable_ap_allocations WHERE supplier_invoice_id=si.id),0) balance FROM supplier_invoices si WHERE id=?`,args:[invoiceId]});
  if(Number(ap.balance)!==600)throw new Error('True supplier payable should be 600 after recoverable offset');
  const {rows:allocs}=await db.execute({sql:`SELECT source_type,ROUND(SUM(allocation_amount),2) amount FROM cost_allocations WHERE (source_type='purchase_request' AND source_id=?) OR (source_type='purchase_order' AND source_id=?) OR (source_type='purchase_receipt' AND source_id=?) GROUP BY source_type`,args:[String(prId),String(poId),String(receiptId)]});
  const allocMap=Object.fromEntries(allocs.map(x=>[x.source_type,Number(x.amount)]));
  if(allocMap.purchase_request!==1000||allocMap.purchase_order!==1000||allocMap.purchase_receipt!==600)throw new Error('Allocation continuity mismatch');
  const {rows:events}=await db.execute({sql:`SELECT aggregate_type,COUNT(*) count FROM spendos_outbox GROUP BY aggregate_type ORDER BY aggregate_type`,args:[]});
  const eventMap=Object.fromEntries(events.map(x=>[x.aggregate_type,Number(x.count)]));
  if(eventMap.purchase_request!==1||eventMap.purchase_receipt!==1)throw new Error('SpendOS event continuity mismatch');

  const journalCountBefore=(await db.execute({sql:'SELECT COUNT(*) count FROM journal_entries',args:[]})).rows[0].count;
  await syncPurchasingAccounting({actorId:ids.employeeId,stats});
  await accountingSync.syncSupplierInvoices({employee:{id:ids.employeeId}},stats);
  await accountingSync.syncSupplierRecoverables({employee:{id:ids.employeeId}},stats);
  const journalCountAfter=(await db.execute({sql:'SELECT COUNT(*) count FROM journal_entries',args:[]})).rows[0].count;
  if(Number(journalCountBefore)!==Number(journalCountAfter))throw new Error('Accounting replay created duplicate journals');

  try{fs.rmSync(dbPath);}catch{}
  console.log(JSON.stringify({ok:true,po_value:1000,received_value:600,shortage_recoverable:400,ap_offset:400,true_payable:600,cash_paid:0,allocation_requested:1000,allocation_committed:1000,allocation_actual:600,journals:Number(journalCountAfter),outbox:eventMap}));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
