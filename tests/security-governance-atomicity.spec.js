import { test, expect } from '@playwright/test';
import { createClient } from '@libsql/client';

const BASE = 'http://localhost:3001';
const db = createClient({ url: 'file:pos.db' });
const FAULT_TRIGGER = 'trg_security_audit_atomicity_fault';

async function login(username = process.env.POS_TEST_USER || 'admin', password = process.env.POS_TEST_PASSWORD || '123456') {
  const r = await fetch(`${BASE}/api/employees/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  expect(r.status).toBe(200);
  return { cookie: (r.headers.get('set-cookie') || '').split(';')[0], body: await r.json() };
}

async function api(cookie, path, options = {}) {
  const headers = { Cookie: cookie, Accept: 'application/json', ...(options.headers || {}) };
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${BASE}${path}`, { ...options, headers });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function installAuditFault(action, reason) {
  await db.execute({ sql: `DROP TRIGGER IF EXISTS ${FAULT_TRIGGER}`, args: [] });
  await db.execute({
    sql: `CREATE TRIGGER ${FAULT_TRIGGER}
          BEFORE INSERT ON security_audit_events
          WHEN NEW.action = ? AND NEW.reason = ?
          BEGIN
            SELECT RAISE(ABORT, 'forced security audit failure');
          END`,
    args: [action, reason],
  });
}

async function clearAuditFault() {
  await db.execute({ sql: `DROP TRIGGER IF EXISTS ${FAULT_TRIGGER}`, args: [] }).catch(() => {});
}

test.describe('Security governance atomicity', () => {
  test.afterEach(async () => { await clearAuditFault(); });

  test('security group creation rolls back when audit evidence cannot be written', async () => {
    const admin = await login();
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const name = `Atomic Rollback ${suffix}`;
    const reason = `Atomic audit fault ${suffix}`;

    // Initialize the canonical audit schema before fault injection.
    const audit = await api(admin.cookie, '/api/security-groups/audit/recent');
    expect(audit.status).toBe(200);
    await installAuditFault('security_group_created', reason);

    const attempted = await api(admin.cookie, '/api/security-groups', {
      method: 'POST',
      body: JSON.stringify({
        name,
        description: 'Must never persist without its audit event',
        reason,
        permissions: { pos: true },
      }),
    });
    expect(attempted.status).toBeGreaterThanOrEqual(400);

    const { rows } = await db.execute({ sql: 'SELECT id FROM security_groups WHERE name=?', args: [name] });
    expect(rows).toHaveLength(0);
  });

  test('security membership assignment rolls back when audit evidence cannot be written', async () => {
    const admin = await login();
    const branches = await api(admin.cookie, '/api/branches');
    expect(branches.status).toBe(200);
    const branch = branches.body.find(b => b.active !== 0) || branches.body[0];
    expect(branch).toBeTruthy();

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sourceGroup = await api(admin.cookie, '/api/security-groups', {
      method: 'POST',
      body: JSON.stringify({
        name: `Atomic Source ${suffix}`,
        reason: 'Atomic security fixture creation',
        permissions: { pos: true },
      }),
    });
    expect(sourceGroup.status).toBe(201);
    const targetGroup = await api(admin.cookie, '/api/security-groups', {
      method: 'POST',
      body: JSON.stringify({
        name: `Atomic Target ${suffix}`,
        reason: 'Atomic security fixture creation',
        permissions: { pos: true },
      }),
    });
    expect(targetGroup.status).toBe(201);

    const username = `atomic_${suffix.replace(/[^a-z0-9]/gi, '').slice(-14)}`;
    const password = `Atomic!${suffix}Aa9`;
    const pin = `7${String(Date.now()).slice(-5)}`;
    let employee = null;
    try {
      const created = await api(admin.cookie, '/api/employees', {
        method: 'POST',
        body: JSON.stringify({
          first_name: 'Atomic', last_name: 'Evidence', username, password, pin,
          security_group_id: sourceGroup.body.id,
          default_branch_id: branch.id,
          must_change_password: false,
        }),
      });
      expect(created.status).toBe(201);
      employee = created.body;

      const reason = `Atomic assignment fault ${suffix}`;
      await installAuditFault('employee_security_group_assigned', reason);
      const attempted = await api(admin.cookie, `/api/security-groups/${targetGroup.body.id}/assign`, {
        method: 'POST',
        body: JSON.stringify({ employee_id: employee.id, reason }),
      });
      expect(attempted.status).toBeGreaterThanOrEqual(400);

      const { rows: [stored] } = await db.execute({ sql: 'SELECT security_group_id FROM employees WHERE id=?', args: [employee.id] });
      expect(Number(stored.security_group_id)).toBe(Number(sourceGroup.body.id));
    } finally {
      await clearAuditFault();
      if (employee?.id) {
        await api(admin.cookie, `/api/employees/${employee.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            first_name: employee.first_name,
            last_name: employee.last_name,
            username,
            active: 0,
            security_group_id: sourceGroup.body.id,
            default_branch_id: employee.default_branch_id,
            must_change_password: false,
          }),
        });
      }
      await api(admin.cookie, `/api/security-groups/${targetGroup.body.id}?reason=Atomic%20security%20fixture%20cleanup`, { method: 'DELETE' });
      await api(admin.cookie, `/api/security-groups/${sourceGroup.body.id}?reason=Atomic%20security%20fixture%20cleanup`, { method: 'DELETE' });
    }
  });
});
