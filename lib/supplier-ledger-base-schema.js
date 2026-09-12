'use strict';
const {db}=require('../database');
const {normalizeSupplierInvoiceNumber}=require('./supplier-invoice-identity');

let readyPromise=null;
async function ensureColumn(table,name,definition){
  const {rows}=await db.execute({sql:`PRAGMA table_info(${table})`,args:[]});
  if(!rows.some(r=>String(r.name)===name))await db.execute({sql:`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`,args:[]});
}
async function backfillNormalizedInvoiceIdentity(){
  const {rows}=await db.execute({sql:`SELECT id,supplier_id,invoice_number,status,normalized_invoice_number FROM supplier_invoices WHERE status!='void' ORDER BY id`,args:[]});
  const groups=new Map();
  for(const row of rows){
    const normalized=normalizeSupplierInvoiceNumber(row.invoice_number);
    if(!normalized)continue;
    const key=`${Number(row.supplier_id)}:${normalized}`;
    const list=groups.get(key)||[];list.push(row);groups.set(key,list);
  }
  for(const [key,list] of groups){
    if(list.length!==1)continue;
    const row=list[0],normalized=key.slice(key.indexOf(':')+1);
    if(String(row.normalized_invoice_number||'')===normalized)continue;
    await db.execute({sql:'UPDATE supplier_invoices SET normalized_invoice_number=? WHERE id=? AND normalized_invoice_number IS NULL',args:[normalized,row.id]});
  }
}
async function ensureSupplierLedgerBase(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS supplier_invoices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
        purchase_order_id INTEGER REFERENCES purchase_orders(id),
        branch_id INTEGER REFERENCES branches(id),
        invoice_number TEXT NOT NULL,
        normalized_invoice_number TEXT,
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
        UNIQUE(supplier_id, invoice_number)
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS supplier_payments (
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
      {sql:`CREATE TABLE IF NOT EXISTS supplier_payment_allocations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payment_id INTEGER NOT NULL REFERENCES supplier_payments(id),
        supplier_invoice_id INTEGER NOT NULL REFERENCES supplier_invoices(id),
        amount REAL NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(payment_id, supplier_invoice_id)
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS supplier_ledger_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        supplier_id INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id INTEGER NOT NULL,
        amount REAL,
        details TEXT,
        actor_employee_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:'CREATE INDEX IF NOT EXISTS idx_supplier_invoices_due ON supplier_invoices(status,due_date,supplier_id)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_supplier_payments_supplier ON supplier_payments(supplier_id,payment_date)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_supplier_ledger_events_supplier ON supplier_ledger_events(supplier_id,created_at)'}
    ],'write');
    await ensureColumn('supplier_invoices','normalized_invoice_number','TEXT');
    await backfillNormalizedInvoiceIdentity();
    await db.execute({sql:`CREATE UNIQUE INDEX IF NOT EXISTS ux_supplier_invoices_supplier_normalized_active ON supplier_invoices(supplier_id,normalized_invoice_number) WHERE status!='void' AND normalized_invoice_number IS NOT NULL`,args:[]});
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}

module.exports={ensureSupplierLedgerBase};
