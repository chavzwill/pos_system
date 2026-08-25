const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { syncBinQty } = require('../lib/binSync');
const { requirePermission, can } = require('../lib/permissions');

let receiptSchemaReady = false;
async function ensureReceiptSchema() {
  if (receiptSchemaReady) return;
  await db.batch([
    { sql: `CREATE TABLE IF NOT EXISTS purchase_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_number TEXT NOT NULL UNIQUE,
      po_id INTEGER NOT NULL REFERENCES purchase_orders(id),
      supplier_id INTEGER REFERENCES suppliers(id),
      branch_id INTEGER REFERENCES branches(id),
      received_by_employee_id INTEGER REFERENCES employees(id),
      received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      total_cost REAL NOT NULL DEFAULT 0
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS purchase_receipt_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_id INTEGER NOT NULL REFERENCES purchase_receipts(id),
      po_item_id INTEGER NOT NULL REFERENCES purchase_order_items(id),
      product_id INTEGER REFERENCES products(id),
      product_name TEXT,
      sku TEXT,
      quantity_received INTEGER NOT NULL,
      unit_cost REAL NOT NULL,
      line_cost REAL NOT NULL
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS landed_cost_allocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      allocation_number TEXT NOT NULL UNIQUE,
      supplier_invoice_id INTEGER NOT NULL UNIQUE REFERENCES supplier_invoices(id),
      po_id INTEGER NOT NULL REFERENCES purchase_orders(id),
      branch_id INTEGER REFERENCES branches(id),
      allocation_basis TEXT NOT NULL,
      capitalizable_amount REAL NOT NULL,
      allocated_by_employee_id INTEGER REFERENCES employees(id),
      allocated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      notes TEXT
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS landed_cost_allocation_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      allocation_id INTEGER NOT NULL REFERENCES landed_cost_allocations(id),
      purchase_receipt_item_id INTEGER NOT NULL REFERENCES purchase_receipt_items(id),
      receipt_id INTEGER NOT NULL REFERENCES purchase_receipts(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity_received INTEGER NOT NULL,
      original_unit_cost REAL NOT NULL,
      original_line_cost REAL NOT NULL,
      basis_value REAL NOT NULL,
      allocated_amount REAL NOT NULL,
      landed_cost_per_unit REAL NOT NULL,
      adjusted_unit_cost REAL NOT NULL,
      UNIQUE(allocation_id,purchase_receipt_item_id)
    )` },
    { sql: 'CREATE INDEX IF NOT EXISTS idx_purchase_receipts_po ON purchase_receipts(po_id)' },
    { sql: 'CREATE INDEX IF NOT EXISTS idx_purchase_receipt_items_receipt ON purchase_receipt_items(receipt_id)' },
    { sql: 'CREATE INDEX IF NOT EXISTS idx_landed_cost_allocations_po ON landed_cost_allocations(po_id)' },
    { sql: 'CREATE INDEX IF NOT EXISTS idx_landed_cost_items_allocation ON landed_cost_allocation_items(allocation_id)' },
  ], 'write');
  receiptSchemaReady = true;
}

router.use(requirePermission('purchasing'));
router.use(async (req, res, next) => {
  try { await ensureReceiptSchema(); next(); }
  catch (e) { res.status(500).json({ error: 'Purchase receipt evidence initialization failed', detail: e.message }); }
});

const STATUS_TRANSITIONS = {
  draft: new Set(['sent', 'approved', 'cancelled']),
  sent: new Set(['approved', 'cancelled']),
  approved: new Set(['cancelled']),
  partial: new Set(),
  received: new Set(),
  cancelled: new Set(),
};
function money(v){const n=Number(v);return Number.isFinite(n)?Number(n.toFixed(2)):NaN;}
function actor(req){return req.employee?.id||req.user?.employee_id||null;}

