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
  // Customer repair portal contract is intentionally narrower than the
  // employee work-order API. Reads expose only customer-visible service data;
  // writes are limited to auditable customer portal decisions/messages.
  { method: 'GET',  prefix: '/api/customer-repair-portal', scope: 'repairs:read' },
  { method: null,   prefix: '/api/customer-repair-portal', scope: 'repairs:write' },
  { method: 'GET',  prefix: '/api/customers',     scope: 'customers:read'   },
  { method: null,   prefix: '/api/customers',     scope: 'customers:write'  },
  { method: 'GET',  prefix: '/api/transactions',  scope: 'orders:read'      },
  { method: null,   prefix: '/api/transactions',  scope: 'orders:write'     },
];

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

async function apiKeyAuth(req, res, next) {
  const header = req.headers['x-api-key'] ||
    (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');

  if (!header) return next();

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

  if (!keyRow) return res.status(401).json({ error: 'Invalid or revoked API key' });

  let scopes=[];
  try { scopes = JSON.parse(keyRow.scopes || '[]'); } catch (_) { return res.status(403).json({ error: 'API key scope configuration is invalid' }); }
  const path = req.originalUrl.split('?')[0];
  const needed = requiredScope(req.method, path);

  // Fail closed. Internal employee APIs are never exposed merely because a
  // key has a legacy wildcard. '*' remains recognized only as a compatibility
  // grant across the explicit integration allowlist above.
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

module.exports = { apiKeyAuth, hashKey, SCOPE_RULES, requiredScope };
