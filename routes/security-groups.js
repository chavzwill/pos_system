const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { PERMISSION_TREE, can, requireAuth, requirePermission } = require('../lib/permissions');
const { ensureSecurityAuditTable, recordSecurityAudit } = require('../lib/securityAudit');

const KNOWN_PERMISSION_KEYS = [...new Set(PERMISSION_TREE.flatMap(mod => [mod.key, ...mod.subs.map(sub => sub.key)]))];

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
function parsePermissions(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try { return JSON.parse(value || '{}'); } catch (_) { return {}; }
}
function normalizedPermissions(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const allowed = new Set(KNOWN_PERMISSION_KEYS);
  const out = {};
  for (const key of allowed) if (Object.prototype.hasOwnProperty.call(input, key)) out[key] = input[key] === true;
  return out;
}
function canManageGroupMembership(actorPermissions, groupPermissions) {
  if (can(actorPermissions, 'security_manage')) return true;
  const target = groupPermissions && typeof groupPermissions === 'object' && !Array.isArray(groupPermissions) ? groupPermissions : {};

  // Compare effective authority, not only stored keys. A broad parent such as
  // { security:true } implicitly grants security_manage and security_assign;
  // a bounded assigner who only has security_assign must therefore fail this
  // comparison even though can(actor,'security') is also true.
  for (const permission of KNOWN_PERMISSION_KEYS) {
    if (can(target, permission) && !can(actorPermissions, permission)) return false;
  }

  // Fail closed for any legacy/unknown enabled authority that is not covered
  // by the current catalog. Recognized aliases may still be satisfied by can().
  const known = new Set(KNOWN_PERMISSION_KEYS);
  for (const [permission, enabled] of Object.entries(target)) {
    if (enabled === true && !known.has(permission) && !can(actorPermissions, permission)) return false;
  }
  return true;
}
async function getGroup(id, executor = db) {
  const { rows: [group] } = await executor.execute({ sql: 'SELECT * FROM security_groups WHERE id = ?', args: [id] });
  if (!group) return null;
  group.permissions = parsePermissions(group.permissions);
  return group;
}
async function currentActorPermissions(executor, req, requiredPermission) {
  if (!req.employee?.id) throw httpError(401, 'Authentication required');
  const { rows: [actor] } = await executor.execute({
    sql: `SELECT e.id,e.active,e.security_group_id,sg.permissions
          FROM employees e LEFT JOIN security_groups sg ON sg.id=e.security_group_id
          WHERE e.id=?`,
    args: [req.employee.id],
  });
  if (!actor || !actor.active) throw httpError(403, 'Your employee account is no longer active');
  const permissions = parsePermissions(actor.permissions);
  if (!can(permissions, requiredPermission)) throw httpError(403, `Missing permission: ${requiredPermission}`);
  return { ...actor, permissions };
}
async function activeSecurityAdminCount(executor = db, { groupOverride = null, excludeEmployeeId = null } = {}) {
  const { rows } = await executor.execute({
    sql: `SELECT e.id,e.security_group_id,sg.permissions
          FROM employees e LEFT JOIN security_groups sg ON sg.id=e.security_group_id
          WHERE e.active=1`,
    args: [],
  });
  let count = 0;
  for (const employee of rows) {
    if (excludeEmployeeId != null && Number(employee.id) === Number(excludeEmployeeId)) continue;
    let permissions = parsePermissions(employee.permissions);
    if (groupOverride && Number(employee.security_group_id) === Number(groupOverride.id)) permissions = groupOverride.permissions;
    if (can(permissions, 'security_manage')) count += 1;
  }
  return count;
}
async function auditInTransaction(tx, req, action, targetType, targetId, oldValue, newValue, reason) {
  await recordSecurityAudit({
    executor: tx,
    actorEmployeeId: req.employee?.id || null,
    action,
    targetType,
    targetId,
    oldValue,
    newValue,
    reason,
    requestId: req.requestId || null,
    method: req.method || null,
    path: String(req.originalUrl || req.path || '').split('?')[0],
    control: 'security_governance',
  });
}
async function writeTransaction(work) {
  await ensureSecurityAuditTable();
  const tx = await db.transaction('write');
  let committed = false;
  try {
    const value = await work(tx);
    await tx.commit();
    committed = true;
    return value;
  } catch (error) {
    if (!committed) await tx.rollback().catch(() => {});
    throw error;
  }
}
function sendError(res, error, fallbackStatus = 500) {
  res.status(error?.status || fallbackStatus).json({ error: error?.message || 'Security operation failed' });
}

