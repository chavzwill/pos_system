const { test, expect } = require('@playwright/test');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
let server, origin, posts, failNavigation;
const fixture = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="manifest" href="/manifest.webmanifest"><link rel="stylesheet" href="/ui-tokens.css"><link rel="stylesheet" href="/app-shell.css"></head><body><div id="shell-root" class="shell-app"><header class="shell-global-header"><span class="shell-mark">TT</span><strong>Total Tools</strong></header><aside class="shell-sidebar"><nav>Purchasing</nav><footer><button>Help & Learning</button><button>Sign out</button></footer></aside><main class="shell-main"><div class="shell-content"><h1>Purchase orders</h1><label>Draft notes <input id="draft" value="Keep this work"></label></div></main></div><script src="/app-lifecycle.js"></script></body></html>';
test.beforeEach(async () => {
  posts = 0; failNavigation = false;
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/fixture') { if (req.method === 'POST') posts++; res.setHeader('Content-Type', 'application/json'); return res.end('{"private":"supplier-balance"}'); }
    if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); if (failNavigation) { res.statusCode = 503; return res.end('Server unavailable'); } return res.end(fixture); }
    const file = path.join(__dirname, '../public', url.pathname);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
    res.setHeader('Content-Type', ({ '.js':'text/javascript', '.css':'text/css', '.html':'text/html', '.webmanifest':'application/manifest+json', '.png':'image/png' })[path.extname(file)] || 'text/plain');
    if (/^text\//.test(res.getHeader('Content-Type'))) res.setHeader('Content-Type', res.getHeader('Content-Type') + '; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
});
test.afterEach(async () => { await new Promise(resolve => server.close(resolve)); });

for (const width of [1440, 768, 390]) test('app options, keyboard and connection states at ' + width, async ({ page, context }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(origin);
  // The production shell's responsive drawer hides its footer until opened.
  if (width <= 900) await page.locator('#shell-root').evaluate(el => el.classList.add('menu-open'));
  await page.locator('#tt-app-options').click();
  const dialog = page.getByRole('dialog', { name: 'Total Tools app' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Add to Home Screen');
  await page.screenshot({ path: test.info().outputPath('app-options-' + width + '.png') });
  const box = await dialog.boundingBox(); expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible();
  await context.setOffline(true); await expect(page.locator('#tt-app-connection')).toBeVisible();
  await expect(page.locator('#draft')).toHaveValue('Keep this work');
  await context.setOffline(false); await expect(page.locator('#tt-app-connection')).not.toBeVisible();
});

test('install requires a user click and consumes a prompt once', async ({ page }) => {
  await page.goto(origin);
  await page.evaluate(() => {
    window.promptCalls = 0;
    const event = new Event('beforeinstallprompt', { cancelable: true });
    event.prompt = async () => { window.promptCalls++; };
    event.userChoice = Promise.resolve({ outcome: 'dismissed' });
    window.dispatchEvent(event);
  });
  expect(await page.evaluate(() => window.promptCalls)).toBe(0);
  await page.locator('#tt-app-options').click(); await page.getByRole('button', { name: 'Install Total Tools', exact: true }).click();
  expect(await page.evaluate(() => window.promptCalls)).toBe(1);
  await expect(page.locator('[data-install]')).not.toBeVisible();
});

test('worker caches only recovery page, leaves API writes online and never replays them', async ({ page, context }) => {
  await page.goto(origin);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await page.evaluate(async () => { await fetch('/api/fixture'); await fetch('/api/fixture', { method: 'POST', body: '{}' }); });
  expect(posts).toBe(1);
  const stored = await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async key => (await (await caches.open(key)).keys()).map(r => new URL(r.url).pathname)))).flat());
  expect(stored).toEqual(['/offline.html']);
  await context.setOffline(true);
  expect(await page.evaluate(() => fetch('/api/fixture', { method: 'POST', body: '{}' }).then(() => 'sent', () => 'failed'))).toBe('failed');
  await page.reload(); await expect(page.getByRole('heading', { name: 'Connect to continue' })).toBeVisible();
  await expect(page.getByText('check its status after reconnecting', { exact: false })).toBeVisible();
  await context.setOffline(false); await page.getByRole('link', { name: 'Try again' }).click();
  await expect(page.locator('#draft')).toBeVisible(); expect(posts).toBe(1);
  failNavigation = true; const response = await page.reload(); expect(response.status()).toBe(503);
  await expect(page.getByText('Server unavailable', { exact: true })).toBeVisible();
});

test('waiting update does not reload a draft or activate itself', async ({ page }) => {
  await page.addInitScript(() => {
    const waiting = { postMessage() { throw new Error('Must not force worker activation'); } };
    Object.defineProperty(navigator, 'serviceWorker', { value: { controller: {}, register: async () => ({ waiting, update: async () => {}, addEventListener() {} }) } });
  });
  await page.goto(origin);
  await expect(page.locator('#tt-app-options')).toContainText('update ready');
  await page.locator('#draft').fill('Unsubmitted purchase');
  await page.locator('#tt-app-options').click();
  await expect(page.locator('[data-update-status]')).toContainText('close all Total Tools windows');
  await page.getByRole('button', { name: 'Check for updates' }).click();
  await expect(page.locator('#draft')).toHaveValue('Unsubmitted purchase');
  await expect(page.locator('[data-update-status]')).toContainText('Update ready');
});

test('manifest names standalone app and all icons have declared dimensions', async ({ request }) => {
  const response = await request.get(origin + '/manifest.webmanifest'); const manifest = await response.json();
  expect(manifest.display).toBe('standalone'); expect(manifest.start_url).toBe('/'); expect(manifest.scope).toBe('/');
  for (const icon of manifest.icons) {
    const png = await (await request.get(origin + icon.src)).body();
    expect(png.toString('ascii', 1, 4)).toBe('PNG');
    expect(icon.sizes).toBe(png.readUInt32BE(16) + 'x' + png.readUInt32BE(20));
  }
});
