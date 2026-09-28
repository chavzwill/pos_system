'use strict';

const { db } = require('../database');

let readyPromise = null;

async function ensureRetailRefundInvariants() {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    await db.batch([
      {
        sql: `CREATE TABLE IF NOT EXISTS retail_refund_settlements (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          return_id INTEGER NOT NULL UNIQUE REFERENCES returns(id),
          original_transaction_id INTEGER NOT NULL REFERENCES transactions(id),
          return_number TEXT NOT NULL,
          branch_id INTEGER REFERENCES branches(id),
          drawer_session_id INTEGER REFERENCES drawer_sessions(id),
          total REAL NOT NULL,
          settled_by_employee_id INTEGER REFERENCES employees(id),
          settled_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`
      },
      {
        sql: `CREATE TABLE IF NOT EXISTS retail_refund_settlement_legs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          settlement_id INTEGER NOT NULL REFERENCES retail_refund_settlements(id),
          payment_method TEXT NOT NULL,
          amount REAL NOT NULL,
          reference_code TEXT,
          UNIQUE(settlement_id,payment_method,reference_code)
        )`
      },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_refund_settlement_return ON retail_refund_settlements(return_id)' },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_refund_settlement_drawer ON retail_refund_settlements(drawer_session_id,settled_at)' },
      {
        sql: `CREATE TRIGGER IF NOT EXISTS trg_refund_legs_tender_ceiling
          BEFORE INSERT ON retail_refund_settlement_legs
          FOR EACH ROW
          BEGIN
            SELECT CASE
              WHEN NEW.amount IS NULL OR NEW.amount <= 0
              THEN RAISE(ABORT, 'REFUND_AMOUNT_MUST_BE_POSITIVE')
            END;
            SELECT CASE
              WHEN NOT EXISTS (
                SELECT 1 FROM retail_refund_settlements s WHERE s.id = NEW.settlement_id
              )
              THEN RAISE(ABORT, 'REFUND_SETTLEMENT_NOT_FOUND')
            END;
            SELECT CASE
              WHEN (
                COALESCE((
                  SELECT SUM(existing.amount)
                  FROM retail_refund_settlement_legs existing
                  WHERE existing.settlement_id = NEW.settlement_id
                ), 0) + NEW.amount
              ) > COALESCE((
                SELECT s.total FROM retail_refund_settlements s WHERE s.id = NEW.settlement_id
              ), 0) + 0.01
              THEN RAISE(ABORT, 'REFUND_SETTLEMENT_TOTAL_EXCEEDED')
            END;
            SELECT CASE
              WHEN (
                COALESCE((
                  SELECT SUM(existing.amount)
                  FROM retail_refund_settlement_legs existing
                  JOIN retail_refund_settlements prior_settlement ON prior_settlement.id = existing.settlement_id
                  WHERE prior_settlement.original_transaction_id = (
                    SELECT current_settlement.original_transaction_id
                    FROM retail_refund_settlements current_settlement
                    WHERE current_settlement.id = NEW.settlement_id
                  )
                    AND existing.payment_method = NEW.payment_method
                ), 0) + NEW.amount
              ) > (
                CASE
                  WHEN EXISTS (
                    SELECT 1
                    FROM transaction_payments p
                    WHERE p.transaction_id = (
                      SELECT current_settlement.original_transaction_id
                      FROM retail_refund_settlements current_settlement
                      WHERE current_settlement.id = NEW.settlement_id
                    )
                  )
                  THEN COALESCE((
                    SELECT SUM(p.amount)
                    FROM transaction_payments p
                    WHERE p.transaction_id = (
                      SELECT current_settlement.original_transaction_id
                      FROM retail_refund_settlements current_settlement
                      WHERE current_settlement.id = NEW.settlement_id
                    )
                      AND p.payment_method = NEW.payment_method
                  ), 0)
                  ELSE COALESCE((
                    SELECT CASE WHEN t.payment_method = NEW.payment_method THEN t.total ELSE 0 END
                    FROM transactions t
                    WHERE t.id = (
                      SELECT current_settlement.original_transaction_id
                      FROM retail_refund_settlements current_settlement
                      WHERE current_settlement.id = NEW.settlement_id
                    )
                  ), 0)
                END
              ) + 0.01
              THEN RAISE(ABORT, 'REFUND_EXCEEDS_ORIGINAL_TENDER')
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

module.exports = { ensureRetailRefundInvariants };
