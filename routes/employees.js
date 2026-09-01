const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { db } = require('../database');
const { createSession, destroySession, destroyEmployeeSessions, setSessionCookie, clearSessionCookie, readCookie } = require('../lib/sessionAuth');
const { requireAuth, requirePermission, can } = require('../lib/permissions');
const { nextNumber } = require('../lib/nextNumber');
const { loginRateLimit, privilegedPinRateLimit, resetRequestRateLimit } = require('../lib/securityHardening');

function isBcryptHash(value) {
  return typeof value === 'string' && value.startsWith('$2');
}
function parsePermissions(value) {
  try { return value && typeof value === 'object' ? value : JSON.parse(value || '{}'); }
  catch (_) { return {}; }
}
async function loadSecurityGroup(id) {
  if (!id) return null;
  const { rows: [group] } = await db.execute({ sql: 'SELECT id,name,permissions FROM security_groups WHERE id=?', args: [id] });
  if (!group) return null;
  group.permissions = parsePermissions(group.permissions);
  return group;
}
async function assertAssignableSecurityGroup(req, groupId) {
  if (!groupId) return { ok: true, group: null };
  const group = await loadSecurityGroup(groupId);
  if (!group) return { ok: false, status: 400, error: 'Selected security group does not exist' };
  if (can(req.employee?.permissions, 'security_manage')) return { ok: true, group };
  for (const [permission, enabled] of Object.entries(group.permissions)) {
    if (enabled === true && !can(req.employee?.permissions, permission)) {
      return { ok: false, status: 403, error: 'You cannot assign a security group with authority you do not hold' };
    }
  }
  return { ok: true, group };
}
async function employeeSecurityContext(id) {
  const { rows: [row] } = await db.execute({ sql: `SELECT e.id,e.password,e.pin,e.active,e.security_group_id,sg.permissions FROM employees e LEFT JOIN security_groups sg ON sg.id=e.security_group_id WHERE e.id=?`, args: [id] });
  if (!row) return null;
  row.permissions = parsePermissions(row.permissions);
  return row;
}
async function activeSecurityAdminCount(excludeEmployeeId) {
  const { rows } = await db.execute({ sql: `SELECT e.id,sg.permissions FROM employees e LEFT JOIN security_groups sg ON sg.id=e.security_group_id WHERE e.active=1 AND e.id != ?`, args: [excludeEmployeeId || -1] });
  return rows.reduce((count, row) => count + (can(parsePermissions(row.permissions), 'security_manage') ? 1 : 0), 0);
}

router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows: employees } = await db.execute({ sql: `SELECT e.id, e.employee_number, e.first_name, e.last_name, e.username, e.role, e.active, e.created_at, e.security_group_id, e.default_branch_id, e.must_change_password, e.is_driver, e.is_operator, e.is_security, sg.name as security_group_name, b.name as default_branch_name
      FROM employees e
      LEFT JOIN security_groups sg ON e.security_group_id = sg.id
      LEFT JOIN branches b ON e.default_branch_id = b.id
      ORDER BY e.first_name`, args: [] });
    if (employees.length) {
      const placeholders = employees.map(() => '?').join(',');
      const { rows: allBranches } = await db.execute({
        sql: `SELECT eb.employee_id, b.id, b.branch_code, b.name, eb.is_default FROM branches b JOIN employee_branches eb ON b.id = eb.branch_id WHERE eb.employee_id IN (${placeholders})`,
        args: employees.map(e => e.id),
      });
      const byEmployee = {};
      for (const row of allBranches) { (byEmployee[row.employee_id] = byEmployee[row.employee_id] || []).push(row); }
      for (const emp of employees) emp.branches = byEmployee[emp.id] || [];

      const { rows: allSkills } = await db.execute({
        sql: `SELECT es.employee_id, ts.id, ts.name FROM technician_skills ts JOIN employee_skills es ON ts.id = es.skill_id WHERE es.employee_id IN (${placeholders})`,
        args: employees.map(e => e.id),
      });
      const skillsByEmployee = {};
      for (const row of allSkills) { (skillsByEmployee[row.employee_id] = skillsByEmployee[row.employee_id] || []).push(row); }
      for (const emp of employees) emp.skills = skillsByEmployee[emp.id] || [];
    }
    res.json(employees);
  } catch(e) { res.status(500).json({ error: 'Unable to load employees' }); }
});

