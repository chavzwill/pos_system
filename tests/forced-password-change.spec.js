import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:3001';

async function login(username, password) {
  const response = await fetch(`${BASE}/api/employees/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return {
    status: response.status,
    body: await response.json().catch(() => null),
    cookie: (response.headers.get('set-cookie') || '').split(';')[0],
  };
}

async function api(cookie, path, options = {}) {
  const headers = { Cookie: cookie, Accept: 'application/json', ...(options.headers || {}) };
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${BASE}${path}`, { ...options, headers });
  return { status: response.status, body: await response.json().catch(() => null) };
}

test.describe('Forced password change boundary', () => {
  test('forced-change sessions cannot reach normal APIs and self-change revokes the bootstrap session', async () => {
    const adminUser = process.env.POS_TEST_USER || 'admin';
    const adminPassword = process.env.POS_TEST_PASSWORD || '123456';
    const admin = await login(adminUser, adminPassword);
    expect(admin.status).toBe(200);

    const suffix = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
    const username = `forced_${suffix}`;
    const initialPassword = `Temp-${suffix}-A9!`;
    const replacementPassword = `Changed-${suffix}-B8!`;
    const pin = String(100000 + (Number(suffix.slice(-5)) % 899999)).slice(0, 6);

    const created = await api(admin.cookie, '/api/employees', {
      method: 'POST',
      body: JSON.stringify({
        first_name: 'Forced',
        last_name: 'Password',
        username,
        pin,
        password: initialPassword,
        must_change_password: true,
        default_branch_id: admin.body?.default_branch_id || 1,
      }),
    });
    expect(created.status).toBe(201);
    const employeeId = Number(created.body?.id);
    expect(employeeId).toBeGreaterThan(0);

    const forced = await login(username, initialPassword);
    expect(forced.status).toBe(200);
    expect(Number(forced.body?.must_change_password)).toBe(1);
    expect(forced.cookie).toContain('pos_session=');

    const blockedRead = await api(forced.cookie, '/api/employees');
    expect(blockedRead.status).toBe(403);
    expect(blockedRead.body?.code).toBe('PASSWORD_CHANGE_REQUIRED');

    const blockedBusiness = await api(forced.cookie, '/api/products');
    expect(blockedBusiness.status).toBe(403);
    expect(blockedBusiness.body?.code).toBe('PASSWORD_CHANGE_REQUIRED');

    const changed = await api(forced.cookie, `/api/employees/${employeeId}/change-password`, {
      method: 'PUT',
      body: JSON.stringify({ password: replacementPassword }),
    });
    expect(changed.status).toBe(200);
    expect(changed.body?.reauthentication_required).toBe(true);

    const revokedOldSession = await api(forced.cookie, '/api/employees');
    expect(revokedOldSession.status).toBe(401);

    const oldCredential = await login(username, initialPassword);
    expect(oldCredential.status).toBe(401);

    const reauthenticated = await login(username, replacementPassword);
    expect(reauthenticated.status).toBe(200);
    expect(Number(reauthenticated.body?.must_change_password)).toBe(0);

    const normalAccess = await api(reauthenticated.cookie, '/api/employees');
    expect(normalAccess.status).toBe(200);
  });
});
