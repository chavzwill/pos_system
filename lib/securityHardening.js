const crypto = require('crypto');

const WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX = 10;
const PIN_MAX = 8;
const DIAG_MAX = 30;
const buckets = new Map();

function now() { return Date.now(); }
function clientIp(req) {
  return String(req.ip || req.socket?.remoteAddress || 'unknown').slice(0, 128);
}
function bucketKey(kind, req, suffix = '') {
  return `${kind}:${clientIp(req)}:${String(suffix || '').toLowerCase().slice(0, 128)}`;
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
function rateLimit(kind, max, suffixFn) {
  return (req, res, next) => {
    const suffix = suffixFn ? suffixFn(req) : '';
    const key = bucketKey(kind, req, suffix);
    const verdict = consume(key, max);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(verdict.remaining));
    if (!verdict.allowed) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((verdict.resetAt - now()) / 1000))));
      return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    }
    req.securityRateLimitKey = key;
    next();
  };
}

const loginRateLimit = rateLimit('login', LOGIN_MAX, req => req.body?.username || '');
const privilegedPinRateLimit = rateLimit('pin', PIN_MAX, req => req.body?.permission || 'general');
const diagnosticsRateLimit = rateLimit('diagnostic', DIAG_MAX);
function resetRequestRateLimit(req) {
  if (req.securityRateLimitKey) reset(req.securityRateLimitKey);
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
  next();
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
  if (!origin) return next(); // non-browser/native clients may omit Origin
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
      // Same-origin browser calls generally have no CORS Origin requirement.
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
};
