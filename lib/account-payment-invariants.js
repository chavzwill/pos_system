'use strict';
const { db } = require('../database');

let readyPromise = null;
async function ensureSchema(){
  if (readyPromise) return readyPromise;
  readyPromise = db.batch([
    {sql:'DROP TRIGGER IF EXISTS trg_account_payment_amount_validate'},
    {sql:`CREATE TRIGGER trg_account_payment_amount_validate
      BEFORE INSERT ON account_payments
      BEGIN
        SELECT CASE WHEN NEW.amount<=0 THEN RAISE(ABORT,'ACCOUNT_PAYMENT_AMOUNT_MUST_BE_POSITIVE') END;
        SELECT CASE WHEN ABS(NEW.amount-ROUND(NEW.amount,2))>0.0000001 THEN RAISE(ABORT,'ACCOUNT_PAYMENT_AMOUNT_MUST_HAVE_CENT_PRECISION') END;
      END`},
    {sql:'DROP TRIGGER IF EXISTS trg_payment_allocation_validate'},
    {sql:`CREATE TRIGGER trg_payment_allocation_validate
      BEFORE INSERT ON payment_allocations
      BEGIN
        SELECT CASE WHEN NEW.amount<=0 THEN RAISE(ABORT,'ACCOUNT_PAYMENT_ALLOCATION_MUST_BE_POSITIVE') END;
        SELECT CASE WHEN ABS(NEW.amount-ROUND(NEW.amount,2))>0.0000001 THEN RAISE(ABORT,'ACCOUNT_PAYMENT_ALLOCATION_MUST_HAVE_CENT_PRECISION') END;
        SELECT CASE WHEN (SELECT customer_id FROM account_payments WHERE id=NEW.payment_id) IS NULL THEN RAISE(ABORT,'ACCOUNT_PAYMENT_REQUIRED') END;
        SELECT CASE WHEN (SELECT customer_id FROM transactions WHERE id=NEW.transaction_id)!=(SELECT customer_id FROM account_payments WHERE id=NEW.payment_id) THEN RAISE(ABORT,'ACCOUNT_PAYMENT_CUSTOMER_LINEAGE_MISMATCH') END;
        SELECT CASE WHEN COALESCE((SELECT payment_method FROM transactions WHERE id=NEW.transaction_id),'')!='credit' OR COALESCE((SELECT status FROM transactions WHERE id=NEW.transaction_id),'')!='completed' THEN RAISE(ABORT,'ACCOUNT_PAYMENT_INVOICE_NOT_ELIGIBLE') END;
        SELECT CASE WHEN ROUND(COALESCE((SELECT SUM(amount) FROM payment_allocations WHERE payment_id=NEW.payment_id),0)+NEW.amount,2) > ROUND((SELECT amount FROM account_payments WHERE id=NEW.payment_id),2)+0.001 THEN RAISE(ABORT,'ACCOUNT_PAYMENT_ALLOCATIONS_EXCEED_PAYMENT') END;
        SELECT CASE WHEN ROUND(COALESCE((SELECT SUM(amount) FROM payment_allocations WHERE transaction_id=NEW.transaction_id),0)+NEW.amount,2) > ROUND(
          COALESCE((SELECT total FROM transactions WHERE id=NEW.transaction_id),0)-COALESCE((SELECT SUM(amount) FROM customer_account_adjustments WHERE transaction_id=NEW.transaction_id AND adjustment_type='credit_note'),0),2)+0.001
          THEN RAISE(ABORT,'ACCOUNT_PAYMENT_ALLOCATION_EXCEEDS_RECEIVABLE') END;
      END`},
    {sql:'DROP TRIGGER IF EXISTS trg_account_balance_cent_precision'},
    {sql:`CREATE TRIGGER trg_account_balance_cent_precision
      BEFORE UPDATE OF account_balance ON customers
      BEGIN
        SELECT CASE WHEN ABS(NEW.account_balance-ROUND(NEW.account_balance,2))>0.0000001 THEN RAISE(ABORT,'ACCOUNT_BALANCE_MUST_HAVE_CENT_PRECISION') END;
      END`}
  ],'write').catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}

module.exports={ensureSchema};
