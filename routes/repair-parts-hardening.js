const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission } = require('../lib/permissions');

let schemaReady = false;
async function ensureSchema() {
  if (schemaReady) return;
  await db.batch([
    { sql: `CREATE TABLE IF NOT EXISTS repair_part_reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_order_id INTEGER NOT NULL,
      work_order_item_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      branch_id INTEGER NOT NULL,
      quantity_reserved INTEGER NOT NULL DEFAULT 0,
      quantity_consumed INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(work_order_item_id, branch_id)
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS repair_part_usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_order_id INTEGER NOT NULL,
      work_order_item_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      branch_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      employee_id INTEGER,
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )` },
  ], 'write');
  schemaReady = true;
}

async function loadContext(workOrderId, itemId) {
  const { rows: [wo] } = await db.execute({
    sql: 'SELECT id,wo_number,branch_id,status FROM work_orders WHERE id=?',
    args: [workOrderId],
  });
  if (!wo) return { error: { status: 404, body: { error: 'Work order not found' } } };
  const { rows: [item] } = await db.execute({
    sql: 'SELECT * FROM work_order_items WHERE id=? AND work_order_id=?',
    args: [itemId, workOrderId],
  });
  if (!item) return { error: { status: 404, body: { error: 'Work order part not found' } } };
  return { wo, item };
}

async function fulfilledSourceQuantity(wo, item) {
  const { rows: sources } = await db.execute({
    sql: `SELECT wis.quantity,wis.branch_id,wis.transfer_id,wis.purchase_request_item_id,
      bt.status AS transfer_status,pr.status AS purchase_request_status
      FROM work_order_item_sources wis
      LEFT JOIN branch_transfers bt ON bt.id=wis.transfer_id
      LEFT JOIN purchase_request_items pri ON pri.id=wis.purchase_request_item_id
      LEFT JOIN purchase_requests pr ON pr.id=pri.pr_id
      WHERE wis.work_order_item_id=?`,
    args: [item.id],
  });

  if (sources.length) {
    let fulfilled = 0;
    const blockers = [];
    for (const src of sources) {
      const qty = Number(src.quantity || 0);
      if (src.branch_id == null) {
        if (src.purchase_request_status === 'received') fulfilled += qty;
        else blockers.push({ type: 'purchase', quantity: qty, status: src.purchase_request_status || 'pending' });
      } else if (Number(src.branch_id) === Number(wo.branch_id)) {
        fulfilled += qty;
      } else if (src.transfer_id && src.transfer_status === 'received') {
        fulfilled += qty;
      } else {
        blockers.push({ type: 'transfer', quantity: qty, transfer_id: src.transfer_id || null, status: src.transfer_status || 'pending' });
      }
    }
    return { fulfilled, blockers };
  }

  if (item.purchase_request_id) {
    const { rows: [pr] } = await db.execute({
      sql: 'SELECT status FROM purchase_requests WHERE id=?',
      args: [item.purchase_request_id],
    });
    return pr?.status === 'received'
      ? { fulfilled: Number(item.quantity || 0), blockers: [] }
      : { fulfilled: 0, blockers: [{ type: 'purchase', quantity: Number(item.quantity || 0), status: pr?.status || 'pending' }] };
  }

  return { fulfilled: Number(item.quantity || 0), blockers: [] };
}

router.use(async (req, res, next) => {
  try { await ensureSchema(); next(); }
  catch (e) { res.status(500).json({ error: 'Repair parts hardening initialization failed', detail: e.message }); }
});

router.post('/work-orders/:id/:action(reserve|consume|release|return)', requirePermission('wo_assign_parts'), async (req, res, next) => {
  try {
    const action = req.params.action;
    const itemId = Number(req.body?.work_order_item_id);
    const branchId = Number(req.body?.branch_id);
    if (!itemId) return res.status(400).json({ error: 'work_order_item_id is required' });

    const context = await loadContext(req.params.id, itemId);
    if (context.error) return res.status(context.error.status).json(context.error.body);
    const { wo, item } = context;

    if (!['in_progress', 'awaiting_signoff'].includes(wo.status)) {
      return res.status(409).json({ error: `Repair part ${action} is locked while work order is ${wo.status}` });
    }
    if (item.is_customer_supplied && action !== 'release') {
      return res.status(409).json({ error: 'Customer-supplied parts are not consumed from company inventory' });
    }
    if (['reserve', 'consume', 'return'].includes(action)) {
      if (!branchId) return res.status(400).json({ error: 'branch_id is required' });
      if (Number(wo.branch_id) !== branchId) {
        return res.status(409).json({
          error: 'Repair parts must be issued from the work order branch after any transfer or purchasing receipt is completed',
          work_order_branch_id: wo.branch_id,
        });
      }
    }

    if (action === 'reserve') {
      if (!item.product_id) {
        return res.status(409).json({ error: 'This part must be received and linked to a catalog product before it can be reserved' });
      }
      const qty = Number.parseInt(req.body?.quantity, 10);
      if (!qty || qty <= 0) return res.status(400).json({ error: 'A positive reservation quantity is required' });

      const source = await fulfilledSourceQuantity(wo, item);
      const { rows: [existing] } = await db.execute({
        sql: `SELECT quantity_reserved,quantity_consumed FROM repair_part_reservations
              WHERE work_order_item_id=? AND branch_id=?`,
        args: [item.id, branchId],
      });
      const { rows: [other] } = await db.execute({
        sql: `SELECT COALESCE(SUM(quantity_reserved),0) AS q FROM repair_part_reservations
              WHERE work_order_item_id=? AND branch_id!=? AND status='active'`,
        args: [item.id, branchId],
      });
      const consumedHere = Number(existing?.quantity_consumed || 0);
      if (qty < consumedHere) {
        return res.status(409).json({ error: `Reservation cannot be reduced below ${consumedHere} units already consumed` });
      }
      const totalCommitted = qty + Number(other?.q || 0);
      const required = Number(item.quantity || 0);
      if (totalCommitted > required) {
        return res.status(409).json({ error: `Reservations would exceed required quantity ${required}`, required_quantity: required, attempted_committed_quantity: totalCommitted });
      }
      if (totalCommitted > source.fulfilled) {
        return res.status(409).json({
          error: 'Not all required sourcing has physically arrived at the work order branch yet',
          fulfilled_quantity: source.fulfilled,
          attempted_committed_quantity: totalCommitted,
          blockers: source.blockers,
        });
      }
    }

    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
