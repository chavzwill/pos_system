import { test, expect } from '@playwright/test';
import { createClient } from '@libsql/client';

const BASE = 'http://localhost:3001';
const db = createClient({ url: 'file:pos.db' });

async function loginPassword(username = process.env.POS_TEST_USER || 'admin', password = process.env.POS_TEST_PASSWORD || '123456') {
  const r = await fetch(`${BASE}/api/employees/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  expect(r.status).toBe(200);
  return { cookie: (r.headers.get('set-cookie') || '').split(';')[0], body: await r.json() };
}

async function loginPin(username, pin) {
  const r = await fetch(`${BASE}/api/employees/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, pin }),
  });
  return { status: r.status, cookie: (r.headers.get('set-cookie') || '').split(';')[0], body: await r.json().catch(() => null) };
}

async function api(cookie, path, options = {}) {
  const headers = { Cookie: cookie, Accept: 'application/json', ...(options.headers || {}) };
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${BASE}${path}`, { ...options, headers });
  return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
}

test.describe('PIN storage hardening', () => {
  test('CI bootstrap administrator PIN is hashed at rest', async () => {
    const username = process.env.POS_TEST_USER || 'admin';
    const { rows: [employee] } = await db.execute({ sql: 'SELECT pin FROM employees WHERE username=?', args: [username] });
    expect(employee).toBeTruthy();
    expect(employee.pin).toMatch(/^\$2[aby]\$/);
    expect(employee.pin).not.toBe(process.env.POS_TEST_PIN || '123456');
  });

  test('new employee PINs are hashed, still authenticate, and privileged PIN authorization works', async () => {
    const admin = await loginPassword();
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
    const username = `pin_${suffix.slice(-14)}`;
    const password = `Pin!${suffix}Aa9`;
    const pin = `7${String(Date.now()).slice(-5)}`;

    const group = await api(admin.cookie, '/api/security-groups', {
      method: 'POST',
      body: JSON.stringify({
        name: `PIN Security ${suffix}`,
        description: 'Temporary PIN hashing certification authority',
        reason: 'PIN storage hardening runtime certification',
        permissions: { pos: true, reports: true, reports_financial: true },
      }),
    });
    expect(group.status).toBe(201);

    const branches = await api(admin.cookie, '/api/branches');
    expect(branches.status).toBe(200);
    const branch = branches.body.find(b => b.active !== 0) || branches.body[0];
    expect(branch).toBeTruthy();

    let employee = null;
    try {
      const created = await api(admin.cookie, '/api/employees', {
        method: 'POST',
        body: JSON.stringify({
          first_name: 'PIN', last_name: 'Security', username, password, pin,
          security_group_id: group.body.id, default_branch_id: branch.id, must_change_password: false,
        }),
      });
      expect(created.status).toBe(201);
      employee = created.body;

      const { rows: [stored] } = await db.execute({ sql: 'SELECT pin FROM employees WHERE id=?', args: [employee.id] });
      expect(stored.pin).toMatch(/^\$2[aby]\$/);
      expect(stored.pin).not.toBe(pin);

      const pinLogin = await loginPin(username, pin);
      expect(pinLogin.status).toBe(200);
      expect(pinLogin.body.id).toBe(employee.id);

      const approval = await api(admin.cookie, '/api/employees/validate-pin', {
        method: 'POST',
        body: JSON.stringify({ pin, permission: 'reports_financial' }),
      });
      expect(approval.status).toBe(200);
      expect(approval.body.authorized).toBe(true);
    } finally {
      if (employee?.id) {
        await api(admin.cookie, `/api/employees/${employee.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            first_name: employee.first_name,
            last_name: employee.last_name,
            username,
            active: 0,
            security_group_id: group.body.id,
            default_branch_id: employee.default_branch_id,
            must_change_password: false,
          }),
        });
      }
      await api(admin.cookie, `/api/security-groups/${group.body.id}?reason=PIN%20security%20runtime%20cleanup`, { method: 'DELETE' });
    }
  });

  test('legacy plaintext PIN is upgraded to bcrypt after successful PIN login', async () => {
    const admin = await loginPassword();
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
    const username = `legacy_${suffix.slice(-12)}`;
    const password = `Legacy!${suffix}Aa9`;
    const originalPin = `8${String(Date.now()).slice(-5)}`;
    const legacyPin = '778899';

    const group = await api(admin.cookie, '/api/security-groups', {
      method: 'POST',
      body: JSON.stringify({
        name: `Legacy PIN ${suffix}`,
        description: 'Temporary legacy PIN migration fixture',
        reason: 'Legacy PIN migration runtime certification',
        permissions: { pos: true },
      }),
    });
    expect(group.status).toBe(201);

    const branches = await api(admin.cookie, '/api/branches');
    const branch = branches.body.find(b => b.active !== 0) || branches.body[0];
    let employee = null;
    try {
      const created = await api(admin.cookie, '/api/employees', {
        method: 'POST',
        body: JSON.stringify({
          first_name: 'Legacy', last_name: 'PIN', username, password, pin: originalPin,
          security_group_id: group.body.id, default_branch_id: branch.id, must_change_password: false,
        }),
      });
      expect(created.status).toBe(201);
      employee = created.body;

      await db.execute({ sql: 'UPDATE employees SET pin=? WHERE id=?', args: [legacyPin, employee.id] });
      const before = (await db.execute({ sql: 'SELECT pin FROM employees WHERE id=?', args: [employee.id] })).rows[0];
      expect(before.pin).toBe(legacyPin);

      const pinLogin = await loginPin(username, legacyPin);
      expect(pinLogin.status).toBe(200);

      const after = (await db.execute({ sql: 'SELECT pin FROM employees WHERE id=?', args: [employee.id] })).rows[0];
      expect(after.pin).toMatch(/^\$2[aby]\$/);
      expect(after.pin).not.toBe(legacyPin);
    } finally {
      if (employee?.id) {
        await api(admin.cookie, `/api/employees/${employee.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            first_name: employee.first_name,
            last_name: employee.last_name,
            username,
            active: 0,
            security_group_id: group.body.id,
            default_branch_id: employee.default_branch_id,
            must_change_password: false,
          }),
        });
      }
      await api(admin.cookie, `/api/security-groups/${group.body.id}?reason=Legacy%20PIN%20runtime%20cleanup`, { method: 'DELETE' });
    }
  });
});