router.post('/', requirePermission('purchasing_create'), (req, res, next) => {
  const { supplier_id, branch_id, items } = req.body || {};
  if (!supplier_id) return res.status(400).json({ error: 'A supplier is required for a purchase order' });
  if (!branch_id) return res.status(400).json({ error: 'A receiving branch is required for a purchase order' });
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'No items in PO' });
  for (const item of items) {
    const qty = Number(item.quantity_ordered ?? item.quantity ?? 0);
    const cost = Number(item.unit_cost ?? 0);
    if (!Number.isInteger(qty) || qty <= 0) return res.status(400).json({ error: 'Every PO line requires a positive whole-number quantity' });
    if (!Number.isFinite(cost) || cost < 0) return res.status(400).json({ error: 'PO unit cost cannot be negative' });
  }
  next();
});

router.get('/:id/landed-cost-allocations', requirePermission('purchasing_approve'), async (req,res)=>{
  try{
    const {rows}=await db.execute({sql:`SELECT lca.*,si.invoice_number FROM landed_cost_allocations lca JOIN supplier_invoices si ON si.id=lca.supplier_invoice_id WHERE lca.po_id=? ORDER BY lca.id`,args:[req.params.id]});
    for(const row of rows){const r=await db.execute({sql:`SELECT lcai.*,pri.product_name,pri.sku,pr.receipt_number FROM landed_cost_allocation_items lcai JOIN purchase_receipt_items pri ON pri.id=lcai.purchase_receipt_item_id JOIN purchase_receipts pr ON pr.id=lcai.receipt_id WHERE lcai.allocation_id=? ORDER BY lcai.id`,args:[row.id]});row.items=r.rows;}
    res.json(rows);
  }catch(e){res.status(500).json({error:e.message});}
});

