import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:3001';
const ADMIN_USER = process.env.POS_TEST_USER || 'admin';
const ADMIN_PASSWORD = process.env.POS_TEST_PASSWORD || 'CI-Test-Auth!2026';

async function login(username, credential, kind = 'password') {
  const response = await fetch(`${BASE}/api/employees/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, [kind]: credential }),
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

test.describe('PIN credential lifecycle', () => {
  test('PIN changes are dedicated, elevated when cross-user, audited, and revoke sessions', async () => {
    const admin = await login(ADMIN_USER, ADMIN_PASSWORD);
    expect(admin.status).toBe(200);

    const suffix = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
    const username = `pin_${suffix}`;
    const password = `PinLifecycle-${suffix}-A8!`;
    const initialPin = String(200000 + (Number(suffix.slice(-5)) % 700000));
    const resetPin = String((Number(initialPin) + 111111) % 900000 + 100000).slice(0, 6);
    const selfPin = String((Number(resetPin) + 222222) % 900000 + 100000).slice(0, 6);

    const created = await api(admin.cookie, '/api/employees', {
      method: 'POST',
      body: JSON.stringify({
        first_name: 'Pin', last_name: 'Boundary', username,
        pin: initialPin, password,
        default_branch_id: admin.body?.default_branch_id || 1,
      }),
    });
    expect(created.status).toBe(201);
    const employeeId = Number(created.body.id);

    const employeeSession = await login(username, password);
    expect(employeeSession.status).toBe(200);

    const profileMutation = await api(admin.cookie, `/api/employees/${employeeId}`, {
      method: 'PUT', body: JSON.stringify({ pin: resetPin }),
    });
    expect(profileMutation.status).toBe(400);
    expect(profileMutation.body?.error).toMatch(/change-pin|reset-pin/i);

    const ordinaryReset = await api(employeeSession.cookie, `/api/employees/${admin.body.id}/reset-pin`, {
      method: 'POST',
      body: JSON.stringify({ pin: resetPin, reason: 'Unauthorized PIN takeover attempt', reauth_password: password }),
    });
    expect(ordinaryReset.status).toBe(403);

    const missingReauth = await api(admin.cookie, `/api/employees/${employeeId}/reset-pin`, {
      method: 'POST', body: JSON.stringify({ pin: resetPin, reason: 'Authorized support PIN reset' }),
    });
    expect(missingReauth.status).toBe(403);

    const wrongReauth = await api(admin.cookie, `/api/employees/${employeeId}/reset-pin`, {
      method: 'POST',
      body: JSON.stringify({ pin: resetPin, reason: 'Authorized support PIN reset', reauth_password: 'Wrong-Admin-Password!9' }),
    });
    expect(wrongReauth.status).toBe(403);

    const reset = await api(admin.cookie, `/api/employees/${employeeId}/reset-pin`, {
      method: 'POST',
      body: JSON.stringify({ pin: resetPin, reason: 'Automated PIN lifecycle certification', reauth_password: ADMIN_PASSWORD }),
    });
    expect(reset.status).toBe(200);
    expect(reset.body).toMatchObject({ success: true, sessions_revoked: true });

    expect((await api(employeeSession.cookie, '/api/settings')).status).toBe(401);
    expect((await login(username, initialPin, 'pin')).status).toBe(401);
    const resetPinSession = await login(username, resetPin, 'pin');
    expect(resetPinSession.status).toBe(200);

    const missingSelfReauth = await api(resetPinSession.cookie, `/api/employees/${employeeId}/change-pin`, {
      method: 'PUT', body: JSON.stringify({ pin: selfPin }),
    });
    expect(missingSelfReauth.status).toBe(403);

    const selfChange = await api(resetPinSession.cookie, `/api/employees/${employeeId}/change-pin`, {
      method: 'PUT', body: JSON.stringify({ pin: selfPin, current_password: password }),
    });
    expect(selfChange.status).toBe(200);
    expect(selfChange.body).toMatchObject({ success: true, sessions_revoked: true, reauthentication_required: true });

    expect((await api(resetPinSession.cookie, '/api/settings')).status).toBe(401);
    expect((await login(username, resetPin, 'pin')).status).toBe(401);
    expect((await login(username, selfPin, 'pin')).status).toBe(200);

    const audit = await api(admin.cookie, '/api/security-groups/audit/recent');
    expect(audit.status).toBe(200);
    const events = audit.body.filter(event => Number(event.target_id) === employeeId);
    expect(events.some(event => event.action === 'pin_reset_by_admin' && event.control === 'credential_lifecycle')).toBe(true);
    expect(events.some(event => event.action === 'pin_changed_self' && event.control === 'credential_lifecycle')).toBe(true);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(initialPin);
    expect(serialized).not.toContain(resetPin);
    expect(serialized).not.toContain(selfPin);
    expect(serialized).not.toContain(ADMIN_PASSWORD);
  });
});