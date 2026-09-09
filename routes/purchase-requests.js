const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission } = require('../lib/permissions');
const { nextNumber } = require('../lib/nextNumber');

let variationSchemaReady = null;
async function ensureVariationSchema() {
  if (variationSchemaReady) return variationSchemaReady;
  variationSchemaReady = (async () => {
    for (const table of ['purchase_request_items','purchase_order_items']) {
      const { rows } = await db.execute({ sql: `PRAGMA table_info(${table})`, args: [] });
      if (!rows.some(x => x.name === 'variation_id')) {
        await db.execute({ sql: `ALTER TABLE ${table} ADD COLUMN variation_id INTEGER REFERENCES product_variations(id)`, args: [] });
      }
    }
    await db.batch([
      { sql: 'CREATE INDEX IF NOT EXISTS idx_purchase_request_items_variation ON purchase_request_items(product_id,variation_id)' },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_purchase_order_items_variation ON purchase_order_items(product_id,variation_id)' },
    ], 'write');
  })().catch(e => { variationSchemaReady = null; throw e; });
  return variationSchemaReady;
}

router.use(requirePermission('purchase_requests'));
router.use(async (req,res,next) => {
  try { await ensureVariationSchema(); next(); }
  catch (e) { res.status(500).json({ error: 'Purchase-request variation authority initialization failed', detail: e.message }); }
});

const PR_SELECT = `
  SELECT pr.*,
    b.name as branch_name,
    e.first_name || ' ' || e.last_name as employee_name,
    a.first_name || ' ' || a.last_name as approver_name,
    s.name as supplier_name,
    s.is_local as supplier_is_local,
    po.po_number as converted_po_number
  FROM purchase_requests pr
  LEFT JOIN branches b ON pr.branch_id = b.id
  LEFT JOIN employees e ON pr.employee_id = e.id
  LEFT JOIN employees a ON pr.approved_by = a.id
  LEFT JOIN suppliers s ON pr.supplier_id = s.id
  LEFT JOIN purchase_orders po ON pr.converted_to_po_id = po.id`;

const PR_ITEM_SELECT = `SELECT pri.*, p.name as linked_product_name,
  pv.name as variation_name,pv.sku as variation_sku,pv.active as variation_active,
  (SELECT COUNT(*) FROM product_variations x WHERE x.product_id=pri.product_id AND x.active=1) as active_variation_count
  FROM purchase_request_items pri
  LEFT JOIN products p ON pri.product_id=p.id
  LEFT JOIN product_variations pv ON pv.id=pri.variation_id`;

