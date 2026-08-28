const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission } = require('../lib/permissions');

// Service concessions, goodwill waivers and final-payment netting must run
// before the legacy work-order routes so approved concessions cannot be
// bypassed by the normal settlement path. The balance guard runs first so a
// pre-settlement waiver can never silently become a refund of money already paid.
router.use(require('./service-concession-balance-guard'));
router.use(require('./service-concessions'));

async function tableExists(name, executor = db) {
  const { rows: [row] } = await executor.execute({
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    args: [name],
  });
  return !!row;
}

router.patch('/:id/signoff', requirePermission('wo_signoff'), async (req, res) => {
  try {
    const actor = req.employee?.id || req.body?.employee_id || null;
    const tx = await db.transaction('write');
    let committed = false;
    try {
      const { rows: [wo] } = await tx.execute({
        sql: `SELECT wo.*, c.first_name || ' ' || c.last_name AS customer_name,
          c.phone AS customer_phone,c.email AS customer_email,
          e.first_name || ' ' || e.last_name AS employee_name,
          b.name AS branch_name,
          (SELECT COALESCE(SUM(total),0) FROM work_order_items WHERE work_order_id=wo.id) AS parts_total
          FROM work_orders wo
          LEFT JOIN customers c ON c.id=wo.customer_id
          LEFT JOIN employees e ON e.id=wo.employee_id
          LEFT JOIN branches b ON b.id=wo.branch_id
          WHERE wo.id=?`,
        args: [req.params.id],
      });
      if (!wo) { await tx.rollback(); return res.status(404).json({ error: 'Not found' }); }
      if (!['in_progress', 'awaiting_signoff'].includes(wo.status)) {
        await tx.rollback();
        return res.status(409).json({ error: `This work order is ${wo.status}, not awaiting sign-off` });
      }

      const { rows: tasks } = await tx.execute({
        sql: 'SELECT id,status,technician_id FROM work_order_tasks WHERE work_order_id=? ORDER BY id',
        args: [wo.id],
      });
      const blockers = [];
      if (!String(wo.diagnosis || '').trim()) blockers.push('diagnosis_documented');
      if (!String(wo.repair_notes || '').trim()) blockers.push('repair_notes_documented');
      if (!tasks.length) blockers.push('tasks_present');
      if (tasks.some(t => t.status !== 'complete')) blockers.push('all_tasks_complete');
      if (tasks.some(t => !t.technician_id)) blockers.push('all_tasks_attributed');

      const qualityTable = await tableExists('repair_quality_reviews', tx);
      let latestQc = null;
      if (qualityTable) {
        const { rows: [qc] } = await tx.execute({
          sql: `SELECT id,result,reviewed_at,technician_id FROM repair_quality_reviews
                WHERE work_order_id=? ORDER BY reviewed_at DESC,id DESC LIMIT 1`,
          args: [wo.id],
        });
        latestQc = qc || null;
      }
      if (!latestQc || latestQc.result !== 'pass') blockers.push('latest_qc_pass');

      const { rows: parts } = await tx.execute({
        sql: `SELECT id,product_id,product_name,quantity,is_temp_item,is_customer_supplied
              FROM work_order_items WHERE work_order_id=? ORDER BY id`,
        args: [wo.id],
      });

      const reservationTable = await tableExists('repair_part_reservations', tx);
      const partEvidence = [];
      for (const part of parts.filter(p => !p.is_customer_supplied)) {
        let consumed = 0;
        if (reservationTable) {
          const { rows: [usage] } = await tx.execute({
            sql: `SELECT COALESCE(SUM(quantity_consumed),0) AS consumed
                  FROM repair_part_reservations WHERE work_order_item_id=?`,
            args: [part.id],
          });
          consumed = Number(usage?.consumed || 0);
        }
        const required = Number(part.quantity || 0);
        const linked = !!part.product_id && !part.is_temp_item;
        const covered = linked && consumed >= required;
        partEvidence.push({
          work_order_item_id: part.id,
          product_id: part.product_id || null,
          product_name: part.product_name,
          required_quantity: required,
          consumed_quantity: consumed,
          linked_to_inventory: linked,
          covered,
        });
        if (!linked) blockers.push(`part_${part.id}_inventory_link`);
        if (consumed < required) blockers.push(`part_${part.id}_consumption`);
      }

      if (blockers.length) {
        await tx.rollback();
        return res.status(409).json({
          error: 'Work order cannot be completed until service evidence is complete',
          blockers: [...new Set(blockers)],
          qc: latestQc,
          parts: partEvidence,
          automatic_pay_change: false,
        });
      }

      await tx.execute({
        sql: `UPDATE work_orders SET status='complete',completed_at=CURRENT_TIMESTAMP,completed_by=? WHERE id=?`,
        args: [actor, wo.id],
      });
      await tx.execute({
        sql: `INSERT INTO work_order_status_log(work_order_id,status,comment,employee_id)
              VALUES(?,?,?,?)`,
        args: [wo.id, 'complete', req.body?.comment || 'Signed off after verified QC and part-consumption evidence', actor],
      });
      await tx.commit();
      committed = true;

      const { rows: [updated] } = await db.execute({
        sql: `SELECT wo.*, c.first_name || ' ' || c.last_name AS customer_name,
          c.phone AS customer_phone,c.email AS customer_email,
          e.first_name || ' ' || e.last_name AS employee_name,
          b.name AS branch_name,
          cb.first_name || ' ' || cb.last_name AS completed_by_name,
          (SELECT COALESCE(SUM(total),0) FROM work_order_items WHERE work_order_id=wo.id) AS parts_total
          FROM work_orders wo
          LEFT JOIN customers c ON c.id=wo.customer_id
          LEFT JOIN employees e ON e.id=wo.employee_id
          LEFT JOIN branches b ON b.id=wo.branch_id
          LEFT JOIN employees cb ON cb.id=wo.completed_by
          WHERE wo.id=?`,
        args: [wo.id],
      });
      updated.completion_integrity = {
        latest_qc_review_id: latestQc.id,
        parts_verified: partEvidence.length,
        part_evidence: partEvidence,
      };
      res.json(updated);
    } catch (e) {
      if (!committed) await tx.rollback();
      throw e;
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
