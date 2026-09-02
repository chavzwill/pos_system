import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:3001';
const ADMIN_USER = process.env.POS_TEST_USER || 'admin';
const ADMIN_PASSWORD = process.env.POS_TEST_PASSWORD || 'CI-Test-Auth!2026';

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

test.describe('Password reset and recovery runtime boundary', () => {
  test('administrator reset is audited, revokes sessions, forces change, and normal self-change requires current password', async () => {
    const admin = await login(ADMIN_USER, ADMIN_PASSWORD);
    expect(admin.status).toBe(200);

    const suffix = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
    const username = `reset_${suffix}`;
    const initial = `Initial-${suffix}-A8!`;
    const temporary = `Temporary-${suffix}-B7!`;
    const changed = `Changed-${suffix}-C6!`;
    const changedAgain = `ChangedAgain-${suffix}-D5!`;
    const pin = String(100000 + (Number(suffix.slice(-5)) % 899999)).slice(0, 6);

    const created = await api(admin.cookie, '/api/employees', {
      method: 'POST',
      body: JSON.stringify({
        first_name: 'Reset', last_name: 'Boundary', username, pin,
        password: initial, must_change_password: false,
        default_branch_id: admin.body?.default_branch_id || 1,
      }),
    });
    expect(created.status).toBe(201);
    const employeeId = Number(created.body.id);

    const beforeReset = await login(username, initial);
    expect(beforeReset.status).toBe(200);

    const profilePasswordMutation = await api(admin.cookie, `/api/employees/${employeeId}`, {
      method: 'PUT',
      body: JSON.stringify({ password: temporary }),
    });
    expect(profilePasswordMutation.status).toBe(400);
    expect(profilePasswordMutation.body?.error).toMatch(/reset-password/i);

    const missingReason = await api(admin.cookie, `/api/employees/${employeeId}/reset-password`, {
      method: 'POST', body: JSON.stringify({ temporary_password: temporary }),
    });
    expect(missingReason.status).toBe(400);

    const weakReset = await api(admin.cookie, `/api/employees/${employeeId}/reset-password`, {
      method: 'POST', body: JSON.stringify({ temporary_password: '123456', reason: 'Integrity test reset' }),
    });
    expect(weakReset.status).toBe(400);

    const reset = await api(admin.cookie, `/api/employees/${employeeId}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ temporary_password: temporary, reason: 'Automated credential lifecycle certification' }),
    });
    expect(reset.status).toBe(200);
    expect(reset.body).toMatchObject({ success: true, must_change_password: true, sessions_revoked: true });

    const oldSession = await api(beforeReset.cookie, '/api/settings');
    expect(oldSession.status).toBe(401);
    expect((await login(username, initial)).status).toBe(401);

    const forced = await login(username, temporary);
    expect(forced.status).toBe(200);
    expect(Number(forced.body?.must_change_password)).toBe(1);

    const forcedBusinessAccess = await api(forced.cookie, '/api/products');
    expect(forcedBusinessAccess.status).toBe(403);
    expect(forcedBusinessAccess.body?.code).toBe('PASSWORD_CHANGE_REQUIRED');

    const forcedChange = await api(forced.cookie, `/api/employees/${employeeId}/change-password`, {
      method: 'PUT', body: JSON.stringify({ password: changed }),
    });
    expect(forcedChange.status).toBe(200);
    expect(forcedChange.body?.reauthentication_required).toBe(true);

    const normal = await login(username, changed);
    expect(normal.status).toBe(200);
    expect(Number(normal.body?.must_change_password)).toBe(0);

    const noCurrent = await api(normal.cookie, `/api/employees/${employeeId}/change-password`, {
      method: 'PUT', body: JSON.stringify({ password: changedAgain }),
    });
    expect(noCurrent.status).toBe(403);

    const wrongCurrent = await api(normal.cookie, `/api/employees/${employeeId}/change-password`, {
      method: 'PUT', body: JSON.stringify({ password: changedAgain, current_password: temporary }),
    });
    expect(wrongCurrent.status).toBe(403);

    const authenticatedChange = await api(normal.cookie, `/api/employees/${employeeId}/change-password`, {
      method: 'PUT', body: JSON.stringify({ password: changedAgain, current_password: changed }),
    });
    expect(authenticatedChange.status).toBe(200);
    expect((await login(username, changed)).status).toBe(401);
    expect((await login(username, changedAgain)).status).toBe(200);

    const audit = await api(admin.cookie, '/api/security-groups/audit/recent');
    expect(audit.status).toBe(200);
    const targetEvents = audit.body.filter(event => Number(event.target_id) === employeeId);
    expect(targetEvents.some(event => event.action === 'password_reset_by_admin' && event.control === 'credential_lifecycle')).toBe(true);
    expect(targetEvents.filter(event => event.action === 'password_changed_self').length).toBeGreaterThanOrEqual(2);
    const serializedAudit = JSON.stringify(targetEvents);
    expect(serializedAudit).not.toContain(temporary);
    expect(serializedAudit).not.toContain(changed);
    expect(serializedAudit).not.toContain(changedAgain);
  });
});
