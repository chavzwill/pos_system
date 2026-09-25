import { test, expect } from '@playwright/test';

const widths = [1440, 1280, 1024, 768, 430, 390, 375];
async function login(page) {
  await page.goto('/app-shell.html');
  await expect(page.locator('#shell-login')).toBeVisible();
  await page.locator('[name=username]').fill(process.env.POS_TEST_USER || 'admin');
  await page.locator('[name=password]').fill(process.env.POS_TEST_PASSWORD || '123456');
  await page.locator('#shell-login button').click();
  await expect(page.locator('.shell-app')).toBeVisible();
}

for (const width of widths) {
  test(`shell and product dialogs remain usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await login(page);
    const opener = page.locator('#shell-command-button');
    await opener.click();
    const command = page.getByRole('dialog', { name: 'Quick Command' });
    await expect(page.locator('#shell-command-input')).toBeFocused();
    const commandControls = command.locator('input:visible,button:visible');
    await commandControls.last().focus();
    await page.keyboard.press('Tab');
    await expect(commandControls.first()).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(commandControls.last()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(command).toHaveCount(0);
    await expect(opener).toBeFocused();

    const openRequest = () => page.evaluate(() => {
      window.__shellTestResult = 'pending';
      window.TotalToolsShellUI.request({ title: 'Verification input', message: 'Record test evidence', fields: [{ name: 'evidence', label: 'Evidence', required: true }] })
        .then(result => { window.__shellTestResult = result; });
    });
    await openRequest();
    const dialog = page.getByRole('dialog', { name: 'Verification input' });
    const field = dialog.getByLabel('Evidence', { exact: true });
    await expect(field).toBeFocused();
    await expect(dialog).toHaveAccessibleDescription('Record test evidence');
    const controls = dialog.locator('input:visible,button:visible');
    await page.keyboard.press('Shift+Tab');
    await expect(controls.last()).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(field).toBeFocused();
    const bounds = await dialog.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    expect(await page.evaluate(() => window.__shellTestResult)).toBeNull();
    await openRequest();
    await expect(field).toBeFocused();
    await field.fill('verified');
    await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(await page.evaluate(() => window.__shellTestResult)).toEqual({ evidence: 'verified' });
    await expect(opener).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    const guide = page.getByRole('button', { name: 'Open Guide Me', exact: true }).filter({ visible: true });
    if (await guide.count()) {
      const rect = await guide.first().boundingBox();
      expect(rect.width).toBeGreaterThanOrEqual(44);
      expect(rect.x + rect.width).toBeLessThanOrEqual(width + 1);
    }
  });

  test(`major workspace layouts fit ${width}px`, async ({ page }) => {
    test.setTimeout(120000);
    await page.setViewportSize({ width, height: 900 });
    await login(page);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    for (const key of ['sales-workspace','inventory-workspace','purchasing-workspace','rentals-workspace','quotations-workspace','work-orders-workspace','customer-crm-workspace','admin-workspace','logistics-intelligence','accounting-ledger']) {
      await page.goto('/app-shell.html');
      await expect(page.locator('.shell-app')).toBeVisible();
      await page.evaluate(key => window.TotalToolsWorkspaceLoader.open(key), key);
      expect(errors, key).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth), key).toBeLessThanOrEqual(width + 1);
    }
  });
}
