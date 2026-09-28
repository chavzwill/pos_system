import { test, expect } from '@playwright/test';

async function login(page) {
  await page.goto('/app-shell.html');
  await page.locator('[name=username]').fill(process.env.POS_TEST_USER || 'admin');
  await page.locator('[name=password]').fill(process.env.POS_TEST_PASSWORD || '123456');
  await page.locator('#shell-login button').click();
  await expect(page.locator('.shell-app')).toBeVisible();
  await page.waitForFunction(() => !!window.TotalToolsGuideMe?.open);
}

test.describe('Total Tools Guide Me', () => {
  test('native theme and Guide Me assets load', async ({ page }) => {
    await login(page);
    await expect(page.locator('#shell-guide')).toBeVisible();
    await expect(page.locator('link[href*="/unified-ui-system.css"]')).toHaveCount(1);
    await expect(page.locator('script[src*="/guided-mode.js"]')).toHaveCount(1);
  });

  test('opens, accepts a natural-language task and provides steps', async ({ page }) => {
    await login(page);
    await page.click('#shell-guide');
    await expect(page.locator('#tt-guided-mode [role="dialog"]')).toBeVisible();
    await page.fill('#tt-guide-input', 'I want to create a rental');
    await page.click('[data-guide-search] button[type="submit"]');
    await expect(page.locator('.tt-guide__step-count')).toContainText('Step 1');
    await expect(page.locator('.tt-guide__step')).toContainText(/Rental|rentals/i);
  });

  test('can be closed with Escape', async ({ page }) => {
    await login(page);
    await page.click('#shell-guide');
    await page.keyboard.press('Escape');
    await expect(page.locator('#tt-guided-mode')).toHaveCount(0);
    await expect(page.locator('#shell-guide')).toBeFocused();
  });
});
