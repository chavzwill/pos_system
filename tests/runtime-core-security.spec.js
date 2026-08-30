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

async function req(cookie, path, options = {}) {
  const headers = { Cookie: cookie, Accept: 'application/json', ...(options.headers || {}) };
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${BASE}${path}`, { ...options, headers });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function createLimitedOperator(adminCookie, branchId) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const group = await req(adminCookie, '/api/security-groups', {
    method: 'POST',
    body: JSON.stringify({
      name: `Runtime Dispatch Viewer ${suffix}`,
      description: 'Temporary runtime certification group',
      reason: 'Runtime security certification',
      permissions: { pos: true, dispatch_view: true },
    }),
  });
  expect(group.status).toBe(201);

  const username = `rt_${suffix.replace(/[^a-z0-9]/gi, '').slice(-16)}`;
  const password = `Rt!${suffix}Aa1`;
  const pin = String(Date.now()).slice(-6);
  const employee = await req(adminCookie, '/api/employees', {
    method: 'POST',
    body: JSON.stringify({
      first_name: 'Runtime',
      last_name: 'Operator',
      username,
      password,
      pin,
      security_group_id: group.body.id,
      default_branch_id: branchId,
      must_change_password: false,
    }),
  });
  expect(employee.status).toBe(201);
  return { group: group.body, employee: employee.body, username, password };
}

async function cleanupLimitedOperator(adminCookie, fixture) {
  if (!fixture) return;
  await req(adminCookie, `/api/employees/${fixture.employee.id}`, {
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
  await req(adminCookie, `/api/security-groups/${fixture.group.id}?reason=Runtime%20security%20certification%20cleanup`, { method: 'DELETE' });
}

test.describe('Runtime core security certification', () => {
  test('session authentication rejects bad credentials and accepts the configured test account', async () => {
    const bad = await fetch(`${BASE}/api/employees/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: '__invalid_runtime_user__', password: '__invalid__' }),
    });
    expect(bad.status).toBe(401);

    const auth = await login();
    const profile = await req(auth.cookie, '/api/workspace-profile/me');
    expect(profile.status).toBe(200);
    expect(profile.body.employee?.id).toBeTruthy();
    expect(profile.body.permissions).toBeTruthy();
  });

  test('Dispatch permission catalog exposes view, plan, execute and admin independently', async () => {
    const auth = await login();
    const catalog = await req(auth.cookie, '/api/security-groups/catalog');
    expect(catalog.status).toBe(200);
    const dispatch = catalog.body.find(module => module.key === 'dispatch');
    expect(dispatch).toBeTruthy();
    expect(dispatch.subs.map(x => x.key)).toEqual(expect.arrayContaining([
      'dispatch_view', 'dispatch_plan', 'dispatch_execute', 'dispatch_admin',
    ]));
  });

  test('view-only Dispatch role can read the board but cannot plan jobs and cannot sell from another branch', async () => {
    const admin = await login();
    const branches = await req(admin.cookie, '/api/branches');
    expect(branches.status).toBe(200);
    const active = branches.body.filter(b => b.active !== 0);
    test.skip(active.length < 2, 'Cross-branch certification requires at least two active branches');

    let fixture = null;
    try {
      fixture = await createLimitedOperator(admin.cookie, active[0].id);
      const limited = await login(fixture.username, fixture.password);

      const board = await req(limited.cookie, '/api/logistics-intelligence/command-center');
      expect(board.status).toBe(200);

      const planAttempt = await req(limited.cookie, '/api/logistics-intelligence/jobs', {
        method: 'POST',
        body: JSON.stringify({
          source_type: 'runtime_probe',
          origin_label: 'Origin',
          destination_label: 'Destination',
          job_type: 'runtime_probe',
        }),
      });
      expect(planAttempt.status).toBe(403);
      expect(planAttempt.body?.control).toBe('dispatch_rbac');
      expect(planAttempt.body?.error).toMatch(/dispatch_plan/i);

      // The cross-branch guard runs before product lookup, so a deliberately
      // nonexistent product is enough to prove branch authority without
      // creating a sale or altering inventory.
      const crossBranchSale = await req(limited.cookie, '/api/transactions', {
        method: 'POST',
        body: JSON.stringify({
          branch_id: active[1].id,
          items: [{ product_id: 999999999, quantity: 1 }],
          payment_method: 'cash',
          amount_tendered: 1,
        }),
      });
      expect(crossBranchSale.status).toBe(403);
      expect(crossBranchSale.body?.error).toMatch(/another branch|assigned branch/i);
    } finally {
      await cleanupLimitedOperator(admin.cookie, fixture);
    }
  });
});
