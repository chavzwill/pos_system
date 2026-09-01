import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:3001';

async function loginCookie() {
  const r = await fetch(`${BASE}/api/employees/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  });
  expect(r.status).toBe(200);
  return (r.headers.get('set-cookie') || '').split(';')[0];
}

test.describe('ERP management intelligence', () => {
  test('requires staff authentication', async () => {
    const r = await fetch(`${BASE}/api/erp-intelligence/alerts`);
    expect(r.status).toBe(401);
  });

  test('returns evidence-only categorized management exceptions', async () => {
    const cookie = await loginCookie();
    const r = await fetch(`${BASE}/api/erp-intelligence/alerts`, { headers: { Cookie: cookie } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toHaveProperty('generated_at');
    expect(body).toHaveProperty('counts');
    expect(Array.isArray(body.alerts)).toBe(true);
    expect(body.methodology).toMatch(/evidence|no operational action/i);
    for (const alert of body.alerts) {
      expect(['critical','high','medium','low']).toContain(alert.severity);
      expect(alert).toHaveProperty('type');
      expect(alert).toHaveProperty('title');
      expect(alert).toHaveProperty('detail');
      expect(alert).toHaveProperty('entity');
    }
  });
});
