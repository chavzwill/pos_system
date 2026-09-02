const crypto = require('crypto');
const { db } = require('../database');
const { can } = require('./permissions');

const SESSION_IDLE_TTL_MS = 8 * 60 * 60 * 1000;
const SESSION_ABSOLUTE_TTL_MS = 12 * 60 * 60 * 1000;
const COOKIE_NAME = 'pos_session';

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// SQLite CURRENT_TIMESTAMP uses `YYYY-MM-DD HH:MM:SS` UTC while some session
// rows use JavaScript ISO timestamps. Normalize both explicitly instead of
// relying on SQLite/libSQL datetime coercion for authentication decisions.
function parseUtcTimestamp(value) {
  if (value == null || value === '') return NaN;
  if (value instanceof Date) return value.getTime();
  const raw = String(value).trim();
  if (!raw) return NaN;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)) {
    return Date.parse(raw.replace(' ', 'T') + 'Z');
  }
  return Date.parse(raw);
}

function sessionDeadlines(session, nowMs = Date.now()) {
  const createdMs = parseUtcTimestamp(session.created_at);
  const idleExpiryMs = parseUtcTimestamp(session.expires_at);
  if (!Number.isFinite(createdMs) || !Number.isFinite(idleExpiryMs)) {
    return { valid: false, createdMs, idleExpiryMs, absoluteExpiryMs: NaN, nextIdleExpiryMs: NaN };
  }
  const absoluteExpiryMs = createdMs + SESSION_ABSOLUTE_TTL_MS;
  const valid = idleExpiryMs > nowMs && absoluteExpiryMs > nowMs;
  return {
    valid,
    createdMs,
    idleExpiryMs,
    absoluteExpiryMs,
    nextIdleExpiryMs: Math.min(nowMs + SESSION_IDLE_TTL_MS, absoluteExpiryMs),
  };
}

async function createSession(employeeId) {
  const raw = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_IDLE_TTL_MS).toISOString();
  await db.execute({
    sql: 'INSERT INTO sessions (token_hash, employee_id, expires_at) VALUES (?, ?, ?)',
    args: [hashToken(raw), employeeId, expiresAt],
  });
  return raw;
}

async function destroySession(rawToken) {
  if (!rawToken) return;
  await db.execute({
    sql: "UPDATE sessions SET revoked_at = datetime('now') WHERE token_hash = ?",
    args: [hashToken(rawToken)],
  });
}

async function destroyEmployeeSessions(employeeId) {
  if (!employeeId) return;
  await db.execute({
    sql: "UPDATE sessions SET revoked_at = datetime('now') WHERE employee_id = ? AND revoked_at IS NULL",
    args: [employeeId],
  });
}

function readCookie(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === COOKIE_NAME) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

function setSessionCookie(req, res, rawToken) {
  const secure = req.secure || process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const maxAge = Math.floor(SESSION_ABSOLUTE_TTL_MS / 1000);
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(rawToken)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`);
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
}

async function loadEmployee(employeeId) {
  const { rows: [emp] } = await db.execute({
    sql: `SELECT e.id, e.first_name, e.last_name, e.username, e.security_group_id, e.default_branch_id, e.must_change_password,
      sg.name as security_group_name, sg.permissions, b.name as default_branch_name
      FROM employees e
      LEFT JOIN security_groups sg ON e.security_group_id = sg.id
      LEFT JOIN branches b ON e.default_branch_id = b.id
      WHERE e.id = ? AND e.active = 1`,
    args: [employeeId],
  });
  if (!emp) return null;
  emp.permissions = emp.permissions ? JSON.parse(emp.permissions) : {};
  return emp;
}

function forcedPasswordChangeAllowed(req, employee) {
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  if (req.method === 'POST' && path === '/api/employees/logout') return true;
  if (req.method === 'PUT' && path === `/api/employees/${Number(employee?.id)}/change-password`) return true;
  return false;
}

function legacySensitiveMutationGuard(req,res){
  if(req.method==='GET'||req.method==='HEAD'||req.method==='OPTIONS')return false;
  const path=String(req.originalUrl||'').split('?')[0];
  if(path.startsWith('/api/accounting-source-sync/')&&!can(req.employee?.permissions,'reports_financial')){
    res.status(403).json({error:'Missing permission: reports_financial'});
    return true;
  }
  return false;
}

async function sessionAuth(req, res, next) {
  if (req.apiKey) return next();

  const raw = readCookie(req);
  if (!raw) return next();

  try {
    const { rows: [session] } = await db.execute({
      sql: `SELECT * FROM sessions
        WHERE token_hash = ?
          AND revoked_at IS NULL`,
      args: [hashToken(raw)],
    });
    if (!session) {
      clearSessionCookie(res);
      return next();
    }

    const deadlines = sessionDeadlines(session);
    if (!deadlines.valid) {
      await destroySession(raw).catch(() => {});
      clearSessionCookie(res);
      return next();
    }

    const emp = await loadEmployee(session.employee_id);
    if (!emp) {
      await destroySession(raw).catch(() => {});
      clearSessionCookie(res);
      return next();
    }
    req.employee = emp;
    req.sessionRecord = { id: session.id, employee_id: session.employee_id };

    // A forced first-login/reset password state is an authentication state,
    // not a frontend hint. Until the employee changes their own password the
    // session may do exactly two things: change that password or log out.
    // This runs before permission/branch/business middleware, so no normal
    // POS operation can be reached with a bootstrap/reset credential.
    if (Number(emp.must_change_password) === 1 && !forcedPasswordChangeAllowed(req, emp)) {
      return res.status(403).json({
        error: 'Password change required before continuing',
        code: 'PASSWORD_CHANGE_REQUIRED',
      });
    }

    if(legacySensitiveMutationGuard(req,res)) return;

    // Active use slides only the idle deadline. The absolute deadline remains
    // created_at + 12h and is never extended by activity.
    db.execute({
      sql: `UPDATE sessions
        SET last_seen_at = datetime('now'), expires_at = ?
        WHERE id = ? AND revoked_at IS NULL`,
      args: [new Date(deadlines.nextIdleExpiryMs).toISOString(), session.id],
    }).catch(error => {
      console.error('Session activity update failed', {
        request_id: req.requestId || null,
        session_id: session.id,
        message: String(error?.message || error).slice(0, 300),
      });
    });
  } catch (e) {
    // Fail closed, but keep a bounded server-side diagnostic so auth
    // infrastructure regressions are distinguishable from bad credentials.
    console.error('Session authentication failed', {
      request_id: req.requestId || null,
      message: String(e?.message || e).slice(0, 300),
    });
  }
  next();
}

module.exports = {
  sessionAuth,
  createSession,
  destroySession,
  destroyEmployeeSessions,
  setSessionCookie,
  clearSessionCookie,
  hashToken,
  loadEmployee,
  readCookie,
  forcedPasswordChangeAllowed,
  legacySensitiveMutationGuard,
  SESSION_IDLE_TTL_MS,
  SESSION_ABSOLUTE_TTL_MS,
  parseUtcTimestamp,
  sessionDeadlines,
};
