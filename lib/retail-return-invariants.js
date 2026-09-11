'use strict';

const { db } = require('../database');

let readyPromise = null;

async function ensureRetailReturnInvariants() {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    await db.batch([
      { sql: 'DROP TRIGGER IF EXISTS trg_return_items_original_sale_guard' },
      {
        sql: `CREATE TRIGGER trg_return_items_original_sale_guard
          BEFORE INSERT ON return_items
          FOR EACH ROW
          BEGIN
            SELECT CASE
              WHEN NEW.quantity IS NULL OR NEW.quantity <= 0
              THEN RAISE(ABORT, 'RETURN_QUANTITY_MUST_BE_POSITIVE')
            END;
            SELECT CASE
              WHEN typeof(NEW.total) NOT IN ('integer','real') OR NEW.total < 0
              THEN RAISE(ABORT, 'RETURN_VALUE_MUST_BE_NONNEGATIVE_MONEY')
            END;
            SELECT CASE
              WHEN typeof(NEW.tax_amount) NOT IN ('integer','real') OR NEW.tax_amount < 0
              THEN RAISE(ABORT, 'RETURN_TAX_MUST_BE_NONNEGATIVE_MONEY')
            END;
            SELECT CASE
              WHEN ABS((NEW.total * 100.0) - ROUND(NEW.total * 100.0)) > 0.000001
              THEN RAISE(ABORT, 'RETURN_VALUE_MUST_HAVE_CENT_PRECISION')
            END;
            SELECT CASE
              WHEN ABS((NEW.tax_amount * 100.0) - ROUND(NEW.tax_amount * 100.0)) > 0.000001
              THEN RAISE(ABORT, 'RETURN_TAX_MUST_HAVE_CENT_PRECISION')
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
            SELECT CASE
              WHEN (
                COALESCE((
                  SELECT SUM(ri.total)
                  FROM return_items ri
                  JOIN returns r_existing ON r_existing.id = ri.return_id
                  WHERE ri.transaction_item_id = NEW.transaction_item_id
                    AND COALESCE(r_existing.status, 'completed') != 'cancelled'
                ), 0) + NEW.total
              ) > COALESCE((SELECT ti.total FROM transaction_items ti WHERE ti.id = NEW.transaction_item_id), 0) + 0.000001
              THEN RAISE(ABORT, 'RETURN_VALUE_EXCEEDS_ORIGINAL_LINE')
            END;
            SELECT CASE
              WHEN (
                COALESCE((
                  SELECT SUM(ri.tax_amount)
                  FROM return_items ri
                  JOIN returns r_existing ON r_existing.id = ri.return_id
                  WHERE ri.transaction_item_id = NEW.transaction_item_id
                    AND COALESCE(r_existing.status, 'completed') != 'cancelled'
                ), 0) + NEW.tax_amount
              ) > COALESCE((SELECT ti.tax_amount FROM transaction_items ti WHERE ti.id = NEW.transaction_item_id), 0) + 0.000001
              THEN RAISE(ABORT, 'RETURN_TAX_EXCEEDS_ORIGINAL_LINE')
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
