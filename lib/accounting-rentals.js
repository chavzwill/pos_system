const { db } = require('../database');
const { ensureLedger, postSourceJournal } = require('./accounting-posting');

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

async function exists(table) {
  const { rows: [r] } = await db.execute({
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    args: [table],
  });
  return !!r;
}

function debitCode(method) {
  const m = String(method || '').toLowerCase();
  if (m.includes('cash')) return '1000';
  if (m.includes('charge') || m === 'credit' || m.includes('account')) return '1100';
  return '1050';
}

async function ensureRentalAccounts() {
  await ensureLedger();
  const defs = [
    ['1050', 'Electronic Settlement Clearing', 'asset', 'debit'],
    ['2200', 'Customer Deposits', 'liability', 'credit'],
    ['2400', 'Customer Refunds Payable', 'liability', 'credit'],
    ['4200', 'Rental Revenue', 'revenue', 'credit'],
    ['4250', 'Rental Service & Damage Revenue', 'revenue', 'credit'],
  ];
  for (const a of defs) {
    await db.execute({
      sql: 'INSERT OR IGNORE INTO ledger_accounts(code,name,account_type,normal_balance,system_account) VALUES(?,?,?,?,1)',
      args: a,
    });
  }
}

async function syncRentalAccounting({ actorId, stats }) {
  if (!(await exists('rental_agreements')) || !(await exists('transactions')) || !(await exists('rental_agreement_items'))) return;
  await ensureRentalAccounts();
  stats.rental_checkout ||= { posted: 0, existing: 0 };
  stats.rental_settlement ||= { posted: 0, existing: 0 };

  const { rows } = await db.execute({
    sql: `SELECT ra.*,
      co.transaction_number AS checkout_transaction_number,
      co.total AS checkout_total,
      co.tax_amount AS checkout_tax,
      co.payment_method AS checkout_method,
      co.created_at AS checkout_tx_created_at,
      co.status AS checkout_tx_status,
      se.transaction_number AS settlement_transaction_number,
      se.subtotal AS settlement_subtotal,
      se.tax_amount AS settlement_tax,
      se.total AS settlement_total,
      se.payment_method AS settlement_method,
      se.created_at AS settlement_tx_created_at,
      se.status AS settlement_tx_status,
      COALESCE((SELECT SUM(CASE WHEN COALESCE(rai.is_mandatory,0)=0 THEN rai.rental_fee ELSE 0 END)
        FROM rental_agreement_items rai WHERE rai.agreement_id=ra.id),0) AS rental_fee_total
    FROM rental_agreements ra
    LEFT JOIN transactions co ON co.id=ra.checkout_transaction_id
    LEFT JOIN transactions se ON se.id=ra.settlement_transaction_id
    ORDER BY ra.id`,
    args: [],
  });

  for (const ra of rows) {
    const ref = ra.agreement_number || String(ra.id);
    const branchId = ra.branch_id || null;
    const rentalFee = money(ra.rental_fee_total);
    const deposit = money(ra.deposit_total);
    const delivery = ra.delivery_required ? money(ra.delivery_cost) : 0;
    const pickup = ra.pickup_required ? money(ra.pickup_cost) : 0;
    const operator = ra.operator_required ? money(ra.operator_fee) : 0;
    const services = money(delivery + pickup + operator);

    if (ra.checkout_transaction_id) {
      try {
        if (ra.checkout_tx_status === 'voided') {
          stats.evidence_gaps.push({
            rental_agreement_id: ra.id,
            agreement_number: ref,
            type: 'rental_checkout_transaction_voided',
            automatic_posting: false,
            reason: 'The agreement references a voided checkout transaction; rental accounting will not infer a replacement charge.',
          });
        } else {
          const tax = money(ra.checkout_tax);
          const expected = money(rentalFee + services + deposit + tax);
          const actual = money(ra.checkout_total);
          if (Math.abs(expected - actual) > 0.01) {
            stats.reconciliation_issues.push({
              rental_agreement_id: ra.id,
              agreement_number: ref,
              type: 'rental_checkout_total_mismatch',
              expected,
              actual,
              rental_fee: rentalFee,
              service_fees: services,
              deposit,
              tax,
            });
          } else if (actual >= 0) {
            const lines = [];
            if (actual > 0) {
              lines.push({
                code: debitCode(ra.checkout_method),
                debit: actual,
                credit: 0,
                description: ra.checkout_method === 'credit' ? 'Rental charge-account receivable' : 'Rental checkout tender',
              });
            }
            if (rentalFee > 0) lines.push({ code: '4200', debit: 0, credit: rentalFee, description: 'Rental fee revenue' });
            if (services > 0) lines.push({ code: '4250', debit: 0, credit: services, description: 'Delivery, pickup and operator fees' });
            if (deposit > 0) lines.push({ code: '2200', debit: 0, credit: deposit, description: 'Refundable rental deposit liability' });
            if (tax > 0) lines.push({ code: '2100', debit: 0, credit: tax, description: 'Rental sales tax payable' });
            if (lines.length) {
              const j = await postSourceJournal({
                sourceType: 'rental_checkout',
                sourceId: ra.checkout_transaction_id,
                sourceReference: ref,
                entryDate: String(ra.checkout_tx_created_at || ra.created_at || new Date().toISOString()).slice(0, 10),
                description: `Rental checkout ${ref}`,
                branchId,
                actorId,
                lines,
              });
              stats.rental_checkout[j.existing ? 'existing' : 'posted']++;
            }
          }
        }
      } catch (e) {
        stats.errors.push(`rental_checkout:${ra.id}: ${e.message}`);
      }
    }

    if (ra.status !== 'returned') continue;

    const damage = money(ra.damage_fee_total);
    const duration = money(ra.duration_adjustment_total);
    const taxAdjustment = money(ra.tax_adjustment_total);
    const expectedSubtotal = money(damage + duration - deposit);
    const expectedSettlement = money(expectedSubtotal + taxAdjustment);

    if (!ra.settlement_transaction_id) {
      if (expectedSettlement > 0) {
        stats.evidence_gaps.push({
          rental_agreement_id: ra.id,
          agreement_number: ref,
          type: 'rental_balance_awaiting_collection',
          amount: expectedSettlement,
          automatic_posting: false,
          reason: 'The item is back, but a positive balance is intentionally waiting for a cashier to collect it before a settlement transaction exists.',
        });
      } else {
        stats.reconciliation_issues.push({
          rental_agreement_id: ra.id,
          agreement_number: ref,
          type: 'rental_settlement_transaction_missing',
          expected_settlement: expectedSettlement,
        });
      }
      continue;
    }

    try {
      if (ra.settlement_tx_status === 'voided') {
        stats.evidence_gaps.push({
          rental_agreement_id: ra.id,
          agreement_number: ref,
          type: 'rental_settlement_transaction_voided',
          automatic_posting: false,
          reason: 'The returned rental references a voided settlement transaction; accounting will not fabricate settlement evidence.',
        });
        continue;
      }

      const actualSubtotal = money(ra.settlement_subtotal);
      const actualTax = money(ra.settlement_tax);
      const actualTotal = money(ra.settlement_total);
      if (Math.abs(actualSubtotal - expectedSubtotal) > 0.01 || Math.abs(actualTax - taxAdjustment) > 0.01 || Math.abs(actualTotal - expectedSettlement) > 0.01) {
        stats.reconciliation_issues.push({
          rental_agreement_id: ra.id,
          agreement_number: ref,
          type: 'rental_settlement_mismatch',
          expected_subtotal: expectedSubtotal,
          actual_subtotal: actualSubtotal,
          expected_tax: taxAdjustment,
          actual_tax: actualTax,
          expected_total: expectedSettlement,
          actual_total: actualTotal,
        });
        continue;
      }

      const lines = [];
      if (deposit > 0) lines.push({ code: '2200', debit: deposit, credit: 0, description: 'Release refundable rental deposit liability' });
      if (duration > 0) lines.push({ code: '4200', debit: 0, credit: duration, description: 'Additional rental time revenue' });
      if (duration < 0) lines.push({ code: '4200', debit: Math.abs(duration), credit: 0, description: 'Rental fee credit for early return' });
      if (damage > 0) lines.push({ code: '4250', debit: 0, credit: damage, description: 'Rental damage charge revenue' });
      if (taxAdjustment > 0) lines.push({ code: '2100', debit: 0, credit: taxAdjustment, description: 'Additional rental sales tax payable' });
      if (taxAdjustment < 0) lines.push({ code: '2100', debit: Math.abs(taxAdjustment), credit: 0, description: 'Reverse excess rental sales tax' });

      if (actualTotal > 0) {
        lines.push({
          code: debitCode(ra.settlement_method),
          debit: actualTotal,
          credit: 0,
          description: ra.settlement_method === 'credit' ? 'Additional rental receivable' : 'Rental settlement collected',
        });
      } else if (actualTotal < 0) {
        const creditCode = String(ra.checkout_method || '').toLowerCase() === 'credit' ? '1100' : '2400';
        lines.push({
          code: creditCode,
          debit: 0,
          credit: Math.abs(actualTotal),
          description: creditCode === '1100' ? 'Reduce customer rental receivable' : 'Customer rental refund payable',
        });
      }

      if (!lines.length) continue;
      const j = await postSourceJournal({
        sourceType: 'rental_settlement',
        sourceId: ra.settlement_transaction_id,
        sourceReference: ref,
        entryDate: String(ra.settlement_tx_created_at || ra.returned_at || ra.created_at || new Date().toISOString()).slice(0, 10),
        description: `Rental settlement ${ref}`,
        branchId,
        actorId,
        lines,
      });
      stats.rental_settlement[j.existing ? 'existing' : 'posted']++;
    } catch (e) {
      stats.errors.push(`rental_settlement:${ra.id}: ${e.message}`);
    }
  }
}

module.exports = { syncRentalAccounting };
