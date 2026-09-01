const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { PERMISSION_TREE, can, requireAuth, requirePermission } = require('../lib/permissions');

async function ensureAuditTable() {
  await db.execute({ sql: `CREATE TABLE IF NOT EXISTS security_audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_employee_id INTEGER,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id INTEGER,
    old_value TEXT,
    new_value TEXT,
    reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`, args: [] });
}
async function audit(req, action, targetType, targetId, oldValue, newValue, reason) {
  await ensureAuditTable();
  await db.execute({ sql: `INSERT INTO security_audit_events (actor_employee_id,action,target_type,target_id,old_value,new_value,reason) VALUES (?,?,?,?,?,?,?)`, args: [req.employee?.id || null, action, targetType, targetId || null, oldValue == null ? null : JSON.stringify(oldValue), newValue == null ? null : JSON.stringify(newValue), reason || null] });
}
function normalizedPermissions(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const allowed = new Set();
  for (const mod of PERMISSION_TREE) { allowed.add(mod.key); for (const sub of mod.subs) allowed.add(sub.key); }
  const out = {};
  for (const key of allowed) if (Object.prototype.hasOwnProperty.call(input, key)) out[key] = input[key] === true;
  return out;
}
function canManageGroupMembership(actorPermissions, groupPermissions) {
  if (can(actorPermissions, 'security_manage')) return true;
  const target = groupPermissions && typeof groupPermissions === 'object' && !Array.isArray(groupPermissions) ? groupPermissions : {};
  for (const [permission, enabled] of Object.entries(target)) {
    if (enabled === true && !can(actorPermissions, permission)) return false;
  }
  return true;
}
async function activeSecurityAdminCount(groupOverride) {
  const { rows } = await db.execute({ sql: `SELECT e.id,e.security_group_id,sg.permissions FROM employees e LEFT JOIN security_groups sg ON sg.id=e.security_group_id WHERE e.active=1`, args: [] });
  let count = 0;
  for (const employee of rows) {
    let permissions = {};
    if (groupOverride && Number(employee.security_group_id) === Number(groupOverride.id)) permissions = groupOverride.permissions;
    else { try { permissions = JSON.parse(employee.permissions || '{}'); } catch (_) {} }
    if (can(permissions, 'security_manage')) count += 1;
  }
  return count;
}
async function getGroup(id) {
  const { rows: [group] } = await db.execute({ sql: 'SELECT * FROM security_groups WHERE id = ?', args: [id] });
  if (!group) return null;
  try { group.permissions = JSON.parse(group.permissions || '{}'); } catch (_) { group.permissions = {}; }
  return group;
}

// Lookup list used by employee forms. The permission payload is intentionally
// stripped unless the caller is allowed to inspect security configuration.
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows: groups } = await db.execute({ sql: 'SELECT * FROM security_groups ORDER BY name', args: [] });
    for (const g of groups) {
      const { rows: [countRow] } = await db.execute({ sql: 'SELECT COUNT(*) as c FROM employees WHERE security_group_id = ? AND active = 1', args: [g.id] });
      g.member_count = Number(countRow.c);
      if (req.apiKey || can(req.employee?.permissions, 'security')) { try { g.permissions = JSON.parse(g.permissions || '{}'); } catch (_) { g.permissions = {}; } }
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
    await ensureAuditTable();
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
    const result = await db.execute({ sql: 'INSERT INTO security_groups (name, description, permissions) VALUES (?,?,?)', args: [String(name).trim(), description||null, JSON.stringify(permissions)] });
    const id = Number(result.lastInsertRowid);
    const group = await getGroup(id);
    await audit(req, 'security_group_created', 'security_group', id, null, group, reason);
    res.status(201).json(group);
  } catch(e) { res.status(400).json({ error: e.message }); }
});

router.put('/:id', requirePermission('security_manage'), async (req, res) => {
  const { name, description, reason } = req.body;
  const permissions = normalizedPermissions(req.body.permissions);
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name required' });
  if (!reason || String(reason).trim().length < 5) return res.status(400).json({ error: 'A reason is required for security changes' });
  try {
    const oldGroup = await getGroup(req.params.id);
    if (!oldGroup) return res.status(404).json({ error: 'Security group not found' });
    if (Number(req.employee?.security_group_id) === Number(req.params.id) && !can(permissions, 'security_manage')) {
      return res.status(400).json({ error: 'You cannot remove your own Security Management permission. Have another security administrator make this change.' });
    }
    const adminCount = await activeSecurityAdminCount({ id:req.params.id, permissions });
    if (adminCount < 1) return res.status(400).json({ error: 'This change would leave the system with no active security administrator.' });
    await db.execute({ sql: 'UPDATE security_groups SET name=?,description=?,permissions=? WHERE id=?', args: [String(name).trim(), description||null, JSON.stringify(permissions), req.params.id] });
    const group = await getGroup(req.params.id);
    await audit(req, 'security_group_updated', 'security_group', req.params.id, oldGroup, group, reason);
    res.json(group);
  } catch(e) { res.status(400).json({ error: e.message }); }
});

