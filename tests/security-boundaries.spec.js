import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:3001';

async function status(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, options);
  return response.status;
}

test.describe('Operational security boundaries', () => {
  test('sensitive operational and intelligence reads reject anonymous access', async () => {
    const protectedReads = [
      '/api/workspace-profile/me',
      '/api/erp-intelligence/alerts',
      '/api/accounting-intelligence/overview',
      '/api/technician-management-intelligence/overview?days=30',
      '/api/technician-compensation/performance/summary',
      '/api/work-orders?limit=1',
      '/api/rentals/agreements',
      '/api/purchase-orders',
    ];

    const results = await Promise.all(protectedReads.map(async path => ({ path, status: await status(path) })));
    for (const result of results) {
      expect(result.status, `${result.path} must reject anonymous access`).toBe(401);
    }
  });

  test('sensitive mutations reject anonymous access before business logic runs', async () => {
    const protectedMutations = [
      { path: '/api/purchase-orders', method: 'POST', body: {} },
      { path: '/api/technician-compensation/performance/events', method: 'POST', body: {} },
      { path: '/api/repair-quality/work-orders/999999/qc', method: 'POST', body: { result: 'pass' } },
      { path: '/api/repair-quality/work-orders/999999/comeback', method: 'POST', body: { reason: 'security-boundary probe' } },
    ];

    for (const mutation of protectedMutations) {
      const result = await status(mutation.path, {
        method: mutation.method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mutation.body),
      });
      expect(result, `${mutation.method} ${mutation.path} must reject anonymous access`).toBe(401);
    }
  });

  test('performance evidence API rejects malformed adverse events even after authentication', async () => {
    const login = await fetch(`${BASE}/api/employees/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: process.env.POS_TEST_USER || 'admin',
        password: process.env.POS_TEST_PASSWORD || '123456',
      }),
    });
    expect(login.status).toBe(200);
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];

    const employees = await fetch(`${BASE}/api/employees`, { headers: { Cookie: cookie } });
    expect(employees.status).toBe(200);
    const rows = await employees.json();
    const technician = rows.find(row => row.active !== 0) || rows[0];
    if (!technician) return;

    const adverse = await fetch(`${BASE}/api/technician-compensation/performance/events`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ technician_id: technician.id, event_type: 'safety_incident', note: '' }),
    });
    expect(adverse.status).toBe(400);
    const payload = await adverse.json();
    expect(payload.error).toMatch(/note is required/i);
  });
});
