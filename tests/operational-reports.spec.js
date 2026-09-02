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

async function loginShell(page){
  await page.goto('/app-shell.html');
  const form=page.locator('#shell-login');
  if(await form.count()){
    await form.locator('input[name="username"]').fill(TEST_USER);
    await form.locator('input[name="password"]').fill(TEST_PASSWORD);
    await form.locator('button').first().click();
  }
  await expect(page.locator('.shell-app')).toBeVisible({timeout:10_000});
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

  test('native Operational Reports workspace assets load through the fast shell', async ({ page }) => {
    await loginShell(page);
    const opened=await page.evaluate(async()=>{
      if(typeof window.TotalToolsShellOpen!=='function')return false;
      await window.TotalToolsShellOpen('operational-reports','Reports');
      return typeof window.TotalToolsOperationalReports?.open==='function';
    });
    expect(opened).toBe(true);
    await expect(page.locator('link[href^="/operational-reports.css"]')).toHaveCount(1);
    await expect(page.locator('script[src^="/operational-reports.js"]')).toHaveCount(1);
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
