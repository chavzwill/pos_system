import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:3001';

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
  return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
}

async function makeRestrictedEmployee(adminCookie) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const group = await api(adminCookie, '/api/security-groups', {
    method: 'POST',
    body: JSON.stringify({
      name: `Security Runtime Restricted ${suffix}`,
      description: 'Temporary adversarial security fixture',
      reason: 'Security hardening runtime certification',
      permissions: { pos: true },
    }),
  });
  expect(group.status).toBe(201);

  const branches = await api(adminCookie, '/api/branches');
  expect(branches.status).toBe(200);
  const branch = branches.body.find(b => b.active !== 0) || branches.body[0];
  expect(branch).toBeTruthy();

  const username = `sec_${suffix.replace(/[^a-z0-9]/gi, '').slice(-16)}`;
  const password = `Sec!${suffix}Aa9`;
  const replacement = `New!${suffix}Bb8`;
  const pin = String(Date.now()).slice(-6);
  const employee = await api(adminCookie, '/api/employees', {
    method: 'POST',
    body: JSON.stringify({
      first_name: 'Security', last_name: 'Restricted', username, password, pin,
      security_group_id: group.body.id, default_branch_id: branch.id, must_change_password: false,
    }),
  });
  expect(employee.status).toBe(201);
  return { group: group.body, employee: employee.body, username, password, replacement, pin };
}

async function cleanup(adminCookie, fixture) {
  if (!fixture) return;
  await api(adminCookie, `/api/employees/${fixture.employee.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      first_name: fixture.employee.first_name,
      last_name: fixture.employee.last_name,
      username: fixture.username,
      active: 0,
      security_group_id: fixture.group.id,
      default_branch_id: fixture.employee.default_branch_id,
      must_change_password: false,
    }),
  });
  await api(adminCookie, `/api/security-groups/${fixture.group.id}?reason=Security%20runtime%20cleanup`, { method: 'DELETE' });
}

test.describe('POS security hardening', () => {
  test('HTTP shell emits security headers and request correlation ID', async () => {
    const r = await fetch(`${BASE}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect(r.headers.get('x-request-id')).toBeTruthy();
    expect(r.headers.get('x-powered-by')).toBeNull();
  });

  test('cross-site cookie mutation is rejected before business logic', async () => {
    const auth = await login();
    const r = await fetch(`${BASE}/api/transactions`, {
      method: 'POST',
      headers: {
        Cookie: auth.cookie,
        'Content-Type': 'application/json',
        Origin: 'https://attacker.invalid',
        'Sec-Fetch-Site': 'cross-site',
      },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toMatch(/cross-site|cross-origin/i);
  });

  test('restricted employee cannot reset another employee password and own reset revokes its session', async () => {
    const admin = await login();
    let fixture = null;
    try {
      fixture = await makeRestrictedEmployee(admin.cookie);
      const restricted = await login(fixture.username, fixture.password);

      const escalation = await api(restricted.cookie, `/api/employees/${admin.body.id}/change-password`, {
        method: 'PUT',
        body: JSON.stringify({ password: 'DoNotApply!123' }),
      });
      expect(escalation.status).toBe(403);

      const selfChange = await api(restricted.cookie, `/api/employees/${fixture.employee.id}/change-password`, {
        method: 'PUT',
        body: JSON.stringify({ password: fixture.replacement }),
      });
      expect(selfChange.status).toBe(200);
      expect(selfChange.body?.reauthentication_required).toBe(true);

      const staleSession = await api(restricted.cookie, '/api/workspace-profile/me');
      expect(staleSession.status).toBe(401);

      const oldLogin = await fetch(`${BASE}/api/employees/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: fixture.username, password: fixture.password }),
      });
      expect(oldLogin.status).toBe(401);
      const newLogin = await login(fixture.username, fixture.replacement);
      expect(newLogin.body.id).toBe(fixture.employee.id);
    } finally {
      await cleanup(admin.cookie, fixture);
    }
  });

  test('repeated bad login attempts are throttled', async () => {
    const username = `__rate_limit_${Date.now()}__`;
    let last = null;
    for (let i = 0; i < 11; i += 1) {
      last = await fetch(`${BASE}/api/employees/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: `wrong-${i}` }),
      });
    }
    expect(last.status).toBe(429);
    expect(last.headers.get('retry-after')).toBeTruthy();
  });

  test('repeated invalid privileged PIN attempts are throttled', async () => {
    const auth = await login();
    let last = null;
    for (let i = 0; i < 9; i += 1) {
      last = await fetch(`${BASE}/api/employees/validate-pin`, {
        method: 'POST',
        headers: { Cookie: auth.cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: `99${String(i).padStart(4, '0')}`, permission: 'reports_financial' }),
      });
    }
    expect(last.status).toBe(429);
    expect(last.headers.get('retry-after')).toBeTruthy();
  });

  test('identity, signature and procurement evidence are not bearer-accessible static files', async () => {
    const protectedPaths = [
      '/uploads/customer-ids/security-probe.png',
      '/uploads/rental-signatures/security-probe.png',
      '/uploads/rental-po-attachments/security-probe.pdf',
      '/uploads/po-attachments/security-probe.pdf',
    ];
    for (const path of protectedPaths) {
      const anonymous = await fetch(`${BASE}${path}`);
      expect(anonymous.status, `${path} must require authentication`).toBe(401);
      expect(anonymous.headers.get('cache-control') || '').toMatch(/no-store/);
    }

    const admin = await login();
    let fixture = null;
    try {
      fixture = await makeRestrictedEmployee(admin.cookie);
      const restricted = await login(fixture.username, fixture.password);
      const denied = await fetch(`${BASE}/uploads/customer-ids/security-probe.png`, {
        headers: { Cookie: restricted.cookie },
      });
      expect(denied.status).toBe(403);

      const authorizedMissing = await fetch(`${BASE}/uploads/customer-ids/security-probe.png`, {
        headers: { Cookie: admin.cookie },
      });
      expect(authorizedMissing.status).toBe(404);
      expect(authorizedMissing.headers.get('cache-control') || '').toMatch(/no-store/);
    } finally {
      await cleanup(admin.cookie, fixture);
    }
  });
});
