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

test.describe('Operational reports', () => {
  test('requires authentication and reports permission', async () => {
    const r = await fetch(`${BASE}/api/operational-reports/catalog`);
    expect(r.status).toBe(401);
  });

  test('catalog exposes the native operational report families', async () => {
    const cookie = await loginCookie();
    const r = await fetch(`${BASE}/api/operational-reports/catalog`, { headers: { Cookie: cookie } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.map(x => x.id)).toEqual(expect.arrayContaining([
      'inventory-movements', 'non-sale-reductions', 'damage-writeoff', 'stock-aging',
      'transfers', 'purchasing', 'vendor-items', 'rentals', 'repairs', 'returns',
    ]));
  });

  test('native Operational Reports workspace assets are injected', async ({ page }) => {
    await page.goto('/');
    await page.fill('#login-user', 'admin');
    await page.fill('#login-pass', '123456');
    await page.click('button.login-btn');
    await expect(page.locator('#tt-op-reports-launcher')).toBeVisible({ timeout: 8_000 });
    await expect(page.locator('link[href="/operational-reports.css"]')).toHaveCount(1);
    await expect(page.locator('script[src="/operational-reports.js"]')).toHaveCount(1);
  });

  test('inventory movement report returns a structured result', async () => {
    const cookie = await loginCookie();
    const r = await fetch(`${BASE}/api/operational-reports/inventory-movements?start=2026-01-01&end=2026-12-31`, { headers: { Cookie: cookie } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toHaveProperty('totals');
    expect(Array.isArray(body.rows)).toBe(true);
  });
});
