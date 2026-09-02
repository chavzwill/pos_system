import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:3001';
const TEST_USER = process.env.POS_TEST_USER || 'admin';
const TEST_PASSWORD = process.env.POS_TEST_PASSWORD || 'CI-Test-Auth!2026';

async function loginCookie() {
  const r = await fetch(`${BASE}/api/employees/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: TEST_USER, password: TEST_PASSWORD }),
  });
  expect(r.status).toBe(200);
  return (r.headers.get('set-cookie') || '').split(';')[0];
}

test.describe('Inventory intelligence', () => {
  test('requires authentication', async () => {
    const r = await fetch(`${BASE}/api/inventory-intelligence/overview`);
    expect(r.status).toBe(401);
  });

  test('returns evidence-backed inventory intelligence shape', async () => {
    const cookie = await loginCookie();
    const r = await fetch(`${BASE}/api/inventory-intelligence/overview`, { headers: { Cookie: cookie } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toHaveProperty('generated_at');
    expect(body).toHaveProperty('summary');
    expect(body).toHaveProperty('recommendations');
    expect(body).toHaveProperty('branch_imbalances');
    expect(body).toHaveProperty('exceptions');
    expect(body.evidence_policy).toMatch(/derived|verified|inventory/i);
    expect(Array.isArray(body.recommendations)).toBe(true);
    expect(Array.isArray(body.branch_imbalances)).toBe(true);
    expect(body.summary).toEqual(expect.objectContaining({
      branch_item_records: expect.any(Number),
      total_inventory_value: expect.any(Number),
      stockouts: expect.any(Number),
      low_stock: expect.any(Number),
      negative_stock: expect.any(Number),
      branch_imbalance_recommendations: expect.any(Number),
    }));
  });
});
