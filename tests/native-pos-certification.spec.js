import { test, expect } from '@playwright/test';
import { TEST_BASE_URL as BASE } from './test-base-url.js';

const USER = process.env.POS_TEST_USER || 'admin';
const PASSWORD = process.env.POS_TEST_PASSWORD || '123456';

async function login() {
  const response = await fetch(`${BASE}/api/employees/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASSWORD }),
  });
  expect(response.status).toBe(200);
  return (response.headers.get('set-cookie') || '').split(';')[0];
}

async function get(cookie, path) {
  const response = await fetch(`${BASE}${path}`, {
    headers: cookie ? { Cookie: cookie, Accept: 'application/json' } : { Accept: 'application/json' },
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

test.describe('Native POS production certification', () => {
  test('runtime manifest proves the POS owns its frontend and server', async () => {
    const response = await fetch(`${BASE}/pos-runtime.json`);
    expect(response.status).toBe(200);
    const runtime = await response.json();
    expect(runtime).toMatchObject({
      product: 'Total Tools POS',
      runtime: 'native-pos',
      frontend: 'pos-owned',
      server: 'pos-owned',
      apiBase: '/api',
      sameOrigin: true,
      externalCommerceRuntimeRequired: false,
    });
  });

  test('major POS domains reject anonymous reads', async () => {
    const protectedReads = [
      '/api/workspace-profile/me',
      '/api/products?active=1',
      '/api/work-orders?limit=1',
      '/api/rentals/agreements',
      '/api/purchase-orders',
      '/api/logistics-intelligence/command-center',
      '/api/accounting-intelligence/overview',
      '/api/crm/dashboard',
      '/api/employees',
      '/api/branches',
      '/api/security-groups',
    ];

    for (const path of protectedReads) {
      const result = await get('', path);
      expect(result.status, `${path} must reject anonymous access`).toBe(401);
    }
  });

  test('authenticated native domain surfaces are reachable from one POS server', async () => {
    const cookie = await login();
    const checks = [
      ['/api/workspace-profile/me', body => expect(body.permissions).toBeTruthy()],
      ['/api/products?active=1', body => expect(Array.isArray(body)).toBe(true)],
      ['/api/work-orders?limit=5', body => expect(Array.isArray(body)).toBe(true)],
      ['/api/rentals/agreements', body => expect(Array.isArray(body)).toBe(true)],
      ['/api/purchase-orders', body => expect(Array.isArray(body)).toBe(true)],
      ['/api/logistics-intelligence/command-center', body => expect(body.summary).toBeTruthy()],
      ['/api/accounting-intelligence/overview', body => expect(body.sales).toBeTruthy()],
      ['/api/customers?active=1', body => expect(Array.isArray(body)).toBe(true)],
      ['/api/employees', body => expect(Array.isArray(body)).toBe(true)],
      ['/api/branches', body => expect(Array.isArray(body)).toBe(true)],
    ];

    for (const [path, assertion] of checks) {
      const result = await get(cookie, path);
      expect(result.status, `${path} must be reachable through the native POS server`).toBe(200);
      assertion(result.body);
    }
  });

  test('native app shell loads modernization assets without an external commerce runtime', async ({ page }) => {
    await page.goto('/app-shell.html');
    const html = await page.content();
    const requiredAssets = [
      'native-pos-shell',
      'native-sales-modernization',
      'native-repairs-modernization',
      'native-rentals-modernization',
      'native-dispatch-modernization',
      'native-inventory-modernization',
      'native-purchasing-modernization',
      'native-finance-modernization',
      'native-crm-modernization',
      'native-admin-modernization',
    ];
    for (const asset of requiredAssets) expect(html).toContain(asset);
    expect(html.toLowerCase()).not.toContain('smartcommerce runtime');
  });
});