router.post('/', requirePermission('employees'), async (req, res) => {
  const { first_name, last_name, username, pin, password, must_change_password, security_group_id, default_branch_id, is_driver, is_operator, is_security, skill_ids } = req.body;
  if (!first_name || !last_name || !username || !pin) return res.status(400).json({ error: 'Required fields missing' });
  if (password && String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  try {
    const assignment = await assertAssignableSecurityGroup(req, security_group_id);
    if (!assignment.ok) return res.status(assignment.status).json({ error: assignment.error });
    const employee_number = await nextNumber(db, 'employees', 'employee_number', 'EMP-', 4);
    const passwordHash = password ? await bcrypt.hash(password, 10) : null;
    const result = await db.execute({ sql: 'INSERT INTO employees (employee_number,first_name,last_name,username,pin,password,must_change_password,security_group_id,default_branch_id,is_driver,is_operator,is_security) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', args: [employee_number, first_name, last_name, username, pin, passwordHash, must_change_password ? 1 : 0, security_group_id || null, default_branch_id || null, is_driver ? 1 : 0, is_operator ? 1 : 0, is_security ? 1 : 0] });
    const newId = Number(result.lastInsertRowid);
    if (default_branch_id) {
      await db.execute({ sql: 'INSERT OR IGNORE INTO employee_branches (employee_id, branch_id, is_default) VALUES (?,?,1)', args: [newId, default_branch_id] });
    }
    if (Array.isArray(skill_ids)) {
      for (const skillId of skill_ids) await db.execute({ sql: 'INSERT OR IGNORE INTO employee_skills (employee_id, skill_id) VALUES (?,?)', args: [newId, skillId] });
    }
    const { rows: [emp] } = await db.execute({ sql: `SELECT e.id,e.employee_number,e.first_name,e.last_name,e.username,e.role,e.active,e.security_group_id,e.default_branch_id,e.is_driver,e.is_operator,e.is_security,sg.name as security_group_name,b.name as default_branch_name FROM employees e LEFT JOIN security_groups sg ON e.security_group_id=sg.id LEFT JOIN branches b ON e.default_branch_id=b.id WHERE e.id=?`, args: [newId] });
    res.status(201).json(emp);
  } catch (e) {
    res.status(400).json({ error: 'Unable to create employee' });
  }
});

router.put('/:id/change-password', requireAuth, async (req, res) => {
  const { password } = req.body;
  if (!password || String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const targetId = Number(req.params.id);
  const self = Number(req.employee?.id) === targetId;
  if (!self && !can(req.employee?.permissions, 'security_manage')) {
    return res.status(403).json({ error: 'Changing another employee password requires Security Management authority' });
  }
  try {
    const { rows: [target] } = await db.execute({ sql: 'SELECT id FROM employees WHERE id = ?', args: [targetId] });
    if (!target) return res.status(404).json({ error: 'Employee not found' });
    const hash = await bcrypt.hash(password, 10);
    await db.execute({ sql: 'UPDATE employees SET password=?,must_change_password=0 WHERE id=?', args: [hash, targetId] });
    await destroyEmployeeSessions(targetId);
    if (self) clearSessionCookie(res);
    res.json({ success: true, reauthentication_required: self });
  } catch (e) {
    res.status(400).json({ error: 'Unable to change password' });
  }
});

router.put('/:id', requirePermission('employees'), async (req, res) => {
  const { first_name, last_name, username, pin, password, must_change_password, active, security_group_id, default_branch_id, is_driver, is_operator, is_security, skill_ids } = req.body;
  const targetId = Number(req.params.id);
  try {
    const existing = await employeeSecurityContext(targetId);
    if (!existing) return res.status(404).json({ error: 'Employee not found' });

    const assignment = await assertAssignableSecurityGroup(req, security_group_id);
    if (!assignment.ok) return res.status(assignment.status).json({ error: assignment.error });

    const groupChanged = Number(security_group_id || 0) !== Number(existing.security_group_id || 0);
    const passwordChanged = Boolean(password);
    const pinChanged = Boolean(pin) && String(pin) !== String(existing.pin || '');
    const crossUserCredentialChange = targetId !== Number(req.employee?.id) && (passwordChanged || pinChanged);
    if (crossUserCredentialChange && !can(req.employee?.permissions, 'security_manage')) {
      return res.status(403).json({ error: 'Changing another employee credentials requires Security Management authority' });
    }

    if (can(existing.permissions, 'security_manage')) {
      if ((active === 0 || active === false) && !can(req.employee?.permissions, 'security_manage')) {
        return res.status(403).json({ error: 'Deactivating a security administrator requires Security Management authority' });
      }
      const newGroupPermissions = assignment.group?.permissions || {};
      const wouldLoseSecurity = groupChanged && !can(newGroupPermissions, 'security_manage');
      const wouldDeactivate = active === 0 || active === false;
      if ((wouldLoseSecurity || wouldDeactivate) && await activeSecurityAdminCount(targetId) < 1) {
        return res.status(400).json({ error: 'This change would leave the system with no active security administrator' });
      }
    }

    let passwordToStore = existing.password;
    let credentialChanged = false;
    if (password) {
      if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
      passwordToStore = await bcrypt.hash(password, 10);
      credentialChanged = true;
    }
    if (pinChanged) credentialChanged = true;

    if (pin) {
      await db.execute({ sql: 'UPDATE employees SET first_name=?,last_name=?,username=?,pin=?,password=?,must_change_password=?,active=?,security_group_id=?,default_branch_id=?,is_driver=?,is_operator=?,is_security=? WHERE id=?', args: [first_name, last_name, username, pin, passwordToStore, must_change_password?1:0, active??1, security_group_id||null, default_branch_id||null, is_driver?1:0, is_operator?1:0, is_security?1:0, targetId] });
    } else {
      await db.execute({ sql: 'UPDATE employees SET first_name=?,last_name=?,username=?,password=?,must_change_password=?,active=?,security_group_id=?,default_branch_id=?,is_driver=?,is_operator=?,is_security=? WHERE id=?', args: [first_name, last_name, username, passwordToStore, must_change_password?1:0, active??1, security_group_id||null, default_branch_id||null, is_driver?1:0, is_operator?1:0, is_security?1:0, targetId] });
    }
    if (credentialChanged || groupChanged || active === false || active === 0) await destroyEmployeeSessions(targetId);
    if (default_branch_id) {
      await db.execute({ sql: 'INSERT OR IGNORE INTO employee_branches (employee_id, branch_id, is_default) VALUES (?,?,1)', args: [targetId, default_branch_id] });
      await db.execute({ sql: 'UPDATE employee_branches SET is_default = CASE WHEN branch_id = ? THEN 1 ELSE 0 END WHERE employee_id = ?', args: [default_branch_id, targetId] });
    }
    if (Array.isArray(skill_ids)) {
      await db.execute({ sql: 'DELETE FROM employee_skills WHERE employee_id = ?', args: [targetId] });
      for (const skillId of skill_ids) await db.execute({ sql: 'INSERT OR IGNORE INTO employee_skills (employee_id, skill_id) VALUES (?,?)', args: [targetId, skillId] });
    }
    const { rows: [emp] } = await db.execute({ sql: `SELECT e.id,e.employee_number,e.first_name,e.last_name,e.username,e.role,e.active,e.security_group_id,e.default_branch_id,e.is_driver,e.is_operator,e.is_security,sg.name as security_group_name,b.name as default_branch_name FROM employees e LEFT JOIN security_groups sg ON e.security_group_id=sg.id LEFT JOIN branches b ON e.default_branch_id=b.id WHERE e.id=?`, args: [targetId] });
    res.json(emp);
  } catch (e) {
    res.status(400).json({ error: 'Unable to update employee' });
  }
});

router.post('/validate-pin', requireAuth, privilegedPinRateLimit, async (req, res) => {
  try {
    const { pin, permission } = req.body;
    if (!pin) return res.status(400).json({ error: 'PIN is required' });
    const { rows: employees } = await db.execute({ sql: 'SELECT e.id, e.first_name, e.last_name, e.pin, sg.permissions FROM employees e LEFT JOIN security_groups sg ON e.security_group_id = sg.id WHERE e.active = 1', args: [] });
    const authorizer = employees.find(e => {
      if (e.pin !== String(pin)) return false;
      if (!permission) return true;
      try { const p = JSON.parse(e.permissions || '{}'); return p[permission] === true; } catch { return false; }
    });
    if (!authorizer) return res.status(403).json({ error: 'Invalid PIN or insufficient privilege' });
    resetRequestRateLimit(req);
    res.json({ authorized: true, name: `${authorizer.first_name} ${authorizer.last_name}` });
  } catch(e) { res.status(500).json({ error: 'Authorization check failed' }); }
});

router.post('/login', loginRateLimit, async (req, res) => {
  try {
    const { username, pin, password } = req.body;
    if (!username || (!pin && !password)) return res.status(400).json({ error: 'Username and credential are required' });
    let emp = null;
    if (password) {
      const { rows: [row] } = await db.execute({ sql: `SELECT e.id, e.first_name, e.last_name, e.username, e.password, e.role, e.must_change_password, e.security_group_id, e.default_branch_id, e.is_driver, e.is_operator, e.is_security, sg.name as security_group_name, sg.permissions, b.name as default_branch_name FROM employees e LEFT JOIN security_groups sg ON e.security_group_id = sg.id LEFT JOIN branches b ON e.default_branch_id = b.id WHERE e.username=? AND e.active=1`, args: [username] });
      if (row) {
        const stored = row.password;
        let ok = false;
        if (isBcryptHash(stored)) {
          ok = await bcrypt.compare(password, stored);
        } else {
          ok = stored != null && password === stored;
          if (ok) {
            const newHash = await bcrypt.hash(password, 10);
            await db.execute({ sql: 'UPDATE employees SET password = ? WHERE id = ?', args: [newHash, row.id] });
          }
        }
        if (ok) { delete row.password; emp = row; }
      }
    } else if (pin) {
      const { rows: [row] } = await db.execute({ sql: `SELECT e.id, e.first_name, e.last_name, e.username, e.role, e.must_change_password, e.security_group_id, e.default_branch_id, e.is_driver, e.is_operator, e.is_security, sg.name as security_group_name, sg.permissions, b.name as default_branch_name FROM employees e LEFT JOIN security_groups sg ON e.security_group_id = sg.id LEFT JOIN branches b ON e.default_branch_id = b.id WHERE e.username=? AND e.pin=? AND e.active=1`, args: [username, pin] });
      emp = row || null;
    }
    if (!emp) return res.status(401).json({ error: 'Invalid credentials' });
    resetRequestRateLimit(req);
    if (emp.permissions) emp.permissions = JSON.parse(emp.permissions);
    if (emp.permissions && emp.permissions.multi_branch_access) {
      const { rows: branches } = await db.execute({ sql: `SELECT b.id, b.branch_code, b.name, b.currency, CASE WHEN b.id = ? THEN 1 ELSE 0 END as is_default FROM branches b WHERE b.active = 1 ORDER BY b.name`, args: [emp.default_branch_id || null] });
      emp.branches = branches;
    } else {
      emp.branches = emp.default_branch_id
        ? (await db.execute({ sql: `SELECT b.id, b.branch_code, b.name, b.currency, 1 as is_default FROM branches b WHERE b.id = ?`, args: [emp.default_branch_id] })).rows
        : [];
    }
    const token = await createSession(emp.id);
    setSessionCookie(req, res, token);
    res.json(emp);
  } catch(e) { res.status(500).json({ error: 'Login failed' }); }
});

router.post('/logout', requireAuth, async (req, res) => {
  try {
    await destroySession(readCookie(req));
    clearSessionCookie(res);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Logout failed' }); }
});

module.exports = router;