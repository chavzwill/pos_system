import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:3001';

async function loginCookie() {
  const r = await fetch(`${BASE}/api/employees/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  });
  expect(r.status).toBe(200);
  return (r.headers.get('set-cookie') || '').split(';')[0];
}

test.describe('Repair diagnostics and authorizations', () => {
  test('requires authentication', async () => {
    const r = await fetch(`${BASE}/api/repair-authorizations/work-orders/999999`);
    expect(r.status).toBe(401);
  });

  test('returns not found for a missing work order after authentication', async () => {
    const cookie = await loginCookie();
    const r = await fetch(`${BASE}/api/repair-authorizations/work-orders/999999`, { headers: { Cookie: cookie } });
    expect(r.status).toBe(404);
  });

  test('rejects diagnostics for a missing work order', async () => {
    const cookie = await loginCookie();
    const r = await fetch(`${BASE}/api/repair-authorizations/work-orders/999999/diagnostics`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ findings: 'Test finding' }),
    });
    expect(r.status).toBe(404);
  });

  test('rejects a decision for a missing estimate revision', async () => {
    const cookie = await loginCookie();
    const r = await fetch(`${BASE}/api/repair-authorizations/estimates/999999/decision`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approved', authorization_method: 'phone' }),
    });
    expect(r.status).toBe(404);
  });
});
