const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:3001';
const ADMIN_USER = process.env.POS_TEST_USER || 'admin';
const ADMIN_PASSWORD = process.env.POS_TEST_PASSWORD || '123456';

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

function employeeUpdate(employee, overrides = {}) {
  return {
    first_name: employee.first_name,
    last_name: employee.last_name,
    username: employee.username,
    active: employee.active == null ? 1 : employee.active,
    security_group_id: employee.security_group_id || null,
    default_branch_id: employee.default_branch_id || null,
    must_change_password: false,
    is_driver: employee.is_driver || false,
    is_operator: employee.is_operator || false,
    is_security: employee.is_security || false,
    ...overrides,
  };
}

async function createEmployee(admin, suffix, groupId, branchId, label) {
  const username = `${label}_${suffix}`;
  const password = `${label}!${suffix}Aa9`;
  const pin = String(100000 + (Number(String(Date.now()).slice(-5)) + Math.floor(Math.random() * 10000)) % 899999).slice(0, 6);
  const created = await api(admin.cookie, '/api/employees', {
    method: 'POST',
    body: JSON.stringify({
      first_name: label,
      last_name: 'Credential',
      username,
      password,
      pin,
      security_group_id: groupId || null,
      default_branch_id: branchId,
      must_change_password: false,
    }),
  });
  expect(created.status).toBe(201);
  return { ...created.body, username, password, pin };
}

test.describe('Employee PIN credential mutation boundary', () => {
  test('self-change requires current PIN and revokes prior sessions', async () => {
    const admin = await login(ADMIN_USER, ADMIN_PASSWORD);
    expect(admin.status).toBe(200);
    const branches = await api(admin.cookie, '/api/branches');
    const branchId = branches.body.find(row => row.active !== 0)?.id || branches.body[0].id;
    const suffix = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
    const employee = await createEmployee(admin, suffix, null, branchId, 'selfpin');
    const session = await login(employee.username, employee.password);
    expect(session.status).toBe(200);
    const nextPin = `9${String(Date.now()).slice(-5)}`;

    const missingCurrent = await api(session.cookie, `/api/employees/${employee.id}`, {
      method: 'PUT',
      body: JSON.stringify(employeeUpdate(employee, { pin: nextPin })),
    });
    expect(missingCurrent.status).toBe(403);
    expect(missingCurrent.body?.code).toBe('CURRENT_PIN_REQUIRED');

    const wrongCurrent = await api(session.cookie, `/api/employees/${employee.id}`, {
      method: 'PUT',
      body: JSON.stringify(employeeUpdate(employee, { pin: nextPin, current_pin: '111111' })),
    });
    expect(wrongCurrent.status).toBe(403);

    const changed = await api(session.cookie, `/api/employees/${employee.id}`, {
      method: 'PUT',
      body: JSON.stringify(employeeUpdate(employee, { pin: nextPin, current_pin: employee.pin })),
    });
    expect(changed.status).toBe(200);

    expect((await api(session.cookie, '/api/settings')).status).toBe(401);
    expect((await login(employee.username, employee.pin, 'pin')).status).toBe(401);
    expect((await login(employee.username, nextPin, 'pin')).status).toBe(200);
  });

  test('cross-user reset requires security authority, reason, and actor password reauthentication', async () => {
    const admin = await login(ADMIN_USER, ADMIN_PASSWORD);
    expect(admin.status).toBe(200);
    const branches = await api(admin.cookie, '/api/branches');
    const branchId = branches.body.find(row => row.active !== 0)?.id || branches.body[0].id;
    const suffix = `${Date.now()}${Math.floor(Math.random() * 10000)}`;

    const limitedGroup = await api(admin.cookie, '/api/security-groups', {
      method: 'POST',
      body: JSON.stringify({
        name: `Employee Editor ${suffix}`,
        description: 'Credential-boundary adversarial fixture',
        reason: 'PIN credential boundary certification',
        permissions: { employees: true },
      }),
    });
    expect(limitedGroup.status).toBe(201);

    const actor = await createEmployee(admin, suffix, limitedGroup.body.id, branchId, 'limited');
    const target = await createEmployee(admin, `${suffix}7`, null, branchId, 'targetpin');
    const actorSession = await login(actor.username, actor.password);
    const targetSession = await login(target.username, target.password);
    expect(actorSession.status).toBe(200);
    expect(targetSession.status).toBe(200);
    const nextPin = `8${String(Date.now()).slice(-5)}`;

    const unauthorized = await api(actorSession.cookie, `/api/employees/${target.id}`, {
      method: 'PUT',
      body: JSON.stringify(employeeUpdate(target, { pin: nextPin, reason: 'Attempted PIN reset', reauth_password: actor.password })),
    });
    expect(unauthorized.status).toBe(403);

    const noReauth = await api(admin.cookie, `/api/employees/${target.id}`, {
      method: 'PUT',
      body: JSON.stringify(employeeUpdate(target, { pin: nextPin, reason: 'Manager PIN reset test' })),
    });
    expect(noReauth.status).toBe(403);
    expect(noReauth.body?.code).toBe('REAUTHENTICATION_REQUIRED');

    const wrongReauth = await api(admin.cookie, `/api/employees/${target.id}`, {
      method: 'PUT',
      body: JSON.stringify(employeeUpdate(target, { pin: nextPin, reason: 'Manager PIN reset test', reauth_password: `${ADMIN_PASSWORD}-wrong` })),
    });
    expect(wrongReauth.status).toBe(403);

    const noReason = await api(admin.cookie, `/api/employees/${target.id}`, {
      method: 'PUT',
      body: JSON.stringify(employeeUpdate(target, { pin: nextPin, reauth_password: ADMIN_PASSWORD })),
    });
    expect(noReason.status).toBe(400);

    const changed = await api(admin.cookie, `/api/employees/${target.id}`, {
      method: 'PUT',
      body: JSON.stringify(employeeUpdate(target, { pin: nextPin, reason: 'Manager PIN reset test', reauth_password: ADMIN_PASSWORD })),
    });
    expect(changed.status).toBe(200);
    expect((await api(targetSession.cookie, '/api/settings')).status).toBe(401);
    expect((await login(target.username, target.pin, 'pin')).status).toBe(401);
    expect((await login(target.username, nextPin, 'pin')).status).toBe(200);

    await new Promise(resolve => setTimeout(resolve, 100));
    const audit = await api(admin.cookie, '/api/security-groups/audit/recent');
    expect(audit.status).toBe(200);
    const event = audit.body.find(row => row.action === 'pin_reset_by_admin' && Number(row.target_id) === Number(target.id));
    expect(event).toBeTruthy();
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(nextPin);
    expect(serialized).not.toContain(ADMIN_PASSWORD);
  });
});