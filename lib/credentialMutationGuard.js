'use strict';

const bcrypt = require('bcryptjs');
const { db } = require('../database');
const { can } = require('./permissions');
const { recordSecurityAudit } = require('./securityAudit');

function isBcryptHash(value) {
  return typeof value === 'string' && /^\$2[aby]\$/.test(value);
}

async function verifyStored(stored, supplied) {
  if (!stored || supplied == null || supplied === '') return false;
  if (isBcryptHash(stored)) return bcrypt.compare(String(supplied), stored);
  return String(stored) === String(supplied);
}

function targetFromPath(req) {
  if (req.method !== 'PUT') return null;
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  const match = path.match(/^\/api\/employees\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

function pinMutationRequested(req) {
  return req.body && req.body.pin !== undefined && req.body.pin !== null && String(req.body.pin) !== '';
}

async function employeePinCredentialGuard(req, res, next) {
  const targetId = targetFromPath(req);
  if (!targetId || !pinMutationRequested(req)) return next();
  if (req.apiKey) return res.status(403).json({ error: 'API keys cannot change employee credentials' });
  if (!req.employee?.id) return res.status(401).json({ error: 'Authentication required' });

  try {
    const { rows: [target] } = await db.execute({
      sql: 'SELECT id,pin,active FROM employees WHERE id=?',
      args: [targetId],
    });
    if (!target) return res.status(404).json({ error: 'Employee not found' });

    const actorId = Number(req.employee.id);
    const crossUser = actorId !== targetId;
    if (crossUser) {
      if (!can(req.employee.permissions, 'security_manage')) {
        return res.status(403).json({ error: 'Changing another employee PIN requires Security Management authority' });
      }
      const reason = String(req.body.reason || '').trim();
      if (reason.length < 8) return res.status(400).json({ error: 'A PIN reset reason is required' });
      const { rows: [actor] } = await db.execute({
        sql: 'SELECT password FROM employees WHERE id=? AND active=1',
        args: [actorId],
      });
      if (!actor?.password || !isBcryptHash(actor.password) || !(await bcrypt.compare(String(req.body.reauth_password || ''), actor.password))) {
        return res.status(403).json({
          error: 'Elevated reauthentication is required for another employee PIN reset',
          code: 'REAUTHENTICATION_REQUIRED',
        });
      }
    } else if (!(await verifyStored(target.pin, req.body.current_pin))) {
      return res.status(403).json({
        error: 'Current PIN is required and must be valid',
        code: 'CURRENT_PIN_REQUIRED',
      });
    }

    if (await verifyStored(target.pin, req.body.pin)) {
      return res.status(400).json({ error: 'New PIN must be different from the current PIN' });
    }

    // The legacy employee profile route owns the actual update. Record evidence
    // only after it reports success; never persist PIN values in the audit log.
    res.once('finish', () => {
      if (res.statusCode < 200 || res.statusCode >= 300) return;
      recordSecurityAudit({
        actorEmployeeId: actorId,
        action: crossUser ? 'pin_reset_by_admin' : 'pin_changed_self',
        targetType: 'employee',
        targetId,
        oldValue: { credential: 'pin' },
        newValue: { credential: 'pin', sessions_revoked: true },
        reason: crossUser ? String(req.body.reason || '').trim() : 'Authenticated self-service PIN change',
        requestId: req.requestId || null,
        method: req.method,
        path: String(req.originalUrl || req.url || '').split('?')[0],
        control: 'credential_lifecycle',
      }).catch(error => {
        console.error('PIN credential audit persistence failed', {
          request_id: req.requestId || null,
          target_id: targetId,
          message: String(error?.message || error).slice(0, 300),
        });
      });
    });

    next();
  } catch (error) {
    console.error('PIN credential authorization failed', {
      request_id: req.requestId || null,
      target_id: targetId,
      message: String(error?.message || error).slice(0, 300),
    });
    return res.status(500).json({ error: 'Credential authorization failed', request_id: req.requestId || null });
  }
}

module.exports = { employeePinCredentialGuard, targetFromPath, pinMutationRequested, verifyStored };