import { test, expect } from '@playwright/test';

async function login(page) {
  await page.goto('/');
  await page.fill('#login-user', 'admin');
  await page.fill('#login-pass', '123456');
  await page.click('button.login-btn');
  await expect(page.locator('.stat-card').first()).toBeVisible({ timeout: 8_000 });
}

test.describe('Total Tools Guided Mode', () => {
  test('native theme and Guided Mode assets load', async ({ page }) => {
    await login(page);
    await expect(page.locator('#tt-guide-launcher')).toBeVisible();
    await expect(page.locator('link[href="/total-tools-pos.css"]')).toHaveCount(1);
    await expect(page.locator('script[src="/guided-mode.js"]')).toHaveCount(1);
  });

  test('opens, accepts a natural-language task and provides steps', async ({ page }) => {
    await login(page);
    await page.click('#tt-guide-launcher');
    await expect(page.locator('#tt-guided-mode [role="dialog"]')).toBeVisible();
    await page.fill('#tt-guide-input', 'I want to create a rental');
    await page.click('[data-guide-search] button[type="submit"]');
    await expect(page.locator('.tt-guide__step-count')).toContainText('Step 1');
    await expect(page.locator('.tt-guide__step')).toContainText(/Rental|rentals/i);
  });

  test('can be closed with Escape', async ({ page }) => {
    await login(page);
    await page.click('#tt-guide-launcher');
    await page.keyboard.press('Escape');
    await expect(page.locator('#tt-guided-mode')).toHaveCount(0);
  });
});
