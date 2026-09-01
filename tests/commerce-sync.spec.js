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

test.describe('SmartCommerce commerce sync contract', () => {
  test('requires authentication', async () => {
    const r = await fetch(`${BASE}/api/commerce-sync/catalog`);
    expect(r.status).toBe(401);
  });

  test('catalog exposes commerce-safe product data without internal cost', async () => {
    const cookie = await loginCookie();
    const r = await fetch(`${BASE}/api/commerce-sync/catalog`, { headers: { Cookie: cookie } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toHaveProperty('contract_version');
    expect(Array.isArray(body.products)).toBe(true);
    expect(body.products.length).toBeGreaterThan(0);
    const p = body.products[0];
    expect(p).toHaveProperty('sku');
    expect(p).toHaveProperty('price');
    expect(p).toHaveProperty('online_available');
    expect(p).toHaveProperty('branches');
    expect(p).not.toHaveProperty('cost');
    for (const branch of p.branches) expect(branch).not.toHaveProperty('cost');
  });

  test('availability returns branch stock and online sellable quantity', async () => {
    const cookie = await loginCookie();
    const catalog = await fetch(`${BASE}/api/commerce-sync/catalog`, { headers: { Cookie: cookie } }).then(r => r.json());
    const p = catalog.products.find(x => x.sku);
    expect(p).toBeTruthy();
    const r = await fetch(`${BASE}/api/commerce-sync/availability/${encodeURIComponent(p.sku)}`, { headers: { Cookie: cookie } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.product.sku).toBe(p.sku);
    expect(Array.isArray(body.availability)).toBe(true);
    for (const branch of body.availability) {
      expect(branch).toHaveProperty('stock_qty');
      expect(branch).toHaveProperty('sellable_online_qty');
      expect(branch).toHaveProperty('price');
    }
  });
});
