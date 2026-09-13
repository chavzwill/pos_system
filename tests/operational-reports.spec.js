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
      'sales-summary', 'payments', 'employee-sales',
      'inventory-movements', 'non-sale-reductions', 'damage-writeoff', 'stock-aging',
      'transfers', 'purchasing', 'supplier-performance', 'supplier-items', 'vendor-items', 'rentals', 'repairs', 'returns',
    ]));
    expect(body.every(x => x.group && x.label && x.description)).toBe(true);
    expect(body.find(x => x.id === 'inventory-movements')?.label).toBe('Stock Movement History');
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

  test('core staff reports return structured results', async () => {
    const cookie = await loginCookie();
    for (const report of ['sales-summary','payments','employee-sales']) {
      const r = await fetch(`${BASE}/api/operational-reports/${report}?start=2026-01-01&end=2026-12-31`, { headers: { Cookie: cookie } });
      expect(r.status, report).toBe(200);
      const body = await r.json();
      expect(body, report).toHaveProperty('summary');
      expect(Array.isArray(body.rows), report).toBe(true);
    }
  });

  test('supplier reporting exposes commercial and service performance', async () => {
    const cookie = await loginCookie();
    const performance = await fetch(`${BASE}/api/operational-reports/supplier-performance?start=2026-01-01&end=2026-12-31`, { headers: { Cookie: cookie } });
    expect(performance.status).toBe(200);
    const pbody = await performance.json();
    expect(Array.isArray(pbody.rows)).toBe(true);
    for (const row of pbody.rows) {
      for (const field of ['on_time_rate','fill_rate','quality_acceptance_rate','customer_return_rate','overall_rating_score','supplier_rating','sales_value','estimated_gross_profit']) expect(row).toHaveProperty(field);
    }
    const items = await fetch(`${BASE}/api/operational-reports/supplier-items?start=2026-01-01&end=2026-12-31`, { headers: { Cookie: cookie } });
    expect(items.status).toBe(200);
    expect(Array.isArray((await items.json()).rows)).toBe(true);
  });

  test('reports open as a human-readable report center', async ({ page }) => {
    await loginShell(page);
    await page.evaluate(async()=>window.TotalToolsShellOpen('operational-reports','Reports'));
    await expect(page.locator('#tt-op-reports-title')).toHaveText('Reports');
    await expect(page.getByRole('button',{name:/Sales Summary/i})).toBeVisible();
    await expect(page.getByRole('button',{name:/Payments by Method/i})).toBeVisible();
    await expect(page.getByRole('button',{name:/Sales by Employee/i})).toBeVisible();
    await expect(page.locator('#tt-op-reports-root')).not.toContainText('Inventory Intelligence');
  });
});