// Lookup list used by employee forms. The permission payload is intentionally
// stripped unless the caller is allowed to inspect security configuration.
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows: groups } = await db.execute({ sql: 'SELECT * FROM security_groups ORDER BY name', args: [] });
    for (const g of groups) {
      const { rows: [countRow] } = await db.execute({ sql: 'SELECT COUNT(*) as c FROM employees WHERE security_group_id = ? AND active = 1', args: [g.id] });
      g.member_count = Number(countRow.c);
      if (req.apiKey || can(req.employee?.permissions, 'security')) g.permissions = parsePermissions(g.permissions);
      else delete g.permissions;
    }
    res.json(groups);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/catalog', requirePermission('security'), (req, res) => {
  res.json(PERMISSION_TREE);
});
router.get('/audit/recent', requirePermission('security_manage'), async (req, res) => {
  try {
    await ensureSecurityAuditTable();
    const { rows } = await db.execute({ sql: `SELECT sae.*, e.first_name || ' ' || e.last_name actor_name FROM security_audit_events sae LEFT JOIN employees e ON e.id=sae.actor_employee_id ORDER BY sae.id DESC LIMIT 100`, args: [] });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
router.get('/:id', requirePermission('security'), async (req, res) => {
  try {
    const group = await getGroup(req.params.id);
    if (!group) return res.status(404).json({ error: 'Not found' });
    const { rows: members } = await db.execute({ sql: 'SELECT id, employee_number, first_name, last_name, username, role FROM employees WHERE security_group_id = ? AND active = 1', args: [req.params.id] });
    group.members = members;
    res.json(group);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/', requirePermission('security_manage'), async (req, res) => {
  const { name, description, reason } = req.body;
  const permissions = normalizedPermissions(req.body.permissions);
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name required' });
  if (!reason || String(reason).trim().length < 5) return res.status(400).json({ error: 'A reason is required for security changes' });
  try {
    const group = await writeTransaction(async tx => {
      await currentActorPermissions(tx, req, 'security_manage');
      const result = await tx.execute({ sql: 'INSERT INTO security_groups (name, description, permissions) VALUES (?,?,?)', args: [String(name).trim(), description || null, JSON.stringify(permissions)] });
      const id = Number(result.lastInsertRowid);
      const created = await getGroup(id, tx);
      await auditInTransaction(tx, req, 'security_group_created', 'security_group', id, null, created, reason);
      return created;
    });
    res.status(201).json(group);
  } catch(e) { sendError(res, e, 400); }
});

router.put('/:id', requirePermission('security_manage'), async (req, res) => {
  const { name, description, reason } = req.body;
  const permissions = normalizedPermissions(req.body.permissions);
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name required' });
  if (!reason || String(reason).trim().length < 5) return res.status(400).json({ error: 'A reason is required for security changes' });
  try {
    const group = await writeTransaction(async tx => {
      const actor = await currentActorPermissions(tx, req, 'security_manage');
      const oldGroup = await getGroup(req.params.id, tx);
      if (!oldGroup) throw httpError(404, 'Security group not found');
      if (Number(actor.security_group_id) === Number(req.params.id) && !can(permissions, 'security_manage')) {
        throw httpError(400, 'You cannot remove your own Security Management permission. Have another security administrator make this change.');
      }
      const adminCount = await activeSecurityAdminCount(tx, { groupOverride: { id: req.params.id, permissions } });
      if (adminCount < 1) throw httpError(400, 'This change would leave the system with no active security administrator.');
      await tx.execute({ sql: 'UPDATE security_groups SET name=?,description=?,permissions=? WHERE id=?', args: [String(name).trim(), description || null, JSON.stringify(permissions), req.params.id] });
      const updated = await getGroup(req.params.id, tx);
      await auditInTransaction(tx, req, 'security_group_updated', 'security_group', req.params.id, oldGroup, updated, reason);
      return updated;
    });
    res.json(group);
  } catch(e) { sendError(res, e, 400); }
});

router.delete('/:id', requirePermission('security_manage'), async (req, res) => {
  const reason = req.body?.reason || req.query?.reason;
  if (!reason || String(reason).trim().length < 5) return res.status(400).json({ error: 'A reason is required for security changes' });
  try {
    await writeTransaction(async tx => {
      const actor = await currentActorPermissions(tx, req, 'security_manage');
      const group = await getGroup(req.params.id, tx);
      if (!group) throw httpError(404, 'Security group not found');
      const { rows: [count] } = await tx.execute({ sql: 'SELECT COUNT(*) as c FROM employees WHERE security_group_id = ? AND active = 1', args: [req.params.id] });
      if (Number(count.c) > 0) throw httpError(400, 'Cannot delete group with assigned employees. Reassign them first.');
      if (Number(actor.security_group_id) === Number(req.params.id)) throw httpError(400, 'You cannot delete your own security group.');
      await tx.execute({ sql: 'DELETE FROM security_groups WHERE id = ?', args: [req.params.id] });
      await auditInTransaction(tx, req, 'security_group_deleted', 'security_group', req.params.id, group, null, reason);
    });
    res.json({ success: true });
  } catch(e) { sendError(res, e, 400); }
});

router.post('/:id/assign', requirePermission('security_assign'), async (req, res) => {
  const { employee_id, reason } = req.body;
  if (!employee_id) return res.status(400).json({ error: 'employee_id required' });
  if (!reason || String(reason).trim().length < 5) return res.status(400).json({ error: 'A reason is required for security changes' });
  try {
    await writeTransaction(async tx => {
      const actor = await currentActorPermissions(tx, req, 'security_assign');
      const targetGroup = await getGroup(req.params.id, tx);
      if (!targetGroup) throw httpError(404, 'Security group not found');
      if (!canManageGroupMembership(actor.permissions, targetGroup.permissions)) {
        throw httpError(403, 'You cannot assign a security group containing authority you do not hold');
      }
      const { rows: [employee] } = await tx.execute({ sql: 'SELECT id,security_group_id,active FROM employees WHERE id=?', args: [employee_id] });
      if (!employee) throw httpError(404, 'Employee not found');
      const oldGroup = employee.security_group_id ? await getGroup(employee.security_group_id, tx) : null;
      if (oldGroup && !canManageGroupMembership(actor.permissions, oldGroup.permissions)) {
        throw httpError(403, 'You cannot change membership for an employee whose current security authority exceeds your own');
      }
      if (Number(employee.id) === Number(actor.id) && !can(targetGroup.permissions, 'security_manage')) {
        throw httpError(400, 'You cannot reassign yourself to a group that removes your Security Management permission.');
      }
      if (employee.active && oldGroup && can(oldGroup.permissions, 'security_manage') && !can(targetGroup.permissions, 'security_manage')) {
        const remaining = await activeSecurityAdminCount(tx, { excludeEmployeeId: employee.id });
        if (remaining < 1) throw httpError(400, 'This reassignment would leave the system with no active security administrator.');
      }
      const result = await tx.execute({ sql: 'UPDATE employees SET security_group_id = ? WHERE id = ? AND security_group_id IS ?', args: [req.params.id, employee_id, employee.security_group_id] });
      if (Number(result.rowsAffected || 0) !== 1) throw httpError(409, 'Employee security membership changed concurrently; reload and retry.');
      await auditInTransaction(tx, req, 'employee_security_group_assigned', 'employee', employee_id, { security_group_id: employee.security_group_id }, { security_group_id: Number(req.params.id) }, reason);
    });
    res.json({ success: true });
  } catch(e) { sendError(res, e); }
});

router.delete('/:id/assign/:empId', requirePermission('security_assign'), async (req, res) => {
  const reason = req.body?.reason || req.query?.reason;
  if (!reason || String(reason).trim().length < 5) return res.status(400).json({ error: 'A reason is required for security changes' });
  try {
    await writeTransaction(async tx => {
      const actor = await currentActorPermissions(tx, req, 'security_assign');
      if (Number(req.params.empId) === Number(actor.id)) throw httpError(400, 'You cannot remove yourself from your own security group.');
      const group = await getGroup(req.params.id, tx);
      if (!group) throw httpError(404, 'Security group not found');
      if (!canManageGroupMembership(actor.permissions, group.permissions)) {
        throw httpError(403, 'You cannot remove membership from a security group containing authority you do not hold');
      }
      const { rows: [employee] } = await tx.execute({ sql: 'SELECT id,active,security_group_id FROM employees WHERE id=? AND security_group_id=?', args: [req.params.empId, req.params.id] });
      if (!employee) throw httpError(404, 'Employee is not assigned to this security group');
      if (employee.active && can(group.permissions, 'security_manage')) {
        const remaining = await activeSecurityAdminCount(tx, { excludeEmployeeId: employee.id });
        if (remaining < 1) throw httpError(400, 'This removal would leave the system with no active security administrator.');
      }
      const result = await tx.execute({ sql: 'UPDATE employees SET security_group_id = NULL WHERE id = ? AND security_group_id = ?', args: [req.params.empId, req.params.id] });
      if (Number(result.rowsAffected || 0) !== 1) throw httpError(409, 'Employee security membership changed concurrently; reload and retry.');
      await auditInTransaction(tx, req, 'employee_security_group_removed', 'employee', req.params.empId, { security_group_id: Number(req.params.id) }, { security_group_id: null }, reason);
    });
    res.json({ success: true });
  } catch(e) { sendError(res, e); }
});

module.exports = router;
module.exports.canManageGroupMembership = canManageGroupMembership;
