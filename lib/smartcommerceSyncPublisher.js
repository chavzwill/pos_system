const crypto = require('crypto');
const { db } = require('../database');

const SOURCE = 'total_tools_pos';

function configuredEndpoint() {
  const raw = String(process.env.SMARTCOMMERCE_SYNC_URL || '').trim();
  if (!raw) return null;
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) return null;
  return url.toString();
}

function signingSecret() {
  const secret = String(process.env.SMARTCOMMERCE_POS_SYNC_SECRET || '').trim();
  return secret.length >= 32 ? secret : null;
}

function backoffSeconds(attempts) {
  return Math.min(3600, Math.max(15, 15 * 2 ** Math.min(Number(attempts || 0), 7)));
}

async function claimBatch(limit = 25) {
  const { rows } = await db.execute({
    sql: `SELECT * FROM smartcommerce_sync_outbox
      WHERE status = 'pending'
        AND (next_attempt_at IS NULL OR next_attempt_at <= datetime('now'))
      ORDER BY created_at, event_id
      LIMIT ?`,
    args: [Math.max(1, Math.min(Number(limit) || 25, 100))],
  });
  return rows;
}

function envelope(row) {
  let payload;
  try { payload = JSON.parse(row.payload_json || '{}'); }
  catch { payload = {}; }
  return {
    eventId: String(row.event_id),
    eventType: String(row.event_type),
    entityType: String(row.entity_type),
    entityId: String(row.entity_id),
    entityVersion: Number(row.entity_version),
    occurredAt: new Date(String(row.occurred_at).replace(' ', 'T') + (String(row.occurred_at).includes('Z') ? '' : 'Z')).toISOString(),
    source: SOURCE,
    correlationId: String(row.correlation_id),
    payload,
  };
}

async function markDelivered(row, httpStatus) {
  await db.execute({
    sql: `UPDATE smartcommerce_sync_outbox
      SET status='delivered', delivered_at=datetime('now'), attempts=attempts+1,
          last_http_status=?, last_error_code=NULL, next_attempt_at=NULL
      WHERE event_id=? AND status='pending'`,
    args: [httpStatus, row.event_id],
  });
}

async function markNeedsReview(row, httpStatus, code) {
  await db.execute({
    sql: `UPDATE smartcommerce_sync_outbox
      SET status='needs_review', attempts=attempts+1, last_http_status=?,
          last_error_code=?, next_attempt_at=NULL
      WHERE event_id=? AND status='pending'`,
    args: [httpStatus || null, code, row.event_id],
  });
}

async function markRetry(row, httpStatus, code) {
  const delay = backoffSeconds(Number(row.attempts || 0) + 1);
  await db.execute({
    sql: `UPDATE smartcommerce_sync_outbox
      SET attempts=attempts+1, last_http_status=?, last_error_code=?,
          next_attempt_at=datetime('now', ?)
      WHERE event_id=? AND status='pending'`,
    args: [httpStatus || null, code, `+${delay} seconds`, row.event_id],
  });
}

async function deliverRow(row, endpoint, secret, fetchImpl = fetch) {
  const body = JSON.stringify(envelope(row));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHmac('sha256', secret).update(timestamp).update('.').update(body).digest('hex');

  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-POS-Timestamp': timestamp,
        'X-POS-Signature': `sha256=${signature}`,
      },
      body,
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    await markRetry(row, null, 'NETWORK_UNAVAILABLE');
    return 'retry';
  }

  if (response.status === 200 || response.status === 202) {
    await markDelivered(row, response.status);
    return 'delivered';
  }

  if (response.status === 409) {
    await markNeedsReview(row, response.status, 'SMARTCOMMERCE_CONFLICT_OR_BLOCKED');
    return 'needs_review';
  }

  if ([400, 401, 403, 404, 405, 413, 415, 422].includes(response.status)) {
    await markNeedsReview(row, response.status, `HTTP_${response.status}`);
    return 'needs_review';
  }

  await markRetry(row, response.status, `HTTP_${response.status}`);
  return 'retry';
}

let flushPromise = null;
async function flushSmartCommerceSyncOutbox(options = {}) {
  if (flushPromise) return flushPromise;
  flushPromise = (async () => {
    const endpoint = configuredEndpoint();
    const secret = signingSecret();
    if (!endpoint || !secret) return { status: 'not_configured', delivered: 0, retry: 0, needsReview: 0 };

    const rows = await claimBatch(options.limit || 25);
    const result = { status: 'ok', delivered: 0, retry: 0, needsReview: 0 };
    for (const row of rows) {
      const disposition = await deliverRow(row, endpoint, secret, options.fetchImpl);
      if (disposition === 'delivered') result.delivered += 1;
      else if (disposition === 'needs_review') result.needsReview += 1;
      else result.retry += 1;
    }
    return result;
  })();

  try { return await flushPromise; }
  finally { flushPromise = null; }
}

module.exports = {
  flushSmartCommerceSyncOutbox,
  _test: { configuredEndpoint, signingSecret, backoffSeconds, envelope },
};
