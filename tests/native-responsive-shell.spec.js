const { test, expect } = require('@playwright/test');

const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'compact-desktop', width: 1024, height: 768 },
  { name: 'tablet-portrait', width: 768, height: 1024 },
  { name: 'phone', width: 390, height: 844 },
];

for (const viewport of viewports) {
  test(`native shell remains usable without horizontal overflow at ${viewport.name}`, async ({ page, baseURL }) => {
    const brokenAssets = [];
    const expectedOrigin = new URL(baseURL).origin;
    page.on('response', response => {
      const url = new URL(response.url());
      const isOwnedAsset = url.origin === expectedOrigin && /\.(?:css|js|png|jpg|jpeg|svg|webp|ico)$/i.test(url.pathname);
      if (isOwnedAsset && response.status() >= 400) brokenAssets.push(`${response.status()} ${url.pathname}`);
    });

    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const response = await page.goto('/', { waitUntil: 'domcontentloaded' });
    expect(response && response.ok()).toBeTruthy();

    await expect(page.locator('meta[name="pos-runtime"]')).toHaveAttribute('content', 'native-pos');
    await expect(page.locator('#shell-root')).toBeVisible();
    await expect(page).toHaveTitle(/Total Tools POS/i);

    await page.waitForTimeout(500);
    const geometry = await page.evaluate(() => ({
      innerWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
    }));

    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.innerWidth + 2);
    expect(geometry.bodyWidth).toBeLessThanOrEqual(geometry.innerWidth + 2);
    expect(brokenAssets, `broken native assets at ${viewport.name}`).toEqual([]);
  });
}
