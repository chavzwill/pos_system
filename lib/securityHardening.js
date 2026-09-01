const crypto = require('crypto');
const { db, ensureReady } = require('../database');
const { readCookie, hashToken, loadEmployee } = require('./sessionAuth');
const { can } = require('./permissions');

const WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX = 10;
const PIN_MAX = 8;
const DIAG_MAX = 30;
const buckets = new Map();

const PRIVATE_UPLOAD_RULES = [
  { prefix: '/uploads/customer-ids/', permissions: ['customers', 'rentals'] },
  { prefix: '/uploads/rental-signatures/', permissions: ['rentals'] },
  { prefix: '/uploads/rental-po-attachments/', permissions: ['rentals'] },
  { prefix: '/uploads/po-attachments/', permissions: ['purchasing'] },
];

function now() { return Date.now(); }
function clientIp(req) {
  return String(req.ip || req.socket?.remoteAddress || 'unknown').slice(0, 128);
}
function normalizedSuffix(value) {
  return String(value || '').toLowerCase().slice(0, 128);
}
function bucketKey(kind, req, suffix = '') {
  return `${kind}:ip:${clientIp(req)}:${normalizedSuffix(suffix)}`;
}
function subjectBucketKey(kind, suffix = '') {
  return `${kind}:subject:${normalizedSuffix(suffix)}`;
}
function consume(key, max, windowMs = WINDOW_MS) {
  const t = now();
  let row = buckets.get(key);
  if (!row || row.resetAt <= t) row = { count: 0, resetAt: t + windowMs };
  row.count += 1;
  buckets.set(key, row);
  if (row.count <= max) return { allowed: true, remaining: Math.max(0, max - row.count), resetAt: row.resetAt };
  return { allowed: false, remaining: 0, resetAt: row.resetAt };
}
function reset(key) { buckets.delete(key); }
function rateLimit(kind, max, suffixFn, { subjectLimit = false } = {}) {
  return (req, res, next) => {
    const suffix = suffixFn ? suffixFn(req) : '';
    const keys = [bucketKey(kind, req, suffix)];
    if (subjectLimit && normalizedSuffix(suffix)) keys.push(subjectBucketKey(kind, suffix));
    const verdicts = keys.map(key => ({ key, verdict: consume(key, max) }));
    const blocked = verdicts.find(v => !v.verdict.allowed);
    const remaining = Math.min(...verdicts.map(v => v.verdict.remaining));
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, remaining)));
    if (blocked) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((blocked.verdict.resetAt - now()) / 1000))));
      return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    }
    req.securityRateLimitKeys = keys;
    next();
  };
}

const loginRateLimit = rateLimit('login', LOGIN_MAX, req => req.body?.username || '', { subjectLimit: true });
const privilegedPinRateLimit = rateLimit('pin', PIN_MAX, req => req.body?.permission || 'general');
const diagnosticsRateLimit = rateLimit('diagnostic', DIAG_MAX);
function resetRequestRateLimit(req) {
  for (const key of (req.securityRateLimitKeys || [])) reset(key);
}

function privateUploadRule(req) {
  const requestPath = String(req.path || req.originalUrl || '').split('?')[0];
  return PRIVATE_UPLOAD_RULES.find(rule => requestPath.startsWith(rule.prefix)) || null;
}

async function authorizePrivateUpload(req, res, rule) {
  try {
    await ensureReady();
    const raw = readCookie(req);
    if (!raw) {
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(401).json({ error: 'Authentication required' });
      return false;
    }
    const { rows: [session] } = await db.execute({
      sql: "SELECT employee_id FROM sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > datetime('now')",
      args: [hashToken(raw)],
    });
    if (!session) {
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(401).json({ error: 'Authentication required' });
      return false;
    }
    const employee = await loadEmployee(session.employee_id);
    if (!employee) {
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(401).json({ error: 'Authentication required' });
      return false;
    }
    if (!rule.permissions.some(permission => can(employee.permissions, permission))) {
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(403).json({ error: 'Insufficient permission for protected evidence' });
      return false;
    }
    req.employee = employee;
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('Content-Disposition', 'inline');
    return true;
  } catch (error) {
    console.error('Private evidence authorization failed:', error && (error.stack || error.message || error));
    res.status(500).json({ error: 'Protected evidence authorization failed' });
    return false;
  }
}

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.removeHeader('X-Powered-By');

  const rule = privateUploadRule(req);
  if (!rule) return next();
  authorizePrivateUpload(req, res, rule).then(allowed => {
    if (allowed) next();
  });
}

function normalizedOrigin(req) {
  const proto = req.protocol || (req.secure ? 'https' : 'http');
  const host = req.get('host');
  return host ? `${proto}://${host}` : null;
}
function sameOriginMutationGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.apiKey) return next();
  const fetchSite = String(req.get('sec-fetch-site') || '').toLowerCase();
  if (fetchSite === 'cross-site') return res.status(403).json({ error: 'Cross-site mutation blocked' });
  const origin = req.get('origin');
  if (!origin) return next();
  const expected = normalizedOrigin(req);
  if (!expected) return res.status(403).json({ error: 'Unable to verify request origin' });
  try {
    if (new URL(origin).origin !== new URL(expected).origin) {
      return res.status(403).json({ error: 'Cross-origin mutation blocked' });
    }
  } catch (_) {
    return res.status(403).json({ error: 'Invalid request origin' });
  }
  next();
}

function buildCorsOptions() {
  const configured = String(process.env.POS_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  return {
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (configured.includes(origin)) return callback(null, true);
      return callback(new Error('CORS origin denied'));
    },
    credentials: false,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
    maxAge: 600,
  };
}

function requestId(req, res, next) {
  const incoming = String(req.get('x-request-id') || '').trim();
  const safe = /^[A-Za-z0-9._:-]{8,128}$/.test(incoming) ? incoming : crypto.randomUUID();
  req.requestId = safe;
  res.setHeader('X-Request-Id', safe);
  next();
}

module.exports = {
  securityHeaders,
  sameOriginMutationGuard,
  buildCorsOptions,
  loginRateLimit,
  privilegedPinRateLimit,
  diagnosticsRateLimit,
  resetRequestRateLimit,
  requestId,
  PRIVATE_UPLOAD_RULES,
};
