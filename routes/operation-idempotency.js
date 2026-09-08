'use strict';
const express = require('express');
const crypto = require('crypto');
const { db } = require('../database');

const router = express.Router();
let readyPromise = null;
const ACTIVE_WINDOW_SECONDS = 15;

function ensureSchema() {
  if (readyPromise) return readyPromise;
  readyPromise = db.batch([
    { sql: `CREATE TABLE IF NOT EXISTS operation_idempotency (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      state TEXT NOT NULL DEFAULT 'in_progress',
      response_status INTEGER,
      response_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      UNIQUE(scope,idempotency_key)
    )` },
    { sql: 'CREATE INDEX IF NOT EXISTS idx_operation_idempotency_created ON operation_idempotency(created_at)' },
  ], 'write').catch(error => { readyPromise = null; throw error; });
  return readyPromise;
}

function stable(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

function hashRequest(req) {
  const payload = JSON.stringify({ method: req.method, path: req.path, query: stable(req.query || {}), body: stable(req.body || {}) });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function actor(req) {
  if (req.employee?.id != null) return { type: 'employee', id: String(req.employee.id) };
  if (req.apiKey) return { type: 'api_key', id: String(req.apiKey.id ?? req.apiKey.key_id ?? req.apiKey.name ?? 'authenticated') };
  return { type: 'anonymous', id: null };
}

function mutation(req) { return ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method); }
function keyFrom(req) { return String(req.get('Idempotency-Key') || req.get('X-Idempotency-Key') || '').trim(); }
function ageSeconds(row) {
  if (!row?.created_at) return null;
  const raw = String(row.created_at).includes('T') ? String(row.created_at) : String(row.created_at).replace(' ', 'T') + 'Z';
  const ms = Date.parse(raw); return Number.isFinite(ms) ? Math.max(0, Math.floor((Date.now() - ms) / 1000)) : null;
}

router.use(async (req, res, next) => {
  if (!mutation(req)) return next();
  const key = keyFrom(req);
  if (!key) return next();
  if (key.length > 160) return res.status(400).json({ error: 'Idempotency-Key is too long' });

  try {
    await ensureSchema();
    const who = actor(req);
    if (who.type === 'anonymous') return res.status(401).json({ error: 'Authentication required' });

    const scope = `${who.type}:${who.id}:${req.method}:${req.path}`;
    const requestHash = hashRequest(req);

    try {
      await db.execute({
        sql: `INSERT INTO operation_idempotency(scope,idempotency_key,request_hash,method,path,actor_type,actor_id,state)
              VALUES(?,?,?,?,?,?,?,'in_progress')`,
        args: [scope, key, requestHash, req.method, req.path, who.type, who.id],
      });
    } catch (error) {
      const { rows: [existing] } = await db.execute({ sql: 'SELECT * FROM operation_idempotency WHERE scope=? AND idempotency_key=?', args: [scope, key] });
      if (!existing) throw error;
      if (existing.request_hash !== requestHash) {
        return res.status(409).json({ error: 'This Idempotency-Key was already used with a different request payload', control: 'operation_idempotency' });
      }
      if (existing.state === 'completed') {
        res.set('Idempotency-Replayed', 'true');
        const status = Number(existing.response_status || 200);
        let payload = null;
        try { payload = JSON.parse(existing.response_json || 'null'); } catch (_) { payload = null; }
        if (status === 204) return res.status(204).end();
        return res.status(status).json(payload);
      }
      const age = ageSeconds(existing);
      if (age != null && age < ACTIVE_WINDOW_SECONDS) res.set('Retry-After', String(Math.max(1, ACTIVE_WINDOW_SECONDS - age)));
      return res.status(409).json({
        error: age != null && age >= ACTIVE_WINDOW_SECONDS
          ? 'The earlier operation did not record a final receipt. Its business outcome is unknown. Verify the related sale, receipt, rental, repair, inventory or dispatch record before starting a new operation.'
          : 'An operation with this Idempotency-Key is already in progress. Wait for its outcome and retry with the same operation identity.',
        control: age != null && age >= ACTIVE_WINDOW_SECONDS ? 'operation_idempotency_outcome_unknown' : 'operation_idempotency_in_progress',
        idempotency_key: key,
        age_seconds: age,
      });
    }

    let captured = false;
    let bypass = false;
    const originalJson = res.json.bind(res);
    const originalEnd = res.end.bind(res);

    async function persistReceipt(status, payload) {
      await db.execute({
        sql: `UPDATE operation_idempotency SET state='completed',response_status=?,response_json=?,completed_at=CURRENT_TIMESTAMP
              WHERE scope=? AND idempotency_key=? AND state='in_progress'`,
        args: [status, JSON.stringify(payload ?? null), scope, key],
      });
    }

    async function receiptFailure(error) {
      console.error('Unable to persist idempotent operation response:', error && (error.stack || error.message || error));
      if (res.headersSent) return originalEnd();
      bypass = true;
      res.status(500);
      return originalJson({
        error: 'The business operation may have completed, but its retry receipt could not be persisted. Verify the operation before retrying.',
        control: 'operation_idempotency_receipt_failure',
        idempotency_key: key,
      });
    }

    res.json = function idempotentJson(payload) {
      if (bypass || captured) return originalJson(payload);
      captured = true;
      const status = res.statusCode || 200;
      Promise.resolve(persistReceipt(status, payload)).then(() => {
        bypass = true;
        res.set('Idempotency-Replayed', 'false');
        originalJson(payload);
      }).catch(receiptFailure);
      return res;
    };

    res.end = function idempotentEnd(chunk, encoding, callback) {
      if (bypass || captured) return originalEnd(chunk, encoding, callback);
      captured = true;
      const status = res.statusCode || 200;
      Promise.resolve(persistReceipt(status, null)).then(() => {
        bypass = true;
        res.set('Idempotency-Replayed', 'false');
        originalEnd(chunk, encoding, callback);
      }).catch(receiptFailure);
      return res;
    };

    next();
  } catch (error) {
    res.status(500).json({ error: 'Unable to initialize operation idempotency protection', detail: error.message });
  }
});

router.get('/operation-idempotency/:key', async (req, res) => {
  try {
    await ensureSchema();
    const who = actor(req);
    if (who.type === 'anonymous') return res.status(401).json({ error: 'Authentication required' });
    const { rows } = await db.execute({
      sql: `SELECT idempotency_key,method,path,state,response_status,created_at,completed_at
            FROM operation_idempotency WHERE actor_type=? AND actor_id=? AND idempotency_key=? ORDER BY id DESC LIMIT 20`,
      args: [who.type, who.id, req.params.key],
    });
    res.json(rows.map(row => ({ ...row, age_seconds: row.state === 'in_progress' ? ageSeconds(row) : null })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
module.exports.ensureSchema = ensureSchema;
