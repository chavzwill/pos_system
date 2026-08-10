const { db } = require('../database');
const { createTransfer } = require('./transfers');
const { nextNumber } = require('./nextNumber');

// Work order parts always reference a real catalog product (unlike
// quotation_items, there's no "temp/custom item" concept here) — so this is
// a smaller version of routes/quotations.js's processQuoteItems: no
// discount, no is_temp_item/purchase_request_id passthrough, just
// product lookup + per-line source split validation.
async function processWorkOrderItems(items) {
  const processedItems = [];
  for (const item of items) {
    if (!item.product_id) throw new Error('Every work order part must reference a catalog product');
    const { rows: [product] } = await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [item.product_id] });
    if (!product) throw new Error(`Product ${item.product_id} not found`);
    const qty = parseInt(item.quantity || 1);
    const unit_cost = parseFloat(product.cost) || 0;
    const unit_price = parseFloat(item.unit_price ?? product.price) || 0;
    const total = parseFloat((unit_price * qty).toFixed(2));
    let sources = null;
    if (Array.isArray(item.sources) && item.sources.length) {
      const sourcesSum = item.sources.reduce((s, src) => s + (parseInt(src.quantity) || 0), 0);
      if (sourcesSum !== qty) throw new Error(`Branch sourcing for ${product.name} (${sourcesSum}) doesn't match quantity (${qty})`);
      sources = item.sources.map(src => ({ branch_id: src.branch_id || null, quantity: parseInt(src.quantity) || 0 })).filter(src => src.quantity > 0);
    }
    processedItems.push({ product_id: product.id, product_name: product.name, sku: product.sku, quantity: qty, unit_cost, unit_price, total, sources });
  }
  return processedItems;
}

// One PR per work order, shared by every part shortfall — mirrors
// routes/quotations.js's ensureQuotePR exactly, scoped to work_order_items
// instead of quotation_items.
async function ensureWorkOrderPR(workOrder) {
  const { rows: [existingLink] } = await db.execute({ sql: 'SELECT purchase_request_id FROM work_order_items WHERE work_order_id = ? AND purchase_request_id IS NOT NULL LIMIT 1', args: [workOrder.id] });
  if (existingLink) return existingLink.purchase_request_id;
  const { rows: [existingSourceLink] } = await db.execute({
    sql: `SELECT pri.pr_id FROM work_order_item_sources wis
          JOIN work_order_items woi ON wis.work_order_item_id = woi.id
          JOIN purchase_request_items pri ON wis.purchase_request_item_id = pri.id
          WHERE woi.work_order_id = ? LIMIT 1`,
    args: [workOrder.id],
  });
  if (existingSourceLink) return existingSourceLink.pr_id;

  const pr_number = await nextNumber(db, 'purchase_requests', 'pr_number', 'PR-', 6);
  const result = await db.execute({
    sql: 'INSERT INTO purchase_requests (pr_number, branch_id, employee_id, notes, request_type) VALUES (?,?,?,?,?)',
    args: [pr_number, workOrder.branch_id || null, workOrder.employee_id || null, `Parts for work order ${workOrder.wo_number}`, 'sale'],
  });
  return Number(result.lastInsertRowid);
}

