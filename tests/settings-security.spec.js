import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:3001';

async function login(username = process.env.POS_TEST_USER || 'admin', password = process.env.POS_TEST_PASSWORD || '') {
  const r = await fetch(`${BASE}/api/employees/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
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

async function makeSettingsEmployee(admin) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const group = await api(admin.cookie, '/api/security-groups', {
    method: 'POST',
    body: JSON.stringify({
      name: `Settings Boundary ${suffix}`,
      description: 'Temporary settings least-privilege certification group',
      reason: 'Settings integration authority certification',
      permissions: { settings: true },
    }),
  });
  expect(group.status).toBe(201);

  const branches = await api(admin.cookie, '/api/branches');
  expect(branches.status).toBe(200);
  const branch = branches.body.find(x => x.active !== 0) || branches.body[0];
  expect(branch).toBeTruthy();
  const username = `settings_${suffix.replace(/[^a-z0-9]/gi, '').slice(-14)}`;
  const password = `Settings!${suffix}Aa9`;
  const employee = await api(admin.cookie, '/api/employees', {
    method: 'POST',
    body: JSON.stringify({
      first_name: 'Settings', last_name: 'Operator', username, password,
      pin: String(Date.now()).slice(-6), security_group_id: group.body.id,
      default_branch_id: branch.id, must_change_password: false,
    }),
  });
  expect(employee.status).toBe(201);
  return { group: group.body, employee: employee.body, username, password };
}

async function cleanup(admin, fixture) {
  if (!fixture) return;
  await api(admin.cookie, `/api/employees/${fixture.employee.id}`, {
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
  await api(admin.cookie, `/api/security-groups/${fixture.group.id}?reason=Settings%20security%20certification%20cleanup`, { method: 'DELETE' });
}

test.describe('Settings and integration-secret security', () => {
  test('broad Settings authority cannot inherit integration-secret or API-key administration', async () => {
    const admin = await login();
    const before = await api(admin.cookie, '/api/settings/manage');
    expect(before.status).toBe(200);
    let fixture = null;
    try {
      fixture = await makeSettingsEmployee(admin);
      const limited = await login(fixture.username, fixture.password);

      const manage = await api(limited.cookie, '/api/settings/manage');
      expect(manage.status).toBe(200);
      expect(manage.body.capabilities).toMatchObject({ ordinary: true, integrations: false });
      expect(manage.body.values.email_smtp_host).toBeUndefined();
      expect(manage.body.values.repair_notify_sms_webhook_url).toBeUndefined();
      expect(manage.body.values.woo_sync_interval).toBeUndefined();
      expect(manage.body.secret_keys).not.toContain('email_smtp_pass');

      const keys = await api(limited.cookie, '/api/api-keys');
      expect(keys.status).toBe(403);
      expect(keys.body?.error).toMatch(/settings_integrations/i);

      const blocked = await api(limited.cookie, '/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          store_name: before.body.values.store_name || 'Runtime Store',
          email_smtp_host: 'blocked-settings-security.invalid',
        }),
      });
      expect(blocked.status).toBe(403);
      expect(blocked.body?.error).toMatch(/settings_integrations/i);

      const after = await api(admin.cookie, '/api/settings/manage');
      expect(after.status).toBe(200);
      expect(after.body.values.store_name).toBe(before.body.values.store_name);
      expect(after.body.values.email_smtp_host).toBe(before.body.values.email_smtp_host);
    } finally {
      await cleanup(admin, fixture);
    }
  });

  test('integration configuration writes are atomic, audited, and never expose secret material', async () => {
    const admin = await login();
    const before = await api(admin.cookie, '/api/settings/manage');
    expect(before.status).toBe(200);
    expect(before.body.capabilities.integrations).toBe(true);

    const secret = `SettingsAuditSecret!${Date.now()}`;
    const interval = String((Number(before.body.values.woo_sync_interval || 0) + 7) || 7);
    const updated = await api(admin.cookie, '/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ woo_sync_interval: interval, repair_notify_sms_webhook_token: secret }),
    });
    expect(updated.status).toBe(200);

    const manage = await api(admin.cookie, '/api/settings/manage');
    expect(manage.status).toBe(200);
    expect(manage.body.values.woo_sync_interval).toBe(interval);
    expect(manage.body.values.repair_notify_sms_webhook_token).toBe('••••••••');

    const audit = await api(admin.cookie, '/api/security-groups/audit/recent');
    expect(audit.status).toBe(200);
    const event = audit.body.find(row => row.action === 'settings_updated' && row.path === '/api/settings');
    expect(event).toBeTruthy();
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(secret);
    const evidence = JSON.parse(event.new_value || '{}');
    expect(evidence.changed_keys).toEqual(expect.arrayContaining(['woo_sync_interval', 'repair_notify_sms_webhook_token']));
    expect(evidence.secret_keys_changed).toContain('repair_notify_sms_webhook_token');

    const restored = await api(admin.cookie, '/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        woo_sync_interval: before.body.values.woo_sync_interval ?? '',
        repair_notify_sms_webhook_token: null,
      }),
    });
    expect(restored.status).toBe(200);
  });
});
