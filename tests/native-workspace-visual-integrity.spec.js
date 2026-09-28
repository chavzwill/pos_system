import { test, expect } from '@playwright/test';

const user = process.env.POS_TEST_USER || 'admin';
const password = process.env.POS_TEST_PASSWORD || '123456';

// Responsive certification deliberately includes breakpoint edges, common POS/laptop
// resolutions, phones in both orientations, tablets, large desktops and ultrawide.
const VIEWPORTS = [
  { name: 'small-phone-portrait', width: 320, height: 568 },
  { name: 'phone-360', width: 360, height: 640 },
  { name: 'phone-375', width: 375, height: 667 },
  { name: 'phone-390', width: 390, height: 844 },
  { name: 'large-phone-portrait', width: 430, height: 932 },
  { name: 'small-phone-landscape', width: 568, height: 320 },
  { name: 'phone-landscape', width: 844, height: 390 },
  { name: 'small-tablet-portrait', width: 600, height: 960 },
  { name: 'tablet-portrait', width: 768, height: 1024 },
  { name: 'large-tablet-portrait', width: 820, height: 1180 },
  { name: 'tablet-landscape', width: 1024, height: 768 },
  { name: 'large-tablet-landscape', width: 1180, height: 820 },
  { name: 'small-laptop', width: 1024, height: 700 },
  { name: 'laptop-1280', width: 1280, height: 720 },
  { name: 'laptop-1366', width: 1366, height: 768 },
  { name: 'desktop-1440', width: 1440, height: 900 },
  { name: 'desktop-1536', width: 1536, height: 864 },
  { name: 'full-hd', width: 1920, height: 1080 },
  { name: 'qhd', width: 2560, height: 1440 },
];

async function login(page) {
  await page.goto('/');
  const form = page.locator('#shell-login');
  if (await form.count()) {
    await form.locator('input[name="username"]').fill(user);
    await form.locator('input[name="password"]').fill(password);
    await form.locator('button[type="submit"],button').first().click();
  }
  if (await page.locator('#tt-password-change').count()) {
    test.skip(true, 'Use a non-forced-password POS_TEST_USER for visual certification.');
  }
  await expect(page.locator('.shell-app')).toBeVisible({ timeout: 12_000 });
}

function captureRuntimeFailures(page) {
  const failures = [];
  page.on('pageerror', error => failures.push(`pageerror: ${error.stack || error.message}`));
  page.on('console', message => {
    if (message.type() === 'error' && !/favicon/i.test(message.text())) failures.push(`console: ${message.text()}`);
  });
  page.on('requestfailed', request => failures.push(`requestfailed: ${request.method()} ${request.url()} ${request.failure()?.errorText || ''}`));
  page.on('response', response => {
    if (response.status() >= 500 && response.url().includes('/api/')) {
      failures.push(`http ${response.status()}: ${response.request().method()} ${response.url()}`);
    }
  });
  return failures;
}

async function closeTransientSurfaces(page) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.evaluate(() => {
    document.getElementById('tt-workspace-load-error')?.remove();
    document.getElementById('tt-runtime-error-banner')?.remove();
    document.querySelector('.tt-shell-recovery')?.remove();
  });
}

