'use strict';

const fs = require('fs');

function replaceExactly(text, from, to, label) {
  const first = text.indexOf(from);
  if (first < 0 || text.indexOf(from, first + from.length) >= 0) throw new Error(`${label} marker drifted`);
  return text.slice(0, first) + to + text.slice(first + from.length);
}

let employees = fs.readFileSync('routes/employees.js', 'utf8');
const resetMarker = "router.post('/:id/reset-password', requirePermission('security_manage'), async (req, res) => {";
const pinRoutes = `router.put('/:id/change-pin', requireAuth, async (req, res) => {
  if (req.apiKey) return res.status(403).json({ error: 'API keys cannot change employee credentials' });
  const targetId = Number(req.params.id);
  const { pin, current_pin } = req.body || {};
  if (Number(req.employee?.id) !== targetId) return res.status(403).json({ error: 'Use the privileged reset-pin operation for another employee' });
  if (!validPin(pin)) return res.status(400).json({ error: 'PIN must be 6-10 digits' });
  try {
    const { rows: [target] } = await db.execute({ sql: 'SELECT id,pin,active FROM employees WHERE id=?', args: [targetId] });
    if (!target) return res.status(404).json({ error: 'Employee not found' });
    if (Number(target.active) === 0) return res.status(400).json({ error: 'Cannot change PIN for an inactive employee' });
    if (!(await verifyPin(target.pin, current_pin))) return res.status(403).json({ error: 'Current PIN is required and must be valid', code: 'CURRENT_PIN_REQUIRED' });
    if (await verifyPin(target.pin, pin)) return res.status(400).json({ error: 'New PIN must be different from the current PIN' });
    await ensureSecurityAuditTable();
    const pinHash = await hashPin(pin);
    const tx = await db.transaction('write');
    try {
      await tx.execute({ sql: 'UPDATE employees SET pin=? WHERE id=? AND active=1', args: [pinHash, targetId] });
      await destroyEmployeeSessions(targetId, tx);
      await recordSecurityAudit({
        actorEmployeeId: targetId,
        action: 'pin_changed_self',
        targetType: 'employee',
        targetId,
        oldValue: { credential: 'pin' },
        newValue: { credential: 'pin', sessions_revoked: true },
        reason: 'Authenticated self-service PIN change',
        requestId: req.requestId || null,
        method: req.method,
        path: req.originalUrl,
        control: 'credential_lifecycle',
        executor: tx,
      });
      await tx.commit();
    } catch (error) {
      await tx.rollback().catch(() => {});
      throw error;
    }
    clearSessionCookie(res);
    res.json({ success: true, reauthentication_required: true, sessions_revoked: true });
  } catch (e) {
    res.status(400).json({ error: 'Unable to change PIN' });
  }
});

router.post('/:id/reset-pin', requirePermission('security_manage'), async (req, res) => {
  if (req.apiKey) return res.status(403).json({ error: 'API keys cannot reset employee credentials' });
  const targetId = Number(req.params.id);
  if (Number(req.employee?.id) === targetId) return res.status(400).json({ error: 'Use change-pin for your own account' });
  const { pin, reason } = req.body || {};
  if (!validPin(pin)) return res.status(400).json({ error: 'PIN must be 6-10 digits' });
  if (String(reason || '').trim().length < 8) return res.status(400).json({ error: 'A PIN reset reason is required' });
  try {
    const { rows: [target] } = await db.execute({ sql: 'SELECT id,pin,active FROM employees WHERE id=?', args: [targetId] });
    if (!target) return res.status(404).json({ error: 'Employee not found' });
    if (Number(target.active) === 0) return res.status(400).json({ error: 'Cannot reset an inactive employee' });
    if (await verifyPin(target.pin, pin)) return res.status(400).json({ error: 'New PIN must be different from the current PIN' });
    await ensureSecurityAuditTable();
    const pinHash = await hashPin(pin);
    const tx = await db.transaction('write');
    try {
      await tx.execute({ sql: 'UPDATE employees SET pin=? WHERE id=? AND active=1', args: [pinHash, targetId] });
      await destroyEmployeeSessions(targetId, tx);
      await recordSecurityAudit({
        actorEmployeeId: req.employee.id,
        action: 'pin_reset_by_admin',
        targetType: 'employee',
        targetId,
        oldValue: { credential: 'pin' },
        newValue: { credential: 'pin', sessions_revoked: true },
        reason: String(reason).trim(),
        requestId: req.requestId || null,
        method: req.method,
        path: req.originalUrl,
        control: 'credential_lifecycle',
        executor: tx,
      });
      await tx.commit();
    } catch (error) {
      await tx.rollback().catch(() => {});
      throw error;
    }
    res.json({ success: true, sessions_revoked: true });
  } catch (e) {
    res.status(400).json({ error: 'Unable to reset PIN' });
  }
});

`;
employees = replaceExactly(employees, resetMarker, pinRoutes + resetMarker, 'PIN route insertion');

const genericPasswordGuard = "    if (password) return res.status(400).json({ error: 'Use the dedicated reset-password credential operation instead of employee profile edit' });";
employees = replaceExactly(
  employees,
  genericPasswordGuard,
  `${genericPasswordGuard}\n    if (pin !== undefined && pin !== null && String(pin) !== '') return res.status(400).json({ error: 'Use change-pin for your own PIN or reset-pin for another employee instead of employee profile edit' });`,
  'generic credential guard',
);
fs.writeFileSync('routes/employees.js', employees);

let session = fs.readFileSync('lib/sessionAuth.js', 'utf8');
session = replaceExactly(session, "const { employeePinCredentialGuard } = require('./credentialMutationGuard');\n", '', 'credential guard import');
session = replaceExactly(
  session,
  "function privilegedPasswordResetRequest(req) {\n  const path = String(req.originalUrl || req.url || '').split('?')[0];\n  return req.method === 'POST' && /^\\/api\\/employees\\/\\d+\\/reset-password$/.test(path);\n}",
  "function privilegedCredentialResetRequest(req) {\n  const path = String(req.originalUrl || req.url || '').split('?')[0];\n  return req.method === 'POST' && /^\\/api\\/employees\\/\\d+\\/reset-(?:password|pin)$/.test(path);\n}",
  'privileged reset matcher',
);
session = replaceExactly(session, 'if (privilegedPasswordResetRequest(req)) {', 'if (privilegedCredentialResetRequest(req)) {', 'privileged reset call');
session = replaceExactly(session, '    return employeePinCredentialGuard(req, res, next);', '    return next();', 'credential guard dispatch');
session = replaceExactly(session, '  privilegedPasswordResetRequest,', '  privilegedCredentialResetRequest,', 'credential matcher export');
fs.writeFileSync('lib/sessionAuth.js', session);

if (fs.existsSync('lib/credentialMutationGuard.js')) fs.unlinkSync('lib/credentialMutationGuard.js');
