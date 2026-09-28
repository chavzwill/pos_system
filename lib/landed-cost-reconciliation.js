'use strict';

const {db}=require('../database');
const {ensureInventoryCostLayers}=require('./inventory-cost-layers');
const {ensureLandedCostRevaluationSchema,finalizeLandedCostAllocation}=require('./landed-cost-revaluation');

let readyPromise=null;
const money=v=>{const n=Number(v);return Number.isFinite(n)?Number(n.toFixed(2)):0;};
const money4=v=>{const n=Number(v);return Number.isFinite(n)?Number(n.toFixed(4)):0;};

function capitalizableAmount(invoice){
  const tax=String(invoice?.tax_treatment||'').toLowerCase()==='landed_cost'?money(invoice?.tax_amount):0;
  return money(money(invoice?.freight_amount)+money(invoice?.duty_amount)+money(invoice?.other_landed_cost_amount)+tax);
}

async function ensureColumn(table,name,definition){
  const {rows}=await db.execute({sql:`PRAGMA table_info(${table})`,args:[]});
  if(!rows.some(r=>String(r.name)===name))await db.execute({sql:`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`,args:[]});
}

async function ensureLandedCostReconciliationSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await ensureInventoryCostLayers();
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS landed_cost_allocations(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        allocation_number TEXT NOT NULL UNIQUE,
        supplier_invoice_id INTEGER NOT NULL UNIQUE REFERENCES supplier_invoices(id),
        po_id INTEGER NOT NULL REFERENCES purchase_orders(id),
        purchase_order_id INTEGER REFERENCES purchase_orders(id),
        branch_id INTEGER REFERENCES branches(id),
        capitalizable_amount REAL NOT NULL,
        allocation_basis TEXT NOT NULL DEFAULT 'received_value',
        allocated_by_employee_id INTEGER REFERENCES employees(id),
        allocated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        notes TEXT
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS landed_cost_allocation_items(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        allocation_id INTEGER NOT NULL REFERENCES landed_cost_allocations(id),
        purchase_receipt_item_id INTEGER NOT NULL REFERENCES purchase_receipt_items(id),
        receipt_id INTEGER NOT NULL REFERENCES purchase_receipts(id),
        product_id INTEGER NOT NULL REFERENCES products(id),
        quantity_received REAL NOT NULL,
        original_unit_cost REAL NOT NULL,
        original_line_cost REAL NOT NULL,
        basis_value REAL NOT NULL,
        allocated_amount REAL NOT NULL,
        landed_cost_per_unit REAL NOT NULL,
        adjusted_unit_cost REAL NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(allocation_id,purchase_receipt_item_id)
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS landed_cost_reconciliations(
        supplier_invoice_id INTEGER PRIMARY KEY REFERENCES supplier_invoices(id),
        purchase_order_id INTEGER REFERENCES purchase_orders(id),
        expected_amount REAL NOT NULL DEFAULT 0,
        allocated_amount REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        reason TEXT,
        allocation_id INTEGER REFERENCES landed_cost_allocations(id),
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`}
    ],'write');
    // Older builds established the purchase-receipt landed-cost tables first.
    // Preserve their NOT NULL audit columns while adding the canonical aliases
    // used by reconciliation. Never replace or drop historical evidence.
    await ensureColumn('landed_cost_allocations','allocation_number','TEXT');
    await ensureColumn('landed_cost_allocations','supplier_invoice_id','INTEGER');
    await ensureColumn('landed_cost_allocations','po_id','INTEGER');
    await ensureColumn('landed_cost_allocations','purchase_order_id','INTEGER');
    await ensureColumn('landed_cost_allocations','branch_id','INTEGER');
    await ensureColumn('landed_cost_allocations','capitalizable_amount','REAL NOT NULL DEFAULT 0');
    await ensureColumn('landed_cost_allocations','allocation_basis',"TEXT NOT NULL DEFAULT 'received_value'");
    await ensureColumn('landed_cost_allocations','allocated_by_employee_id','INTEGER');
    await ensureColumn('landed_cost_allocations','allocated_at','DATETIME');
    await ensureColumn('landed_cost_allocations','notes','TEXT');
    await ensureColumn('landed_cost_allocation_items','allocation_id','INTEGER');
    await ensureColumn('landed_cost_allocation_items','purchase_receipt_item_id','INTEGER');
    await ensureColumn('landed_cost_allocation_items','receipt_id','INTEGER');
    await ensureColumn('landed_cost_allocation_items','product_id','INTEGER');
    await ensureColumn('landed_cost_allocation_items','quantity_received','REAL NOT NULL DEFAULT 0');
    await ensureColumn('landed_cost_allocation_items','original_unit_cost','REAL NOT NULL DEFAULT 0');
    await ensureColumn('landed_cost_allocation_items','original_line_cost','REAL NOT NULL DEFAULT 0');
    await ensureColumn('landed_cost_allocation_items','basis_value','REAL NOT NULL DEFAULT 0');
    await ensureColumn('landed_cost_allocation_items','allocated_amount','REAL NOT NULL DEFAULT 0');
    await ensureColumn('landed_cost_allocation_items','landed_cost_per_unit','REAL NOT NULL DEFAULT 0');
    await ensureColumn('landed_cost_allocation_items','adjusted_unit_cost','REAL NOT NULL DEFAULT 0');
    await ensureColumn('landed_cost_allocation_items','created_at','DATETIME');
    await db.batch([
      {sql:'UPDATE landed_cost_allocations SET purchase_order_id=po_id WHERE purchase_order_id IS NULL AND po_id IS NOT NULL'},
      {sql:'UPDATE landed_cost_allocations SET po_id=purchase_order_id WHERE po_id IS NULL AND purchase_order_id IS NOT NULL'},
      {sql:'CREATE UNIQUE INDEX IF NOT EXISTS ux_landed_cost_allocation_invoice ON landed_cost_allocations(supplier_invoice_id) WHERE supplier_invoice_id IS NOT NULL'},
      {sql:'CREATE UNIQUE INDEX IF NOT EXISTS ux_landed_cost_allocation_number ON landed_cost_allocations(allocation_number) WHERE allocation_number IS NOT NULL'},
      {sql:'CREATE UNIQUE INDEX IF NOT EXISTS ux_landed_cost_allocation_item_receipt ON landed_cost_allocation_items(allocation_id,purchase_receipt_item_id) WHERE allocation_id IS NOT NULL AND purchase_receipt_item_id IS NOT NULL'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_landed_cost_allocations_po2 ON landed_cost_allocations(purchase_order_id,allocated_at)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_landed_cost_items_receipt ON landed_cost_allocation_items(receipt_id,purchase_receipt_item_id)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_landed_cost_reconciliation_status ON landed_cost_reconciliations(status,updated_at)'}
    ],'write');
    await ensureLandedCostRevaluationSchema();
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}

function allocateCents(total,rows){
  const cents=Math.round(money(total)*100);
  const receivedValue=rows.reduce((s,r)=>s+Math.max(0,Number(r.line_cost||0)),0);
  const qtyTotal=rows.reduce((s,r)=>s+Math.max(0,Number(r.quantity_received||0)),0);
  const basis=receivedValue>0?'received_value':'received_quantity';
  const denominator=receivedValue>0?receivedValue:qtyTotal;
  if(cents<=0)return {basis,amounts:rows.map(()=>0)};
  if(!(denominator>0))throw new Error('No positive receipt value or quantity exists for landed-cost allocation');
  let used=0;
  const amounts=rows.map((r,index)=>{
    if(index===rows.length-1)return Number(((cents-used)/100).toFixed(2));
    const weight=receivedValue>0?Math.max(0,Number(r.line_cost||0)):Math.max(0,Number(r.quantity_received||0));
    const part=Math.floor(cents*(weight/denominator));
    used+=part;
    return Number((part/100).toFixed(2));
  });
  return {basis,amounts};
}

async function setPending(executor,invoice,expected,reason){
  await executor.execute({sql:`INSERT INTO landed_cost_reconciliations(supplier_invoice_id,purchase_order_id,expected_amount,allocated_amount,status,reason,allocation_id,updated_at)
    VALUES(?,?,?,?,?,?,NULL,CURRENT_TIMESTAMP)
    ON CONFLICT(supplier_invoice_id) DO UPDATE SET purchase_order_id=excluded.purchase_order_id,expected_amount=excluded.expected_amount,status='pending',reason=excluded.reason,updated_at=CURRENT_TIMESTAMP
    WHERE landed_cost_reconciliations.status!='allocated'`,args:[invoice.id,invoice.purchase_order_id||null,expected,0,'pending',reason]});
  return {supplier_invoice_id:Number(invoice.id),status:'pending',expected_amount:expected,allocated_amount:0,reason};
}

async function reconcileSupplierInvoiceLandedCosts(executor,invoiceId,{actorId=null}={}){
  const {rows:[invoice]}=await executor.execute({sql:`SELECT id,purchase_order_id,branch_id,tax_amount,freight_amount,duty_amount,other_landed_cost_amount,tax_treatment FROM supplier_invoices WHERE id=? AND status!='void'`,args:[invoiceId]});
  if(!invoice)throw new Error('Supplier invoice not found for landed-cost reconciliation');
  const expected=capitalizableAmount(invoice);
  if(expected<=0){
    await executor.execute({sql:`INSERT INTO landed_cost_reconciliations(supplier_invoice_id,purchase_order_id,expected_amount,allocated_amount,status,reason,updated_at)
      VALUES(?,?,?,?,?,'No capitalizable landed cost on supplier invoice',CURRENT_TIMESTAMP)
      ON CONFLICT(supplier_invoice_id) DO UPDATE SET expected_amount=0,allocated_amount=0,status='not_required',reason='No capitalizable landed cost on supplier invoice',updated_at=CURRENT_TIMESTAMP`,args:[invoice.id,invoice.purchase_order_id||null,0,0,'not_required']});
    return {supplier_invoice_id:Number(invoice.id),status:'not_required',expected_amount:0,allocated_amount:0};
  }
  const {rows:[existing]}=await executor.execute({sql:`SELECT r.*,a.allocation_number FROM landed_cost_reconciliations r LEFT JOIN landed_cost_allocations a ON a.id=r.allocation_id WHERE r.supplier_invoice_id=?`,args:[invoice.id]});
  if(existing?.status==='allocated'){
    if(Math.abs(money(existing.expected_amount)-expected)>0.01||Math.abs(money(existing.allocated_amount)-expected)>0.01)throw new Error('Existing landed-cost allocation no longer reconciles to supplier invoice');
    return {...existing,replayed:true};
  }
  if(!invoice.purchase_order_id)return setPending(executor,invoice,expected,'Capitalizable landed cost requires a linked purchase order before receipt allocation.');
  const {rows:receiptItems}=await executor.execute({sql:`SELECT pri.id purchase_receipt_item_id,pri.receipt_id,pri.product_id,pri.quantity_received,pri.unit_cost,pri.line_cost,pr.branch_id
    FROM purchase_receipt_items pri JOIN purchase_receipts pr ON pr.id=pri.receipt_id
    WHERE pr.po_id=? AND pri.product_id IS NOT NULL AND pri.quantity_received>0 ORDER BY pr.received_at,pr.id,pri.id`,args:[invoice.purchase_order_id]});
  if(!receiptItems.length)return setPending(executor,invoice,expected,'No eligible received inventory exists for this purchase order yet.');
  const unresolved=receiptItems.filter(r=>!r.product_id||Number(r.quantity_received)<=0||Number(r.unit_cost)<0);
  if(unresolved.length)return setPending(executor,invoice,expected,'One or more purchase receipt lines lack valid product, quantity, or cost evidence.');
  const {basis,amounts}=allocateCents(expected,receiptItems);
  const allocationNumber=`LCA-${invoice.id}`;
  const allocationInsert=await executor.execute({sql:`INSERT OR IGNORE INTO landed_cost_allocations(allocation_number,supplier_invoice_id,po_id,purchase_order_id,branch_id,capitalizable_amount,allocation_basis,allocated_by_employee_id,allocated_at,notes)
    VALUES(?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,?)`,args:[allocationNumber,invoice.id,invoice.purchase_order_id,invoice.purchase_order_id,invoice.branch_id||receiptItems[0].branch_id||null,expected,basis,actorId,'Automatically reconciled from supplier invoice landed-cost components to immutable purchase receipt evidence.']});
  let allocationId=Number(allocationInsert.lastInsertRowid||0);
  if(!allocationId){
    const {rows:[row]}=await executor.execute({sql:'SELECT id,capitalizable_amount FROM landed_cost_allocations WHERE supplier_invoice_id=?',args:[invoice.id]});
    if(!row)throw new Error('Landed-cost allocation identity conflict could not be resolved');
    if(Math.abs(money(row.capitalizable_amount)-expected)>0.01)throw new Error('Existing landed-cost allocation amount conflicts with supplier invoice');
    allocationId=Number(row.id);
  }
  for(let i=0;i<receiptItems.length;i++){
    const r=receiptItems[i],allocated=money(amounts[i]);
    const qty=Number(r.quantity_received),original=money4(r.unit_cost),lineCost=money4(r.line_cost),basisValue=basis==='received_value'?lineCost:money4(qty),per=qty>0?money4(allocated/qty):0,adjusted=money4(original+per);
    await executor.execute({sql:`INSERT OR IGNORE INTO landed_cost_allocation_items(allocation_id,purchase_receipt_item_id,receipt_id,product_id,quantity_received,original_unit_cost,original_line_cost,basis_value,allocated_amount,landed_cost_per_unit,adjusted_unit_cost,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,args:[allocationId,r.purchase_receipt_item_id,r.receipt_id,r.product_id,qty,original,lineCost,basisValue,allocated,per,adjusted]});
  }
  const {rows:[sum]}=await executor.execute({sql:'SELECT ROUND(COALESCE(SUM(allocated_amount),0),2) allocated,COUNT(*) item_count FROM landed_cost_allocation_items WHERE allocation_id=?',args:[allocationId]});
  const allocated=money(sum?.allocated||0);
  if(Number(sum?.item_count||0)!==receiptItems.length||Math.abs(allocated-expected)>0.01)throw new Error(`Landed-cost allocation does not reconcile: expected ${expected.toFixed(2)}, allocated ${allocated.toFixed(2)}`);
  const revaluations=await finalizeLandedCostAllocation(executor,allocationId);
  const split=money(revaluations.reduce((s,r)=>s+Number(r.inventory_adjustment||0)+Number(r.cogs_adjustment||0),0));
  if(Math.abs(split-expected)>0.01)throw new Error(`Landed-cost revaluation split does not reconcile: expected ${expected.toFixed(2)}, split ${split.toFixed(2)}`);
  await executor.execute({sql:`INSERT INTO landed_cost_reconciliations(supplier_invoice_id,purchase_order_id,expected_amount,allocated_amount,status,reason,allocation_id,updated_at)
    VALUES(?,?,?,?,?,'Receipt-line allocation and revaluation reconciled',?,CURRENT_TIMESTAMP)
    ON CONFLICT(supplier_invoice_id) DO UPDATE SET purchase_order_id=excluded.purchase_order_id,expected_amount=excluded.expected_amount,allocated_amount=excluded.allocated_amount,status='allocated',reason=excluded.reason,allocation_id=excluded.allocation_id,updated_at=CURRENT_TIMESTAMP`,args:[invoice.id,invoice.purchase_order_id,expected,allocated,'allocated',allocationId]});
  return {supplier_invoice_id:Number(invoice.id),status:'allocated',expected_amount:expected,allocated_amount:allocated,allocation_id:allocationId,allocation_number:allocationNumber,revaluation_split:split};
}

async function reconcilePurchaseOrderLandedCosts(executor,poId,{actorId=null}={}){
  const {rows}=await executor.execute({sql:`SELECT id FROM supplier_invoices WHERE purchase_order_id=? AND status!='void' ORDER BY id`,args:[poId]});
  const results=[];
  for(const row of rows)results.push(await reconcileSupplierInvoiceLandedCosts(executor,row.id,{actorId}));
  return results;
}

module.exports={ensureLandedCostReconciliationSchema,capitalizableAmount,reconcileSupplierInvoiceLandedCosts,reconcilePurchaseOrderLandedCosts,allocateCents};