async function visualSnapshot(page) {
  return page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    const rootOverflow = Math.max(0, document.documentElement.scrollWidth - viewportWidth);
    const bodyOverflow = Math.max(0, document.body.scrollWidth - viewportWidth);

    const visible = element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
    };

    const severeClipping = [];
    const fixedOrDialog = [...document.querySelectorAll('[role="dialog"], dialog[open], [class*="overlay"], [class*="panel"], [class*="drawer"]')]
      .filter(visible)
      .slice(0, 160);

    for (const element of fixedOrDialog) {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const fixedLike = style.position === 'fixed' || style.position === 'absolute' || element.getAttribute('role') === 'dialog' || element.tagName === 'DIALOG';
      if (!fixedLike) continue;
      const clippedX = Math.max(0, -rect.left) + Math.max(0, rect.right - viewportWidth);
      const clippedY = Math.max(0, -rect.top) + Math.max(0, rect.bottom - viewportHeight);
      if (clippedX > 24 || clippedY > Math.max(64, viewportHeight * 0.2)) {
        severeClipping.push({
          tag: element.tagName,
          id: element.id || '',
          className: String(element.className || '').slice(0, 160),
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
          clippedX: Math.round(clippedX),
          clippedY: Math.round(clippedY),
        });
      }
    }

    const tinyTargets = [];
    const actionable = [...document.querySelectorAll('button:not([disabled]),a[href],input:not([type="hidden"]),select,textarea,[role="button"]')]
      .filter(visible)
      .slice(0, 650);
    for (const element of actionable) {
      const rect = element.getBoundingClientRect();
      if (rect.width < 24 || rect.height < 24) {
        tinyTargets.push({
          tag: element.tagName,
          text: (element.getAttribute('aria-label') || element.textContent || element.getAttribute('name') || '').trim().slice(0, 80),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
      }
    }

    const unreadableText = [];
    const textNodes = [...document.querySelectorAll('small,label,button,th,td,p,span')].filter(visible).slice(0, 1000);
    for (const element of textNodes) {
      const text = (element.textContent || '').trim();
      if (!text) continue;
      const size = parseFloat(getComputedStyle(element).fontSize || '0');
      if (size > 0 && size < 9) unreadableText.push({ text: text.slice(0, 80), size });
    }

    return {
      rootOverflow,
      bodyOverflow,
      severeClipping: severeClipping.slice(0, 16),
      tinyTargets: tinyTargets.slice(0, 24),
      unreadableText: unreadableText.slice(0, 24),
      activeWorkspace: document.documentElement.dataset.ttActiveWorkspace || '',
    };
  });
}

for (const viewport of VIEWPORTS) {
  test(`every native workspace remains usable at ${viewport.name} ${viewport.width}x${viewport.height}`, async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const runtimeFailures = captureRuntimeFailures(page);
    await login(page);

    const workspaceKeys = await page.evaluate(() => Object.keys(window.TotalToolsWorkspaceLoader?.assets || {}));
    expect(workspaceKeys.length).toBeGreaterThan(35);

    const failures = [];
    for (const key of workspaceKeys) {
      await closeTransientSurfaces(page);
      const opened = await page.evaluate(async workspaceKey => {
        try {
          await window.TotalToolsShellOpen(workspaceKey, workspaceKey);
          return { ok: true };
        } catch (error) {
          return { ok: false, error: error?.stack || error?.message || String(error) };
        }
      }, key);

      if (!opened.ok) {
        failures.push({ key, kind: 'open-failed', detail: opened.error });
        continue;
      }

      await page.waitForTimeout(80);
      const snapshot = await visualSnapshot(page);
      if (snapshot.activeWorkspace !== key) failures.push({ key, kind: 'wrong-active-workspace', detail: snapshot.activeWorkspace });
      if (snapshot.rootOverflow > 4 || snapshot.bodyOverflow > 4) failures.push({ key, kind: 'horizontal-overflow', detail: snapshot });
      if (snapshot.severeClipping.length) failures.push({ key, kind: 'severe-clipping', detail: snapshot.severeClipping });
      if (snapshot.tinyTargets.length) failures.push({ key, kind: 'tiny-targets', detail: snapshot.tinyTargets });
      if (snapshot.unreadableText.length) failures.push({ key, kind: 'sub-9px-text', detail: snapshot.unreadableText });

      if (await page.locator('#tt-workspace-load-error').count()) failures.push({ key, kind: 'workspace-recovery-visible' });
      if (await page.locator('.tt-shell-recovery').count()) failures.push({ key, kind: 'shell-recovery-visible' });
      if (await page.locator('#tt-runtime-error-banner').count()) failures.push({ key, kind: 'runtime-error-banner-visible' });
    }

    expect(runtimeFailures, runtimeFailures.join('\n')).toEqual([]);
    expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
  });
}
