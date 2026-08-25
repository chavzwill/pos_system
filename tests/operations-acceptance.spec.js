import { test, expect } from '@playwright/test';

async function loginToOperationsShell(page) {
  await page.goto('/app-shell.html');
  const login = page.locator('#shell-login');
  if (await login.count()) {
    await login.locator('input[name="username"]').fill(process.env.POS_TEST_USER || 'admin');
    await login.locator('input[name="password"]').fill(process.env.POS_TEST_PASSWORD || '123456');
    await login.locator('button[type="submit"], button').first().click();
  }
  await expect(page.locator('.shell-app')).toBeVisible({ timeout: 10_000 });
}

function collectRuntimeFailures(page) {
  const failures = [];
  page.on('pageerror', error => failures.push(`pageerror: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') failures.push(`console: ${message.text()}`);
  });
  page.on('requestfailed', request => failures.push(`requestfailed: ${request.method()} ${request.url()} ${request.failure()?.errorText || ''}`));
  return failures;
}

test.describe('Total Tools Operations acceptance', () => {
  test('role-aware shell, navigation and operational registry are healthy', async ({ page }) => {
    const failures = collectRuntimeFailures(page);
    await loginToOperationsShell(page);

    const domains = page.locator('.shell-nav [data-domain]');
    const cards = page.locator('.shell-card');
    await expect(domains).not.toHaveCount(0);
    await expect(cards).not.toHaveCount(0);

    const domainCount = await domains.count();
    for (let i = 0; i < domainCount; i += 1) {
      const button = domains.nth(i);
      await button.click();
      await expect(button).toHaveClass(/is-active/);
      await expect(page.locator('#shell-grid')).toBeVisible();
      await expect(page.locator('#shell-title')).not.toBeEmpty();
    }

    expect(failures, failures.join('\n')).toEqual([]);
  });

  test('system health validates real authenticated payloads', async ({ page }) => {
    const failures = collectRuntimeFailures(page);
    await loginToOperationsShell(page);

    const healthButton = page.getByRole('button', { name: /system health/i });
    await expect(healthButton).toBeVisible({ timeout: 8_000 });
    await healthButton.click();

    const dialog = page.getByRole('dialog', { name: /system health & operational readiness/i });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/business records remain untouched|never create, update, delete or simulate/i)).toBeVisible();

    await expect(dialog.locator('.tt-mr__checks article').first()).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByText(/DEGRADED/)).toHaveCount(0);
    await expect(dialog.locator('.is-fail')).toHaveCount(0);

    const checkNames = await dialog.locator('.tt-mr__checks article strong').allTextContents();
    expect(checkNames).toEqual(expect.arrayContaining([
      'Operations shell runtime',
      'Role-aware permission navigation',
      'Operational workspace registry',
      'Guided Mode runtime',
      'Workspace profile & permissions',
      'ERP operational intelligence',
      'Accounting intelligence',
      'Technician management intelligence',
    ]));

    expect(failures, failures.join('\n')).toEqual([]);
  });

  test('major workflow workspaces initialize through the hardened loader', async ({ page }) => {
    const failures = collectRuntimeFailures(page);
    await loginToOperationsShell(page);

    const targets = [
      ['sales-workspace','TotalToolsSalesWorkspace'],
      ['held-sales-workspace','TotalToolsHeldSalesWorkspace'],
      ['cashier-controls-workspace','TotalToolsCashierControls'],
      ['quotations-workspace','TotalToolsQuotationsWorkspace'],
      ['work-orders-workspace','TotalToolsWorkOrdersWorkspace'],
      ['rentals-workspace','TotalToolsRentalsWorkspace'],
      ['inventory-workspace','TotalToolsInventoryWorkspace'],
      ['purchasing-workspace','TotalToolsPurchasingWorkspace'],
      ['transfers-workspace','TotalToolsTransfersWorkspace'],
      ['operational-reports','TotalToolsOperationalReports'],
      ['logistics-intelligence','TotalToolsLogisticsIntelligence'],
      ['inventory-intelligence','TotalToolsInventoryIntelligence'],
      ['accounting-intelligence','TotalToolsAccountingIntelligence'],
    ];

    for (const [key, global] of targets) {
      const result = await page.evaluate(async ({ key, global }) => {
        if (!window.TotalToolsShellOpen) return { ok:false, error:'TotalToolsShellOpen unavailable' };
        try {
          await window.TotalToolsShellOpen(key, key);
          return { ok:Boolean(window[global]?.open), error:null };
        } catch (error) {
          return { ok:false, error:String(error?.message || error) };
        }
      }, { key, global });
      expect(result.ok, `${key}: ${result.error || 'workspace API did not register'}`).toBeTruthy();
      await page.keyboard.press('Escape');
    }

    expect(failures, failures.join('\n')).toEqual([]);
  });
});
