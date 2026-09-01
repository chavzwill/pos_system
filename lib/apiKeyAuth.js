const crypto = require('crypto');
const { db } = require('../database');

// Routes that API keys are allowed to access, mapped to required scope.
// Method null = any non-GET method. API keys are deliberately integration-only:
// endpoints not listed here are employee-session APIs and are never reachable
// with an API key, even if an older key still carries the legacy '*' scope.
const SCOPE_RULES = [
  { method: 'GET',  prefix: '/api/products',      scope: 'products:read'    },
  { method: null,   prefix: '/api/products',      scope: 'products:write'   },
  { method: 'GET',  prefix: '/api/categories',    scope: 'products:read'    },
  { method: 'GET',  prefix: '/api/commerce-sync', scope: 'products:read'    },
  { method: 'GET',  prefix: '/api/smartcommerce-orders', scope: 'orders:read' },
  { method: null,   prefix: '/api/smartcommerce-orders', scope: 'orders:write' },
  { method: 'GET',  prefix: '/api/customer-repair-portal', scope: 'repairs:read' },
  { method: null,   prefix: '/api/customer-repair-portal', scope: 'repairs:write' },
  { method: 'GET',  prefix: '/api/customers',     scope: 'customers:read'   },
  { method: null,   prefix: '/api/customers',     scope: 'customers:write'  },
  { method: 'GET',  prefix: '/api/transactions',  scope: 'orders:read'      },
  { method: null,   prefix: '/api/transactions',  scope: 'orders:write'     },
];

const VALID_WINDOW_MS = 60 * 1000;
const VALID_MAX_PER_WINDOW = Number(process.env.POS_API_KEY_RATE_LIMIT || 300);
const INVALID_WINDOW_MS = 15 * 60 * 1000;
const INVALID_MAX_PER_WINDOW = Number(process.env.POS_API_KEY_INVALID_LIMIT || 20);
const buckets = new Map();

function hashKey(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function requiredScope(method, path) {
  for (const rule of SCOPE_RULES) {
    if (!path.startsWith(rule.prefix)) continue;
    if (rule.method === null && method === 'GET') continue;
    if (rule.method !== null && rule.method !== method) continue;
    return rule.scope;
  }
  return null;
}

function clientIp(req) {
  return String(req.ip || req.socket?.remoteAddress || 'unknown').slice(0, 128);
}
function consume(key, limit, windowMs) {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) bucket = { count: 0, resetAt: now + windowMs };
  bucket.count += 1;
  buckets.set(key, bucket);
  // Bound memory even under random invalid credentials.
  if (buckets.size > 5000) {
    for (const [k, value] of buckets) if (value.resetAt <= now) buckets.delete(k);
    while (buckets.size > 5000) buckets.delete(buckets.keys().next().value);
  }
  return { allowed: bucket.count <= limit, remaining: Math.max(0, limit - bucket.count), resetAt: bucket.resetAt };
}
function rateLimitResponse(res, verdict, limit) {
  res.setHeader('X-RateLimit-Limit', String(limit));
  res.setHeader('X-RateLimit-Remaining', String(verdict.remaining));
  res.setHeader('Retry-After', String(Math.max(1, Math.ceil((verdict.resetAt - Date.now()) / 1000))));
  return res.status(429).json({ error: 'API key request rate exceeded. Retry later.' });
}

async function apiKeyAuth(req, res, next) {
  const header = req.headers['x-api-key'] ||
    (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');

  if (!header) return next();
  if (typeof header !== 'string' || header.length < 20 || header.length > 256) {
    const verdict = consume(`invalid:${clientIp(req)}`, INVALID_MAX_PER_WINDOW, INVALID_WINDOW_MS);
    if (!verdict.allowed) return rateLimitResponse(res, verdict, INVALID_MAX_PER_WINDOW);
    return res.status(401).json({ error: 'Invalid or revoked API key' });
  }

  const hash = hashKey(header);

  let keyRow;
  try {
    const { rows } = await db.execute({
      sql: 'SELECT * FROM api_keys WHERE key_hash = ? AND is_active = 1',
      args: [hash],
    });
    keyRow = rows[0];
  } catch (e) {
    return res.status(500).json({ error: 'Auth check failed' });
  }

  if (!keyRow) {
    const verdict = consume(`invalid:${clientIp(req)}`, INVALID_MAX_PER_WINDOW, INVALID_WINDOW_MS);
    if (!verdict.allowed) return rateLimitResponse(res, verdict, INVALID_MAX_PER_WINDOW);
    return res.status(401).json({ error: 'Invalid or revoked API key' });
  }

  const verdict = consume(`key:${keyRow.id}`, VALID_MAX_PER_WINDOW, VALID_WINDOW_MS);
  if (!verdict.allowed) return rateLimitResponse(res, verdict, VALID_MAX_PER_WINDOW);
  res.setHeader('X-RateLimit-Limit', String(VALID_MAX_PER_WINDOW));
  res.setHeader('X-RateLimit-Remaining', String(verdict.remaining));

  let scopes=[];
  try { scopes = JSON.parse(keyRow.scopes || '[]'); } catch (_) { return res.status(403).json({ error: 'API key scope configuration is invalid' }); }
  const path = req.originalUrl.split('?')[0];
  const needed = requiredScope(req.method, path);

  if (!needed) return res.status(403).json({ error: 'API keys are not permitted on this employee endpoint' });
  if (!scopes.includes('*') && !scopes.includes(needed)) {
    return res.status(403).json({ error: `API key missing scope: ${needed}` });
  }

  db.execute({
    sql: "UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?",
    args: [keyRow.id],
  }).catch(() => {});

  req.apiKey = { id: keyRow.id, name: keyRow.name, scopes, required_scope: needed };
  next();
}

module.exports = { apiKeyAuth, hashKey, SCOPE_RULES, requiredScope, VALID_MAX_PER_WINDOW, INVALID_MAX_PER_WINDOW };