// Auto-creates a real branch transfer for each distinct non-home branch a
// WO's parts were sourced from — line-for-line the same approach as
// routes/quotations.js's processQuoteTransfers, just keyed off
// work_order_item_sources/work_order_id instead of the quotation equivalents.
// If a source branch's stock has changed since parts were assigned and the
// transfer can no longer be created, that group falls back to the PR bucket
// (branch_id = NULL) so flagWorkOrderItemsForPurchasing sweeps it up instead —
// confirming parts never hard-fails because of stale data.
async function processWorkOrderPartTransfers(workOrder) {
  try {
    if (!workOrder.branch_id) return;
    const { rows: pending } = await db.execute({
      sql: `SELECT wis.id as source_id, wis.branch_id, wis.quantity, woi.product_id
            FROM work_order_item_sources wis JOIN work_order_items woi ON wis.work_order_item_id = woi.id
            WHERE woi.work_order_id = ? AND wis.branch_id IS NOT NULL AND wis.branch_id != ? AND wis.transfer_id IS NULL`,
      args: [workOrder.id, workOrder.branch_id],
    });
    if (!pending.length) return;

    const byBranch = {};
    for (const row of pending) { (byBranch[row.branch_id] = byBranch[row.branch_id] || []).push(row); }

    for (const [branchId, rows] of Object.entries(byBranch)) {
      const tx = await db.transaction('write');
      let committed = false;
      try {
        const transfer_number = await nextNumber(tx, 'branch_transfers', 'transfer_number', 'TRF-', 6);
        const items = rows.map(r => ({ product_id: r.product_id, quantity: r.quantity }));
        const transferId = await createTransfer(tx, {
          transfer_number, from_branch_id: Number(branchId), to_branch_id: workOrder.branch_id,
          employee_id: workOrder.employee_id, items, notes: `Auto-created from work order ${workOrder.wo_number}`,
          quote_id: null,
        });
        await tx.execute({ sql: 'UPDATE branch_transfers SET work_order_id = ? WHERE id = ?', args: [workOrder.id, transferId] });
        for (const r of rows) {
          await tx.execute({ sql: 'UPDATE work_order_item_sources SET transfer_id = ? WHERE id = ?', args: [transferId, r.source_id] });
        }
        await tx.commit();
        committed = true;
      } catch(e) {
        if (committed) throw e;
        await tx.rollback();
        for (const r of rows) {
          await db.execute({ sql: 'UPDATE work_order_item_sources SET branch_id = NULL WHERE id = ?', args: [r.source_id] });
        }
      }
    }
  } catch(e) { /* non-fatal: confirming parts itself already succeeded */ }
}

// Flags every part with no branch coverage (work_order_item_sources.branch_id
// IS NULL) into the WO's shared Purchase Request — mirrors
// routes/quotations.js's flagItemsForPurchasing, minus the "temp item" sweep
// (WO parts always reference a real product).
async function flagWorkOrderItemsForPurchasing(workOrder) {
  try {
    const { rows: shortfalls } = await db.execute({
      sql: `SELECT wis.id as source_id, woi.id as item_id, woi.product_id, woi.product_name, woi.unit_cost, wis.quantity
            FROM work_order_item_sources wis JOIN work_order_items woi ON wis.work_order_item_id = woi.id
            WHERE woi.work_order_id = ? AND wis.branch_id IS NULL AND wis.purchase_request_item_id IS NULL`,
      args: [workOrder.id],
    });
    if (!shortfalls.length) return;

    const prId = await ensureWorkOrderPR(workOrder);

    for (const s of shortfalls) {
      const total = parseFloat((s.unit_cost * s.quantity).toFixed(2));
      const result = await db.execute({
        sql: 'INSERT INTO purchase_request_items (pr_id, product_id, product_name, quantity, unit_cost, item_type, notes, total, work_order_item_id) VALUES (?,?,?,?,?,?,?,?,?)',
        args: [prId, s.product_id, s.product_name, s.quantity, s.unit_cost, 'sale', `No branch had enough stock — needed for work order ${workOrder.wo_number}`, total, s.item_id],
      });
      await db.execute({ sql: 'UPDATE work_order_item_sources SET purchase_request_item_id = ? WHERE id = ?', args: [Number(result.lastInsertRowid), s.source_id] });
      await db.execute({ sql: 'UPDATE work_order_items SET purchase_request_id = ? WHERE id = ?', args: [prId, s.item_id] });
    }
  } catch(e) { /* non-fatal: confirming parts itself already succeeded */ }
}

async function processWorkOrderPartSourcing(workOrder) {
  await processWorkOrderPartTransfers(workOrder);
  await flagWorkOrderItemsForPurchasing(workOrder);
}

module.exports = { processWorkOrderItems, processWorkOrderPartSourcing };