router.post('/:id/landed-cost-allocations', requirePermission('purchasing_approve'), async (req,res)=>{
  try{
    const poId=Number(req.params.id),invoiceId=Number(req.body?.supplier_invoice_id),basis=String(req.body?.basis||'value').toLowerCase();
    if(!invoiceId)return res.status(400).json({error:'supplier_invoice_id is required'});
    if(!['value','quantity','manual'].includes(basis))return res.status(400).json({error:'basis must be value, quantity, or manual'});
    const {rows:[po]}=await db.execute({sql:'SELECT * FROM purchase_orders WHERE id=?',args:[poId]});
    if(!po)return res.status(404).json({error:'Purchase order not found'});
    const {rows:[invoice]}=await db.execute({sql:`SELECT * FROM supplier_invoices WHERE id=? AND status!='void'`,args:[invoiceId]});
    if(!invoice)return res.status(404).json({error:'Supplier invoice not found'});
    if(Number(invoice.purchase_order_id)!==poId)return res.status(409).json({error:'Supplier invoice is not linked to this purchase order'});
    if(Number(invoice.supplier_id)!==Number(po.supplier_id))return res.status(409).json({error:'Supplier invoice supplier does not match purchase order supplier'});
    const landedTax=String(invoice.tax_treatment||'').toLowerCase()==='landed_cost'?Number(invoice.tax_amount||0):0;
    const amount=money(Number(invoice.freight_amount||0)+Number(invoice.duty_amount||0)+Number(invoice.other_landed_cost_amount||0)+landedTax);
    if(!Number.isFinite(amount)||amount<=0)return res.status(400).json({error:'This supplier invoice has no capitalizable landed cost to allocate'});
    const {rows:[existing]}=await db.execute({sql:'SELECT id,allocation_number FROM landed_cost_allocations WHERE supplier_invoice_id=?',args:[invoiceId]});
    if(existing)return res.status(409).json({error:`Supplier invoice landed cost is already allocated by ${existing.allocation_number}`});
    const {rows:receiptItems}=await db.execute({sql:`SELECT pri.*,pr.po_id FROM purchase_receipt_items pri JOIN purchase_receipts pr ON pr.id=pri.receipt_id WHERE pr.po_id=? AND pri.product_id IS NOT NULL ORDER BY pri.id`,args:[poId]});
    if(!receiptItems.length)return res.status(409).json({error:'No auditable product receipt lines exist for this purchase order'});
    let allocations=[];
    if(basis==='manual'){
      const supplied=Array.isArray(req.body?.allocations)?req.body.allocations:[];
      const map=new Map(supplied.map(x=>[Number(x.purchase_receipt_item_id),money(x.amount)]));
      for(const item of receiptItems){const a=map.get(Number(item.id));if(a!==undefined)allocations.push({item,allocated:a,basisValue:a});}
      if(allocations.length!==receiptItems.length||allocations.some(x=>!Number.isFinite(x.allocated)||x.allocated<0))return res.status(400).json({error:'Manual allocation must provide a non-negative amount for every receipt line'});
      const manualTotal=money(allocations.reduce((s,x)=>s+x.allocated,0));
      if(Math.abs(manualTotal-amount)>0.01)return res.status(400).json({error:`Manual allocations ${manualTotal.toFixed(2)} do not equal capitalizable landed cost ${amount.toFixed(2)}`});
    }else{
      const weighted=receiptItems.map(item=>({item,basisValue:basis==='quantity'?Number(item.quantity_received||0):Number(item.line_cost||0)}));
      if(weighted.some(x=>!Number.isFinite(x.basisValue)||x.basisValue<0))return res.status(409).json({error:'Receipt evidence contains an invalid allocation basis'});
      const denominator=weighted.reduce((s,x)=>s+x.basisValue,0);
      if(denominator<=0)return res.status(409).json({error:`Cannot allocate landed cost by ${basis}; receipt basis total is zero`});
      let used=0;
      allocations=weighted.map((x,i)=>{const allocated=i===weighted.length-1?money(amount-used):money(amount*x.basisValue/denominator);used=money(used+allocated);return {...x,allocated};});
    }
    const tx=await db.transaction('write');let committed=false;
    try{
      const number=`LCA-${poId}-${invoiceId}`;
      const r=await tx.execute({sql:`INSERT INTO landed_cost_allocations(allocation_number,supplier_invoice_id,po_id,branch_id,allocation_basis,capitalizable_amount,allocated_by_employee_id,notes) VALUES(?,?,?,?,?,?,?,?)`,args:[number,invoiceId,poId,po.branch_id||null,basis,amount,actor(req),req.body?.notes||null]});
      const allocationId=Number(r.lastInsertRowid);
      for(const x of allocations){
        const qty=Number(x.item.quantity_received),originalUnit=money(x.item.unit_cost),originalLine=money(x.item.line_cost),perUnit=money(x.allocated/qty),adjusted=money(originalUnit+perUnit);
        await tx.execute({sql:`INSERT INTO landed_cost_allocation_items(allocation_id,purchase_receipt_item_id,receipt_id,product_id,quantity_received,original_unit_cost,original_line_cost,basis_value,allocated_amount,landed_cost_per_unit,adjusted_unit_cost) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,args:[allocationId,x.item.id,x.item.receipt_id,x.item.product_id,qty,originalUnit,originalLine,x.basisValue,x.allocated,perUnit,adjusted]});
      }
      await tx.commit();committed=true;
      const {rows:[header]}=await db.execute({sql:'SELECT * FROM landed_cost_allocations WHERE id=?',args:[allocationId]});
      const {rows:items}=await db.execute({sql:'SELECT * FROM landed_cost_allocation_items WHERE allocation_id=? ORDER BY id',args:[allocationId]});
      res.status(201).json({...header,items});
    }catch(e){if(!committed)await tx.rollback();throw e;}
  }catch(e){res.status(400).json({error:e.message});}
});

router.patch('/:id/status', async (req, res) => {
  try {
    const target = String(req.body?.status || '');
    if (!['draft', 'sent', 'approved', 'cancelled'].includes(target)) return res.status(400).json({ error: 'Invalid status' });
    if (target === 'approved' && !req.apiKey && !can(req.employee.permissions, 'purchasing_approve')) return res.status(403).json({ error: 'Missing permission: purchasing_approve' });
    const { rows: [po] } = await db.execute({ sql: 'SELECT * FROM purchase_orders WHERE id = ?', args: [req.params.id] });
    if (!po) return res.status(404).json({ error: 'Not found' });
    if (po.status === target) return res.json(po);
    const allowed = STATUS_TRANSITIONS[po.status] || new Set();
    if (!allowed.has(target)) return res.status(400).json({ error: `Cannot move purchase order from ${po.status} to ${target}` });
    if (target === 'cancelled') {
      const { rows: [receipt] } = await db.execute({ sql: 'SELECT COALESCE(SUM(quantity_received),0) received FROM purchase_order_items WHERE po_id = ?', args: [req.params.id] });
      if (Number(receipt?.received) > 0) return res.status(400).json({ error: 'A partially received PO cannot be cancelled; use Close Short instead' });
    }
    await db.execute({ sql: 'UPDATE purchase_orders SET status = ? WHERE id = ?', args: [target, req.params.id] });
    const { rows: [updated] } = await db.execute({ sql: 'SELECT * FROM purchase_orders WHERE id = ?', args: [req.params.id] });
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/:id/receive', requirePermission('purchasing_receive'), async (req, res) => {
  try {
    const requested = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!requested.length) return res.status(400).json({ error: 'At least one received quantity is required' });
    const { rows: [po] } = await db.execute({ sql: 'SELECT * FROM purchase_orders WHERE id = ?', args: [req.params.id] });
    if (!po) return res.status(404).json({ error: 'Not found' });
    if (!['approved', 'partial'].includes(po.status)) return res.status(400).json({ error: `PO must be approved before receiving; current status is ${po.status}` });
    const seen = new Set();
    const validated = [];
    for (const line of requested) {
      const itemId = Number(line.item_id),qty = Number(line.quantity_received);
      if (!itemId || !Number.isInteger(qty) || qty <= 0) return res.status(400).json({ error: 'Each receipt line requires an item and positive whole-number quantity' });
      if (seen.has(itemId)) return res.status(400).json({ error: `PO item ${itemId} appears more than once in this receipt` });
      seen.add(itemId);
      const { rows: [item] } = await db.execute({ sql: 'SELECT * FROM purchase_order_items WHERE id = ? AND po_id = ?', args: [itemId, req.params.id] });
      if (!item) return res.status(400).json({ error: `PO item ${itemId} does not belong to this purchase order` });
      const remaining = Math.max(0, Number(item.quantity_ordered) - Number(item.quantity_received || 0));
      if (qty > remaining) return res.status(400).json({ error: `Cannot receive ${qty} of ${item.product_name}; only ${remaining} remain open` });
      const unitCost = Number(item.unit_cost || 0);
      if (!Number.isFinite(unitCost) || unitCost < 0) return res.status(409).json({ error: `Invalid unit cost evidence for ${item.product_name}` });
      validated.push({ item, qty, unitCost, lineCost: Number((qty * unitCost).toFixed(2)) });
    }
    const tx = await db.transaction('write');let committed = false;let receiptId = null;let receiptNumber = null;
    try {
      const receiptTotal = Number(validated.reduce((sum, x) => sum + x.lineCost, 0).toFixed(2));
      receiptNumber = `RCV-${po.id}-${Date.now()}`;
      const receiptResult = await tx.execute({sql:`INSERT INTO purchase_receipts(receipt_number,po_id,supplier_id,branch_id,received_by_employee_id,total_cost) VALUES (?,?,?,?,?,?)`,args:[receiptNumber,po.id,po.supplier_id||null,po.branch_id||null,actor(req),receiptTotal]});
      receiptId = Number(receiptResult.lastInsertRowid);
      for (const { item, qty, unitCost, lineCost } of validated) {
        await tx.execute({sql:`INSERT INTO purchase_receipt_items(receipt_id,po_item_id,product_id,product_name,sku,quantity_received,unit_cost,line_cost) VALUES (?,?,?,?,?,?,?,?)`,args:[receiptId,item.id,item.product_id||null,item.product_name||null,item.sku||null,qty,unitCost,lineCost]});
        await tx.execute({ sql: 'UPDATE purchase_order_items SET quantity_received = quantity_received + ? WHERE id = ?', args: [qty, item.id] });
        if (!item.product_id) continue;
        await tx.execute({ sql: 'UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?', args: [qty, item.product_id] });
        if (unitCost > 0) await tx.execute({ sql: 'UPDATE products SET cost = ? WHERE id = ?', args: [unitCost, item.product_id] });
        if (po.branch_id) {
          await tx.execute({sql:`INSERT INTO branch_inventory (product_id, branch_id, stock_qty, min_stock, updated_at) VALUES (?, ?, ?, (SELECT min_stock FROM products WHERE id = ?), CURRENT_TIMESTAMP) ON CONFLICT(product_id, branch_id) DO UPDATE SET stock_qty = stock_qty + ?, updated_at = CURRENT_TIMESTAMP`,args:[item.product_id,po.branch_id,qty,item.product_id,qty]});
          await syncBinQty(tx,item.product_id,po.branch_id,qty);
        }
        await tx.execute({sql:'INSERT INTO stock_movements (product_id, branch_id, quantity_change, type, reference, reason) VALUES (?,?,?,?,?,?)',args:[item.product_id,po.branch_id||null,qty,'purchase_receive',receiptNumber,`Received against ${po.po_number}`]});
      }
      const { rows: items } = await tx.execute({ sql: 'SELECT * FROM purchase_order_items WHERE po_id = ?', args: [req.params.id] });
      const allReceived = items.every(i => Number(i.quantity_received || 0) >= Number(i.quantity_ordered || 0));
      const newStatus = allReceived ? 'received' : 'partial';
      await tx.execute({ sql: 'UPDATE purchase_orders SET status = ?, received_at = ? WHERE id = ?', args: [newStatus, allReceived ? new Date().toISOString() : po.received_at, req.params.id] });
      if (allReceived) await tx.execute({ sql: `UPDATE purchase_requests SET status = 'received' WHERE converted_to_po_id = ? AND status != 'received'`, args: [req.params.id] });
      await tx.commit();committed = true;
    } catch (e) {if (!committed) await tx.rollback();return res.status(committed ? 500 : 400).json({ error: e.message });}
    const { rows: [updated] } = await db.execute({sql:`SELECT po.*, s.name supplier_name, b.name branch_name FROM purchase_orders po LEFT JOIN suppliers s ON s.id=po.supplier_id LEFT JOIN branches b ON b.id=po.branch_id WHERE po.id=?`,args:[req.params.id]});
    const { rows: items } = await db.execute({ sql: 'SELECT * FROM purchase_order_items WHERE po_id = ?', args: [req.params.id] });
    updated.items = items;updated.receipt_id = receiptId;updated.receipt_number = receiptNumber;res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/:id/close-short', requirePermission('purchasing_approve'), async (req, res) => {
  try {
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A reason is required to close a PO short' });
    const { rows: [po] } = await db.execute({ sql: 'SELECT * FROM purchase_orders WHERE id = ?', args: [req.params.id] });
    if (!po) return res.status(404).json({ error: 'Not found' });
    if (po.status !== 'partial') return res.status(400).json({ error: 'Only a partially received PO can be closed short' });
    const stamp = new Date().toISOString();
    const note = `${po.notes ? `${po.notes}\n` : ''}[Closed short ${stamp}] ${reason}`;
    const tx = await db.transaction('write');let committed = false;
    try {await tx.execute({ sql: `UPDATE purchase_orders SET status='received', received_at=CURRENT_TIMESTAMP, notes=? WHERE id=?`, args: [note, req.params.id] });await tx.execute({ sql: `UPDATE purchase_requests SET status='received' WHERE converted_to_po_id=? AND status!='received'`, args: [req.params.id] });await tx.commit(); committed = true;} catch (e) { if (!committed) await tx.rollback(); throw e; }
    const { rows: [updated] } = await db.execute({ sql: 'SELECT * FROM purchase_orders WHERE id=?', args: [req.params.id] });res.json(updated);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
module.exports.ensureReceiptSchema = ensureReceiptSchema;
