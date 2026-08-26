const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission } = require('../lib/permissions');

router.use(requirePermission('quotations'));

async function downstreamEvidence(quoteId) {
  const { rows: [row] } = await db.execute({
    sql: `SELECT
      EXISTS(SELECT 1 FROM quotation_items qi WHERE qi.quote_id=? AND qi.purchase_request_id IS NOT NULL) AS has_direct_pr,
      EXISTS(SELECT 1 FROM quotation_item_sources qis JOIN quotation_items qi ON qi.id=qis.quotation_item_id WHERE qi.quote_id=? AND qis.purchase_request_item_id IS NOT NULL) AS has_source_pr,
      EXISTS(SELECT 1 FROM quotation_item_sources qis JOIN quotation_items qi ON qi.id=qis.quotation_item_id WHERE qi.quote_id=? AND qis.transfer_id IS NOT NULL) AS has_transfer`,
    args: [quoteId, quoteId, quoteId],
  });
  return {
    purchaseRequest: Boolean(Number(row?.has_direct_pr || 0) || Number(row?.has_source_pr || 0)),
    transfer: Boolean(Number(row?.has_transfer || 0)),
  };
}

// Accepted quotations may already have created Purchase Requests and branch
// transfers. The legacy edit implementation replaces every quotation line,
// which destroys those links and can create duplicate downstream commitments.
// Fail closed instead of allowing an accepted quote to rewrite its sourcing
// history. A commercial change after acceptance must be handled as a revision.
router.put('/:id', async (req, res, next) => {
  try {
    const { rows: [quote] } = await db.execute({ sql: 'SELECT id,quote_number,status FROM quotations WHERE id=?', args: [req.params.id] });
    if (!quote) return next();
    if (quote.status === 'accepted') {
      const evidence = await downstreamEvidence(quote.id);
      if (evidence.purchaseRequest || evidence.transfer) {
        return res.status(409).json({
          error: `Quotation ${quote.quote_number} has already created downstream sourcing commitments and cannot be edited in place. Create a revised quotation so the original acceptance, Purchase Requests and transfers remain auditable.`,
          requires_revision: true,
          downstream: evidence,
        });
      }
    }
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Do not permit an accepted quote with downstream commitments to be casually
// moved back to draft/sent/declined; doing so would leave active purchasing or
// transfer work detached from the commercial state shown to users.
router.patch('/:id/status', async (req, res, next) => {
  try {
    const target = String(req.body?.status || '').toLowerCase();
    const { rows: [quote] } = await db.execute({ sql: 'SELECT id,quote_number,status FROM quotations WHERE id=?', args: [req.params.id] });
    if (!quote || quote.status !== 'accepted' || target === 'accepted') return next();
    const evidence = await downstreamEvidence(quote.id);
    if (evidence.purchaseRequest || evidence.transfer) {
      return res.status(409).json({
        error: `Quotation ${quote.quote_number} has active downstream sourcing evidence. It cannot leave Accepted status until those commitments are resolved through a controlled revision/cancellation workflow.`,
        downstream: evidence,
      });
    }
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
