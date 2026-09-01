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
  return { status: r.status, body: await r.json().catch(() => null) };
}

test('security_assign cannot cross effective inherited authority boundaries', async () => {
  const admin = await login();
  expect(admin.body.security_group_id).toBeTruthy();

  const branches = await api(admin.cookie, '/api/branches');
  expect(branches.status).toBe(200);
  const branch = branches.body.find(b => b.active !== 0) || branches.body[0];
  expect(branch).toBeTruthy();

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const bounded = await api(admin.cookie, '/api/security-groups', {
    method: 'POST',
    body: JSON.stringify({
      name: `Bounded Assigner ${suffix}`,
      description: 'Temporary security assignment boundary fixture',
      reason: 'Inherited security assignment certification',
      permissions: { security_assign: true },
    }),
  });
  expect(bounded.status).toBe(201);

  const broadSecurity = await api(admin.cookie, '/api/security-groups', {
    method: 'POST',
    body: JSON.stringify({
      name: `Broad Security ${suffix}`,
      description: 'Parent-permission escalation fixture',
      reason: 'Inherited security assignment certification',
      permissions: { security: true },
    }),
  });
  expect(broadSecurity.status).toBe(201);

  const username = `bound_${suffix.replace(/[^a-z0-9]/gi, '').slice(-14)}`;
  const password = `Bound!${suffix}Aa9`;
  const pin = `8${String(Date.now()).slice(-5)}`;
  let employee = null;
  try {
    const created = await api(admin.cookie, '/api/employees', {
      method: 'POST',
      body: JSON.stringify({
        first_name: 'Bounded', last_name: 'Security', username, password, pin,
        security_group_id: bounded.body.id,
        default_branch_id: branch.id,
        must_change_password: false,
      }),
    });
    expect(created.status).toBe(201);
    employee = created.body;

    const limited = await login(username, password);

    // Broad parent `security:true` effectively grants security_manage. A
    // security_assign-only actor must not be able to exploit parent inheritance.
    const inheritedEscalation = await api(limited.cookie, `/api/security-groups/${broadSecurity.body.id}/assign`, {
      method: 'POST',
      body: JSON.stringify({ employee_id: employee.id, reason: 'Attempt inherited privilege escalation' }),
    });
    expect(inheritedEscalation.status).toBe(403);
    expect(inheritedEscalation.body?.error).toMatch(/authority you do not hold/i);

    // Direct administrator-group promotion is equally forbidden.
    const directEscalation = await api(limited.cookie, `/api/security-groups/${admin.body.security_group_id}/assign`, {
      method: 'POST',
      body: JSON.stringify({ employee_id: employee.id, reason: 'Attempt direct privilege escalation' }),
    });
    expect(directEscalation.status).toBe(403);
    expect(directEscalation.body?.error).toMatch(/authority you do not hold/i);

    // Nor may the bounded actor demote/remove an identity from a stronger group.
    const privilegedRemoval = await api(limited.cookie, `/api/security-groups/${admin.body.security_group_id}/assign/${admin.body.id}?reason=Attempt%20privileged%20membership%20removal`, {
      method: 'DELETE',
    });
    expect(privilegedRemoval.status).toBe(403);
    expect(privilegedRemoval.body?.error).toMatch(/authority you do not hold/i);

    const limitedProfile = await api(limited.cookie, '/api/workspace-profile/me');
    expect(limitedProfile.status).toBe(200);
    expect(Number(limitedProfile.body.employee?.security_group_id)).toBe(Number(bounded.body.id));

    const adminProfile = await api(admin.cookie, '/api/workspace-profile/me');
    expect(adminProfile.status).toBe(200);
    expect(Number(adminProfile.body.employee?.security_group_id)).toBe(Number(admin.body.security_group_id));
  } finally {
    if (employee?.id) {
      await api(admin.cookie, `/api/employees/${employee.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          first_name: employee.first_name,
          last_name: employee.last_name,
          username,
          active: 0,
          security_group_id: bounded.body.id,
          default_branch_id: employee.default_branch_id,
          must_change_password: false,
        }),
      });
    }
    await api(admin.cookie, `/api/security-groups/${broadSecurity.body.id}?reason=Inherited%20security%20fixture%20cleanup`, { method: 'DELETE' });
    await api(admin.cookie, `/api/security-groups/${bounded.body.id}?reason=Inherited%20security%20fixture%20cleanup`, { method: 'DELETE' });
  }
});