router.get('/', async (req, res) => {
  try {
    const { status, request_type, branch_id, employee_id, start, end, limit = 100 } = req.query;
    let sql = PR_SELECT + ' WHERE 1=1';
    const params = [];
    if (status) { sql += ' AND pr.status = ?'; params.push(status); }
    if (request_type) { sql += ' AND pr.request_type = ?'; params.push(request_type); }
    if (branch_id) { sql += ' AND pr.branch_id = ?'; params.push(branch_id); }
    if (employee_id) { sql += ' AND pr.employee_id = ?'; params.push(employee_id); }
    if (start) { sql += ' AND date(pr.created_at) >= ?'; params.push(start); }
    if (end) { sql += ' AND date(pr.created_at) <= ?'; params.push(end); }
    sql += ' ORDER BY pr.created_at DESC LIMIT ?';
    params.push(parseInt(limit));
    const { rows } = await db.execute({ sql, args: params });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const { rows: [pr] } = await db.execute({ sql: PR_SELECT + ' WHERE pr.id = ?', args: [req.params.id] });
    if (!pr) return res.status(404).json({ error: 'Not found' });
    const { rows: items } = await db.execute({ sql: PR_ITEM_SELECT + ' WHERE pri.pr_id = ? ORDER BY pri.id', args: [req.params.id] });
    pr.items = items;
    res.json(pr);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

async function resolveRequestedVariation(item) {
  if (!item.product_id || !item.variation_id) return null;
  const { rows: [variation] } = await db.execute({
    sql: 'SELECT id,product_id,name,sku,cost,active FROM product_variations WHERE id=? AND product_id=?',
    args: [item.variation_id,item.product_id]
  });
  if (!variation || Number(variation.active) === 0) {
    const error = new Error('Selected purchase-request variation does not belong to the product or is inactive');
    error.status = 409; error.control = 'pr_variation_invalid'; throw error;
  }
  return variation;
}

async function processPRItems(items, request_type) {
  const processedItems = [];
  for (const item of items) {
    const product = item.product_id ? (await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [item.product_id] })).rows[0] : null;
    if (item.product_id && !product) throw Object.assign(new Error(`Product ${item.product_id} was not found`), { status:409 });
    const variation = await resolveRequestedVariation(item);
    const unit_cost = parseFloat(item.unit_cost || (variation?.cost ?? (product ? product.cost : 0))) || 0;
    const qty = parseInt(item.quantity || 1);
    const item_type = item.item_type || (request_type === 'internal_use' ? 'internal' : 'sale');
    processedItems.push({
      product_id: item.product_id || null,
      variation_id: variation?.id || null,
      product_name: item.product_name || (product ? product.name : 'Unknown'),
      sku: variation?.sku || item.sku || (product ? product.sku : ''),
      quantity: qty,
      unit_cost,
      item_type,
      product_url: item.product_url || null,
      notes: item.notes || null,
      quotation_item_id: item.quotation_item_id || null,
      total: parseFloat((unit_cost * qty).toFixed(2))
    });
  }
  return processedItems;
}

router.post('/', async (req, res) => {
  try {
    const { branch_id, employee_id, department, notes, required_date, request_type = 'sale_items', supplier_id, currency, is_online_purchase, tax_rate, tax_amount, items } = req.body;
    if (!items || items.length === 0) return res.status(400).json({ error: 'No items in purchase request' });
    if (!['sale_items', 'internal_use'].includes(request_type)) return res.status(400).json({ error: 'Invalid request_type' });

    const pr_number = await nextNumber(db, 'purchase_requests', 'pr_number', 'PR-', 6);
    const processedItems = await processPRItems(items, request_type);
    const tx = await db.transaction('write'); let committed = false;
    try {
      const result = await tx.execute({
        sql: 'INSERT INTO purchase_requests (pr_number, branch_id, employee_id, department, notes, required_date, request_type, supplier_id, currency, is_online_purchase, tax_rate, tax_amount) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        args: [pr_number, branch_id||null, employee_id||null, department||null, notes||null, required_date||null, request_type, supplier_id||null, currency||null, is_online_purchase?1:0, parseFloat(tax_rate)||0, parseFloat(tax_amount)||0]
      });
      const prId = Number(result.lastInsertRowid);
      for (const item of processedItems) {
        await tx.execute({
          sql: 'INSERT INTO purchase_request_items (pr_id, product_id, variation_id, product_name, sku, quantity, unit_cost, item_type, product_url, notes, total, quotation_item_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          args: [prId, item.product_id, item.variation_id, item.product_name, item.sku, item.quantity, item.unit_cost, item.item_type, item.product_url, item.notes, item.total, item.quotation_item_id]
        });
      }
      await tx.commit(); committed = true;
      const { rows: [pr] } = await db.execute({ sql: PR_SELECT + ' WHERE pr.id = ?', args: [prId] });
      const { rows: prItems } = await db.execute({ sql: PR_ITEM_SELECT + ' WHERE pri.pr_id=? ORDER BY pri.id', args: [prId] });
      pr.items = prItems; res.status(201).json(pr);
    } catch(e) {
      if (!committed) await tx.rollback();
      res.status(committed ? 500 : (e.status||400)).json({ error: e.message, control:e.control });
    }
  } catch(e) { res.status(e.status||500).json({ error: e.message, control:e.control }); }
});

router.put('/:id', async (req, res) => {
  try {
    const { rows: [pr] } = await db.execute({ sql: 'SELECT * FROM purchase_requests WHERE id = ?', args: [req.params.id] });
    if (!pr) return res.status(404).json({ error: 'Not found' });
    if (pr.status !== 'draft') return res.status(400).json({ error: 'Only draft purchase requests can be edited' });

    const { branch_id, employee_id, department, notes, required_date, request_type = pr.request_type, supplier_id, currency, is_online_purchase, tax_rate, tax_amount, items } = req.body;
    if (!items || items.length === 0) return res.status(400).json({ error: 'No items in purchase request' });
    if (!['sale_items', 'internal_use'].includes(request_type)) return res.status(400).json({ error: 'Invalid request_type' });
    const processedItems = await processPRItems(items, request_type);

    const tx = await db.transaction('write'); let committed = false;
    try {
      const updated = await tx.execute({
        sql: `UPDATE purchase_requests SET branch_id=?,employee_id=?,department=?,notes=?,required_date=?,request_type=?,supplier_id=?,currency=?,is_online_purchase=?,tax_rate=?,tax_amount=? WHERE id=? AND status='draft'`,
        args: [branch_id||null, employee_id||pr.employee_id||null, department||null, notes||null, required_date||null, request_type, supplier_id||null, currency||null, is_online_purchase?1:0, parseFloat(tax_rate)||0, parseFloat(tax_amount)||0, pr.id]
      });
      if (Number(updated.rowsAffected||0) !== 1) throw Object.assign(new Error('Purchase request changed before the draft edit could be committed'), { status:409, control:'pr_stale_edit' });
      await tx.execute({ sql: 'DELETE FROM purchase_request_items WHERE pr_id = ?', args: [pr.id] });
      for (const item of processedItems) {
        await tx.execute({
          sql: 'INSERT INTO purchase_request_items (pr_id, product_id, variation_id, product_name, sku, quantity, unit_cost, item_type, product_url, notes, total, quotation_item_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          args: [pr.id, item.product_id, item.variation_id, item.product_name, item.sku, item.quantity, item.unit_cost, item.item_type, item.product_url, item.notes, item.total, item.quotation_item_id]
        });
      }
      await tx.commit(); committed = true;
      const { rows: [row] } = await db.execute({ sql: PR_SELECT + ' WHERE pr.id = ?', args: [pr.id] });
      const { rows: prItems } = await db.execute({ sql: PR_ITEM_SELECT + ' WHERE pri.pr_id=? ORDER BY pri.id', args: [pr.id] });
      row.items = prItems; res.json(row);
    } catch(e) {
      if (!committed) await tx.rollback();
      res.status(committed ? 500 : (e.status||400)).json({ error: e.message, control:e.control });
    }
  } catch(e) { res.status(e.status||500).json({ error: e.message, control:e.control }); }
});

router.patch('/:id/status', async (req, res) => {
  try {
    const { status, approved_by, rejection_reason } = req.body;
    const valid = ['draft', 'submitted', 'approved', 'rejected'];
    if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const { rows: [pr] } = await db.execute({ sql: 'SELECT * FROM purchase_requests WHERE id = ?', args: [req.params.id] });
    if (!pr) return res.status(404).json({ error: 'Not found' });
    if (pr.status === 'converted') return res.status(400).json({ error: 'Cannot change status of a converted PR' });

    if (status === 'approved') {
      await db.execute({ sql: 'UPDATE purchase_requests SET status = ?, approved_by = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?', args: [status, approved_by || null, req.params.id] });
    } else if (status === 'rejected') {
      await db.execute({ sql: 'UPDATE purchase_requests SET status = ?, rejection_reason = ? WHERE id = ?', args: [status, rejection_reason || null, req.params.id] });
    } else {
      await db.execute({ sql: 'UPDATE purchase_requests SET status = ? WHERE id = ?', args: [status, req.params.id] });
    }
    const { rows: [row] } = await db.execute({ sql: PR_SELECT + ' WHERE pr.id = ?', args: [req.params.id] });
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

function conversionVariationMap(body) {
  const map = new Map();
  const supplied = Array.isArray(body?.variations) ? body.variations : [];
  for (const x of supplied) {
    const itemId = Number(x?.pr_item_id), variationId = Number(x?.variation_id);
    if (itemId && variationId) map.set(itemId, variationId);
  }
  return map;
}

async function resolveConversionLine(tx,item,variationMap) {
  if (item.item_type === 'internal' || !item.product_id) return { productId:null, variationId:null, sku:item.sku };
  const { rows:[product] } = await tx.execute({ sql:'SELECT id,name,sku FROM products WHERE id=? AND active=1', args:[item.product_id] });
  if (!product) throw Object.assign(new Error(`${item.product_name} is no longer an active catalog product`), { status:409, control:'pr_conversion_product_inactive' });
  const { rows:[count] } = await tx.execute({ sql:'SELECT COUNT(*) count FROM product_variations WHERE product_id=? AND active=1', args:[product.id] });
  const variationId = Number(variationMap.get(Number(item.id)) || item.variation_id || 0);
  if (Number(count?.count||0) > 0 && !variationId) {
    throw Object.assign(new Error(`${product.name} has active variations. Select the exact variation before converting this request to a purchase order.`), { status:409, control:'pr_conversion_variation_required', pr_item_id:Number(item.id) });
  }
  if (!variationId) return { productId:Number(product.id), variationId:null, sku:item.sku||product.sku||'' };
  const { rows:[variation] } = await tx.execute({ sql:'SELECT id,product_id,name,sku,active FROM product_variations WHERE id=? AND product_id=?', args:[variationId,product.id] });
  if (!variation || Number(variation.active) === 0) {
    throw Object.assign(new Error(`The selected variation for ${product.name} is stale, inactive, or belongs to another product`), { status:409, control:'pr_conversion_variation_invalid', pr_item_id:Number(item.id) });
  }
  return { productId:Number(product.id), variationId:Number(variation.id), sku:variation.sku||item.sku||product.sku||'' };
}

router.post('/:id/convert', async (req, res) => {
  try {
    const supplierId = Number(req.body?.supplier_id||0), expectedDate=req.body?.expected_date, poNotes=req.body?.notes;
    if (!supplierId) return res.status(400).json({ error:'Select a supplier before creating the purchase order' });
    const variationMap = conversionVariationMap(req.body);
    const tx = await db.transaction('write'); let committed=false;
    try {
      const { rows:[pr] } = await tx.execute({ sql:'SELECT * FROM purchase_requests WHERE id=?', args:[req.params.id] });
      if (!pr) throw Object.assign(new Error('Purchase request not found'), { status:404 });
      if (pr.status === 'converted' || pr.converted_to_po_id) throw Object.assign(new Error('Purchase request has already been converted to a purchase order'), { status:409, control:'pr_already_converted' });
      if (pr.status !== 'approved') throw Object.assign(new Error('Only approved purchase requests can be converted to a purchase order'), { status:409, control:'pr_not_approved' });
      if (!pr.branch_id) throw Object.assign(new Error('The approved purchase request has no receiving branch'), { status:409, control:'pr_conversion_branch_required' });
      const { rows:[supplier] } = await tx.execute({ sql:'SELECT id FROM suppliers WHERE id=? AND active=1', args:[supplierId] });
      if (!supplier) throw Object.assign(new Error('Selected supplier is inactive or no longer exists'), { status:409, control:'pr_conversion_supplier_invalid' });
      const { rows:prItems } = await tx.execute({ sql:'SELECT * FROM purchase_request_items WHERE pr_id=? ORDER BY id', args:[pr.id] });
      if (!prItems.length) throw Object.assign(new Error('Purchase request has no items'), { status:409 });

      const resolved=[]; let subtotal=0;
      for (const item of prItems) {
        const identity=await resolveConversionLine(tx,item,variationMap);
        const total=Number(item.total||0); subtotal=Number((subtotal+total).toFixed(2));
        resolved.push({item,...identity});
      }
      const poNumber=await nextNumber(tx,'purchase_orders','po_number','PO-',6);
      const poResult=await tx.execute({
        sql:'INSERT INTO purchase_orders (po_number,supplier_id,branch_id,employee_id,subtotal,total,notes,expected_date) VALUES (?,?,?,?,?,?,?,?)',
        args:[poNumber,supplierId,pr.branch_id,pr.employee_id,subtotal,subtotal,poNotes||pr.notes,expectedDate||pr.required_date||null]
      });
      const poId=Number(poResult.lastInsertRowid);
      for (const x of resolved) {
        const i=x.item;
        await tx.execute({
          sql:'INSERT INTO purchase_order_items (po_id,product_id,variation_id,product_name,sku,quantity_ordered,unit_cost,total,quotation_item_id,work_order_item_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
          args:[poId,x.productId,x.variationId,i.product_name,x.sku,i.quantity,i.unit_cost,i.total,i.quotation_item_id,i.work_order_item_id]
        });
      }
      const claimed=await tx.execute({ sql:`UPDATE purchase_requests SET status='converted',converted_to_po_id=? WHERE id=? AND status='approved' AND converted_to_po_id IS NULL`, args:[poId,pr.id] });
      if (Number(claimed.rowsAffected||0)!==1) throw Object.assign(new Error('Another conversion changed this purchase request before commit'), { status:409, control:'pr_conversion_race' });
      await tx.commit(); committed=true;

      const { rows:[po] } = await db.execute({ sql:`SELECT po.*,s.name supplier_name FROM purchase_orders po LEFT JOIN suppliers s ON s.id=po.supplier_id WHERE po.id=?`, args:[poId] });
      const { rows:poItems } = await db.execute({ sql:`SELECT poi.*,pv.name variation_name,pv.sku variation_sku FROM purchase_order_items poi LEFT JOIN product_variations pv ON pv.id=poi.variation_id WHERE poi.po_id=? ORDER BY poi.id`, args:[poId] });
      po.items=poItems; res.status(201).json(po);
    } catch(e) {
      if (!committed) await tx.rollback();
      res.status(committed ? 500 : (e.status||400)).json({ error:e.message, control:e.control, pr_item_id:e.pr_item_id });
    }
  } catch(e) { res.status(e.status||500).json({ error:e.message, control:e.control }); }
});

module.exports = router;
module.exports.ensureVariationSchema = ensureVariationSchema;
