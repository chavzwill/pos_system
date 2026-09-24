require('dotenv').config();
const { db, ensureReady } = require('../database');
const { deliveryBackoffSeconds } = require('../lib/spendos-outbox');

const endpoint = process.env.SPENDOS_INGEST_URL;
const apiKey = process.env.SPENDOS_API_KEY || '';
const batchSize = Math.max(1, Math.min(100, Number(process.env.SPENDOS_OUTBOX_BATCH || 25)));

async function claimRows() {
  const { rows } = await db.execute({
    sql: `SELECT * FROM spendos_outbox
      WHERE status IN ('pending','failed','sending')
        AND available_at <= CURRENT_TIMESTAMP
      ORDER BY id ASC LIMIT ?`,
    args: [batchSize],
  });
  const claimed = [];
  for (const row of rows) {
    const result = await db.execute({
      sql: `UPDATE spendos_outbox
        SET status='sending', available_at=datetime('now','+2 minutes')
        WHERE id=? AND status IN ('pending','failed','sending')
          AND available_at <= CURRENT_TIMESTAMP`,
      args: [row.id],
    });
    if (Number(result.rowsAffected || 0) === 1) claimed.push(row);
  }
  return claimed;
}

async function deliver(row) {
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        'idempotency-key': row.event_id,
      },
      body: row.payload,
    });
    if (!response.ok) throw new Error(`SpendOS HTTP ${response.status}`);

    await db.execute({
      sql: `UPDATE spendos_outbox
        SET status='sent', attempts=attempts+1, sent_at=CURRENT_TIMESTAMP,
            last_error=NULL, available_at=CURRENT_TIMESTAMP
        WHERE id=?`,
      args: [row.id],
    });
    return { id: row.event_id, status: 'sent' };
  } catch (error) {
    const attempts = Number(row.attempts || 0) + 1;
    const backoff = deliveryBackoffSeconds(attempts);
    await db.execute({
      sql: `UPDATE spendos_outbox
        SET status='failed', attempts=attempts+1, last_error=?,
            available_at=datetime('now', ?)
        WHERE id=?`,
      args: [String(error.message || error).slice(0, 1000), `+${backoff} seconds`, row.id],
    });
    return { id: row.event_id, status: 'failed', error: error.message };
  }
}

async function main() {
  if (!endpoint) throw new Error('SPENDOS_INGEST_URL is required');
  await ensureReady();
  const rows = await claimRows();
  const results = [];
  for (const row of rows) results.push(await deliver(row));
  console.log(JSON.stringify({ processed: results.length, results }, null, 2));
  if (results.some(result => result.status === 'failed')) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { claimRows, deliver };
