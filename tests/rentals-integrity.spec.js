import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:3001';

async function loginCookie() {
  const r = await fetch(`${BASE}/api/employees/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.POS_TEST_USER || 'admin', password: process.env.POS_TEST_PASSWORD || '123456' }),
  });
  expect(r.status).toBe(200);
  return (r.headers.get('set-cookie') || '').split(';')[0];
}

async function api(cookie, path) {
  const r = await fetch(`${BASE}${path}`, { headers: { Cookie: cookie } });
  return { status: r.status, body: await r.json().catch(() => null) };
}

test.describe('Rental operations integrity', () => {
  test('rental read models require authentication', async () => {
    const list = await fetch(`${BASE}/api/rentals/agreements`);
    const availability = await fetch(`${BASE}/api/rentals/availability?product_id=1`);
    expect(list.status).toBe(401);
    expect(availability.status).toBe(401);
  });

  test('agreement queue exposes coherent operational fields without mutating records', async () => {
    const cookie = await loginCookie();
    const result = await api(cookie, '/api/rentals/agreements');
    expect(result.status).toBe(200);
    expect(Array.isArray(result.body)).toBe(true);

    for (const row of result.body) {
      expect(row.id).toBeTruthy();
      expect(row.agreement_number).toBeTruthy();
      expect(row.status).toBeTruthy();
      expect(row.display_status).toBeTruthy();
      expect(Number.isFinite(Number(row.item_count || 0))).toBe(true);
      expect(Number.isFinite(Number(row.balance_due || 0))).toBe(true);
      if (row.status === 'active' && row.is_paused) expect(row.display_status).toBe('paused');
    }
  });

  test('operational rental views remain queryable and return arrays', async () => {
    const cookie = await loginCookie();
    for (const view of ['active', 'overdue', 'pending', 'awaiting_issue', 'awaiting_payment', 'returned', 'cancelled']) {
      const result = await api(cookie, `/api/rentals/agreements?view=${view}`);
      expect(result.status).toBe(200);
      expect(Array.isArray(result.body)).toBe(true);
    }
  });

  test('missing agreement and invalid availability requests fail cleanly', async () => {
    const cookie = await loginCookie();
    const missingAgreement = await api(cookie, '/api/rentals/agreements/999999999');
    expect(missingAgreement.status).toBe(404);

    const missingProduct = await api(cookie, '/api/rentals/availability');
    expect(missingProduct.status).toBe(400);
    expect(missingProduct.body?.error).toMatch(/product_id is required/i);

    const unknownProduct = await api(cookie, '/api/rentals/availability?product_id=999999999');
    expect(unknownProduct.status).toBe(404);
  });

  test('agreement detail preserves item and pause collections when records exist', async () => {
    const cookie = await loginCookie();
    const list = await api(cookie, '/api/rentals/agreements');
    expect(list.status).toBe(200);
    if (!list.body.length) return;

    const detail = await api(cookie, `/api/rentals/agreements/${list.body[0].id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.id).toBe(list.body[0].id);
    expect(Array.isArray(detail.body.items)).toBe(true);
    expect(Array.isArray(detail.body.pauses)).toBe(true);
    expect(Number.isFinite(Number(detail.body.balance_due || 0))).toBe(true);
  });
});