router.delete('/:id', requirePermission('security_manage'), async (req, res) => {
  const reason = req.body?.reason || req.query?.reason;
  if (!reason || String(reason).trim().length < 5) return res.status(400).json({ error: 'A reason is required for security changes' });
  try {
    const group = await getGroup(req.params.id);
    if (!group) return res.status(404).json({ error: 'Security group not found' });
    const { rows: [count] } = await db.execute({ sql: 'SELECT COUNT(*) as c FROM employees WHERE security_group_id = ? AND active = 1', args: [req.params.id] });
    if (Number(count.c) > 0) return res.status(400).json({ error: 'Cannot delete group with assigned employees. Reassign them first.' });
    if (Number(req.employee?.security_group_id) === Number(req.params.id)) return res.status(400).json({ error: 'You cannot delete your own security group.' });
    await db.execute({ sql: 'DELETE FROM security_groups WHERE id = ?', args: [req.params.id] });
    await audit(req, 'security_group_deleted', 'security_group', req.params.id, group, null, reason);
    res.json({ success: true });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

router.post('/:id/assign', requirePermission('security_assign'), async (req, res) => {
  const { employee_id, reason } = req.body;
  if (!employee_id) return res.status(400).json({ error: 'employee_id required' });
  if (!reason || String(reason).trim().length < 5) return res.status(400).json({ error: 'A reason is required for security changes' });
  try {
    const targetGroup = await getGroup(req.params.id);
    if (!targetGroup) return res.status(404).json({ error: 'Security group not found' });
    if (!canManageGroupMembership(req.employee?.permissions, targetGroup.permissions)) {
      return res.status(403).json({ error: 'You cannot assign a security group containing authority you do not hold' });
    }
    const { rows: [employee] } = await db.execute({ sql: 'SELECT id,security_group_id,active FROM employees WHERE id=?', args:[employee_id] });
    if (!employee) return res.status(404).json({ error:'Employee not found' });
    const oldGroup = employee.security_group_id ? await getGroup(employee.security_group_id) : null;
    if (oldGroup && !canManageGroupMembership(req.employee?.permissions, oldGroup.permissions)) {
      return res.status(403).json({ error: 'You cannot change membership for an employee whose current security authority exceeds your own' });
    }
    if (Number(employee.id) === Number(req.employee?.id) && !can(targetGroup.permissions, 'security_manage')) return res.status(400).json({ error:'You cannot reassign yourself to a group that removes your Security Management permission.' });
    if (employee.active && oldGroup && can(oldGroup.permissions,'security_manage') && !can(targetGroup.permissions,'security_manage')) {
      const remaining = await activeSecurityAdminCount({ id:employee.security_group_id, permissions:{} });
      if (remaining < 1) return res.status(400).json({ error:'This reassignment would leave the system with no active security administrator.' });
    }
    await db.execute({ sql: 'UPDATE employees SET security_group_id = ? WHERE id = ?', args: [req.params.id, employee_id] });
    await audit(req, 'employee_security_group_assigned', 'employee', employee_id, {security_group_id:employee.security_group_id}, {security_group_id:Number(req.params.id)}, reason);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id/assign/:empId', requirePermission('security_assign'), async (req, res) => {
  const reason = req.body?.reason || req.query?.reason;
  if (!reason || String(reason).trim().length < 5) return res.status(400).json({ error: 'A reason is required for security changes' });
  try {
    if (Number(req.params.empId) === Number(req.employee?.id)) return res.status(400).json({ error:'You cannot remove yourself from your own security group.' });
    const group = await getGroup(req.params.id);
    if (!group) return res.status(404).json({error:'Security group not found'});
    if (!canManageGroupMembership(req.employee?.permissions, group.permissions)) {
      return res.status(403).json({ error: 'You cannot remove membership from a security group containing authority you do not hold' });
    }
    if (can(group.permissions,'security_manage')) {
      const { rows:[employee] } = await db.execute({sql:'SELECT active FROM employees WHERE id=? AND security_group_id=?',args:[req.params.empId,req.params.id]});
      if (employee?.active) {
        const remaining = await activeSecurityAdminCount({ id:req.params.id, permissions:{} });
        if (remaining < 1) return res.status(400).json({ error:'This removal would leave the system with no active security administrator.' });
      }
    }
    await db.execute({ sql: 'UPDATE employees SET security_group_id = NULL WHERE id = ? AND security_group_id = ?', args: [req.params.empId, req.params.id] });
    await audit(req, 'employee_security_group_removed', 'employee', req.params.empId, {security_group_id:Number(req.params.id)}, {security_group_id:null}, reason);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.canManageGroupMembership = canManageGroupMembership;
