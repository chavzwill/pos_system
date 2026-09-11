'use strict';

const { db } = require('../database');

let readyPromise = null;

async function ensureRetailReturnInvariants() {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    await db.batch([
      {
        sql: `CREATE TRIGGER IF NOT EXISTS trg_return_items_original_sale_guard
          BEFORE INSERT ON return_items
          FOR EACH ROW
          BEGIN
            SELECT CASE
              WHEN NEW.quantity IS NULL OR NEW.quantity <= 0
              THEN RAISE(ABORT, 'RETURN_QUANTITY_MUST_BE_POSITIVE')
            END;
            SELECT CASE
              WHEN NOT EXISTS (
                SELECT 1
                FROM returns r
                JOIN transaction_items ti ON ti.id = NEW.transaction_item_id
                WHERE r.id = NEW.return_id
                  AND ti.transaction_id = r.original_transaction_id
              )
              THEN RAISE(ABORT, 'RETURN_ITEM_ORIGINAL_TRANSACTION_MISMATCH')
            END;
            SELECT CASE
              WHEN (
                COALESCE((
                  SELECT SUM(ri.quantity)
                  FROM return_items ri
                  JOIN returns r_existing ON r_existing.id = ri.return_id
                  WHERE ri.transaction_item_id = NEW.transaction_item_id
                    AND COALESCE(r_existing.status, 'completed') != 'cancelled'
                ), 0) + NEW.quantity
              ) > COALESCE((
                SELECT ti.quantity
                FROM transaction_items ti
                WHERE ti.id = NEW.transaction_item_id
              ), 0) + 0.000000001
              THEN RAISE(ABORT, 'RETURN_QUANTITY_EXCEEDS_ELIGIBLE')
            END;
          END`
      }
    ], 'write');
  })().catch(error => {
    readyPromise = null;
    throw error;
  });
  return readyPromise;
}

module.exports = { ensureRetailReturnInvariants };
