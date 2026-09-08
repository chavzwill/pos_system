import { test, expect } from '@playwright/test';
import { TEST_BASE_URL } from './test-base-url.js';

const BASE = TEST_BASE_URL;
const TEST_USER = process.env.POS_TEST_USER;
const TEST_PASSWORD = process.env.POS_TEST_PASSWORD;
if (!TEST_USER || !TEST_PASSWORD) throw new Error('POS_TEST_USER and POS_TEST_PASSWORD are required');

async function loginCookie() {
  const r = await fetch(`${BASE}/api/employees/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: TEST_USER, password: TEST_PASSWORD }),
  });
  expect(r.status).toBe(200);
  return (r.headers.get('set-cookie') || '').split(';')[0];
}

async function api(cookie, path) {
  const r = await fetch(`${BASE}${path}`, { headers: { Cookie: cookie } });
  expect(r.status, `${path} returned ${r.status}`).toBe(200);
  return r.json();
}

function finalBalance(wo) {
  const estimate = (Number(wo.estimate_labor) || 0) + (Number(wo.estimate_consumables) || 0);
  return Math.max(0, Number((estimate + (Number(wo.parts_total) || 0) - (Number(wo.deposit_amount) || 0)).toFixed(2)));
}

test.describe('Service completion and payment integrity', () => {
  test('completion and payment surfaces are protected', async () => {
    for (const [method, path] of [
      ['PATCH', '/api/work-orders/999999/signoff'],
      ['PATCH', '/api/work-orders/999999/final-payment'],
      ['GET', '/api/repair-quality/work-orders/999999/quality-history'],
    ]) {
      const r = await fetch(`${BASE}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method === 'GET' ? undefined : JSON.stringify({}),
      });
      expect([401, 403]).toContain(r.status);
    }
  });

  test('completed service records retain completion evidence', async () => {
    const cookie = await loginCookie();
    const init = await fetch(`${BASE}/api/repair-quality/work-orders/999999/readiness`, { headers: { Cookie: cookie } });
    expect([404, 403]).toContain(init.status);

    const rows = await api(cookie, '/api/work-orders?limit=200');
    expect(Array.isArray(rows)).toBe(true);
    for (const wo of rows.filter(w => ['complete', 'awaiting_pickup', 'picked_up'].includes(w.status))) {
      expect(wo.completed_at, `${wo.wo_number} is ${wo.status} without completed_at`).toBeTruthy();
    }
  });

  test('picked-up repairs with a positive final balance retain a final transaction', async () => {
    const cookie = await loginCookie();
    const rows = await api(cookie, '/api/work-orders?view=picked_up&limit=200');
    expect(Array.isArray(rows)).toBe(true);

    for (const wo of rows) {
      const balance = finalBalance(wo);
      if (balance <= 0) continue;
      expect(wo.final_transaction_id, `${wo.wo_number} was picked up with balance ${balance} but has no final transaction`).toBeTruthy();
      const tx = await api(cookie, `/api/transactions/${wo.final_transaction_id}`);
      expect(tx.status).not.toBe('voided');
      expect(Number(tx.total)).toBeCloseTo(balance, 2);
      expect(String(tx.notes || '')).toContain(String(wo.wo_number));
    }
  });

  test('awaiting-pickup records have not already been finalized as picked up', async () => {
    const cookie = await loginCookie();
    const rows = await api(cookie, '/api/work-orders?view=awaiting_pickup&limit=200');
    expect(Array.isArray(rows)).toBe(true);
    for (const wo of rows) {
      expect(wo.picked_up_at).toBeFalsy();
    }
  });
});
