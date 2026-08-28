// Single source of truth for "how many units of a rental product are
// currently checked out." Used by routes/products.js (catalog "available"
// display) and routes/rentals.js (the checkout guard) so both stay in sync.
// When branchId is given, only counts agreements checked out from that
// branch — availability is location-scoped, matching branch_inventory.
async function getOutstandingQty(executor, productId, branchId) {
  // 'pending' agreements (held for a cashier to finalize payment on — see
  // routes/rentals.js) reserve stock too, same as 'active' ones, so the item
  // can't be double-booked by someone else while it's awaiting checkout.
  // 'awaiting_issue' (paid but not yet issued/dispatched) reserves it too —
  // it's out the door in every sense except the physical handover.
  //
  // quantity_missing is different from quantity_returned: an approved missing
  // asset disposition permanently removes the physical unit from branch stock.
  // It must therefore stop counting as an outstanding rental reservation too,
  // otherwise availability would be reduced twice (once by the stock write-off
  // and again by the still-open rental quantity).
  let sql = `SELECT COALESCE(SUM(MAX(0,rai.quantity - rai.quantity_returned - COALESCE(rai.quantity_missing,0))),0) as qty
        FROM rental_agreement_items rai
        JOIN rental_agreements ra ON rai.agreement_id = ra.id
        WHERE rai.product_id = ? AND ra.status IN ('active', 'pending', 'awaiting_issue')`;
  const args = [productId];
  if (branchId) { sql += ' AND ra.branch_id = ?'; args.push(branchId); }
  const { rows: [row] } = await executor.execute({ sql, args });
  return Number(row.qty) || 0;
}

module.exports = { getOutstandingQty };
