import { test, expect } from '@playwright/test';

const ADMIN_USER = process.env.POS_TEST_USER || 'admin';
const ADMIN_PASSWORD = process.env.POS_TEST_PASSWORD || 'CI-Test-Auth!2026';

async function loginShell(page) {
  await page.goto('/app-shell.html');
  const loginForm = page.locator('#shell-login');
  if (await loginForm.count()) {
    await loginForm.locator('input[name="username"]').fill(ADMIN_USER);
    await loginForm.locator('input[name="password"]').fill(ADMIN_PASSWORD);
    await loginForm.locator('button[type="submit"], button').first().click();
  }
  await expect(page.locator('.shell-app')).toBeVisible({ timeout: 10_000 });
}

async function openFirstEmployee(page) {
  await page.addScriptTag({ url: '/admin-workspace.js' });
  await page.evaluate(() => window.TotalToolsAdminWorkspace.open());
  const employeeCard = page.locator('.tt-admin-card [data-edit-employee]').first();
  await expect(employeeCard).toBeVisible({ timeout: 10_000 });
  await employeeCard.click();
}

test.describe('Administration credential UI', () => {
  test('existing employee profile cannot directly edit password or PIN', async ({ page }) => {
    await loginShell(page);
    await openFirstEmployee(page);
    await expect(page.locator('#tt-admin-employee-form input[name="password"]')).toHaveCount(0);
    await expect(page.locator('#tt-admin-employee-form input[name="pin"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /reset password securely/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /reset pin securely/i })).toBeVisible();
  });

  test('protected PIN reset collects new PIN, admin reauthentication, and reason', async ({ page }) => {
    await loginShell(page);
    await openFirstEmployee(page);
    await page.getByRole('button', { name: /reset pin securely/i }).click();
    const form = page.locator('#tt-admin-pin-reset-form');
    await expect(form).toBeVisible();
    await expect(form.locator('input[name="pin"]')).toBeVisible();
    await expect(form.locator('input[name="reauth_password"]')).toBeVisible();
    await expect(form.locator('textarea[name="reason"]')).toBeVisible();
    await expect(form.getByRole('button', { name: /reset pin & revoke sessions/i })).toBeVisible();
  });
});