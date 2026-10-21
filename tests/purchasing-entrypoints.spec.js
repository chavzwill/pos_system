import { test, expect } from '@playwright/test';

async function login(page){
  await page.goto('/app-shell.html?workflow-entrypoint-test=1');
  const login=page.locator('#shell-login');
  if(await login.count()){
    await login.locator('input[name="username"]').fill(process.env.POS_TEST_USER||'admin');
    await login.locator('input[name="password"]').fill(process.env.POS_TEST_PASSWORD||'123456');
    await login.locator('button[type="submit"],button').first().click();
  }
  await expect(page.locator('.shell-app')).toBeVisible({timeout:10000});
}

async function openPurchasingDomain(page){
  const purchasing=page.locator('.shell-nav [data-domain="purchasing"]');
  await expect(purchasing).toBeVisible();
  await purchasing.click();
  await expect(purchasing).toHaveClass(/is-active/);
}


async function assertComposerInViewport(page,title){
  const composer=page.locator('.tt-purch__composer');
  await expect(composer).toBeVisible({timeout:5000});
  await expect(page.locator('#tt-purch-compose-title')).toHaveText(title);
  const box=await composer.boundingBox();
  expect(box).not.toBeNull();
  const viewport=page.viewportSize();
  expect(viewport).not.toBeNull();
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.y).toBeGreaterThanOrEqual(-1);
  expect(box.x+box.width).toBeLessThanOrEqual(viewport.width+1);
  expect(box.y).toBeLessThan(viewport.height);
  expect(await composer.evaluate(el=>getComputedStyle(el).position)).toBe('fixed');
}

async function cardAction(page,title){
  const button=page.locator(`[data-open="purchasing-workspace"][data-title="${title}"]`).first();
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute('data-title',title);
  await button.click();
  await expect(page.locator('#tt-purchasing-workspace')).toBeVisible({timeout:10000});
}

test.describe('Purchasing shell entry points',()=>{
  test('Create Purchase Request card opens the request composer directly',async({page})=>{
    await login(page);
    await openPurchasingDomain(page);
    await cardAction(page,'Create Purchase Request');
    await expect(page.locator('.tt-purch__composer')).toBeVisible({timeout:5000});
    await expect(page.locator('#tt-purch-compose-title')).toHaveText('Create Purchase Request');
  });

  test('Create Purchase Order card opens the order composer directly',async({page})=>{
    await login(page);
    await openPurchasingDomain(page);
    await cardAction(page,'Create Purchase Order');
    await expect(page.locator('.tt-purch__composer')).toBeVisible({timeout:5000});
    await expect(page.locator('#tt-purch-compose-title')).toHaveText('Create Purchase Order');
  });

  test('Purchase Requests card opens requests and New Purchase Request opens composer',async({page})=>{
    await login(page);
    await openPurchasingDomain(page);
    await cardAction(page,'Purchase Requests');
    await expect(page.locator('#tt-purchasing-workspace [data-tab="pr"]')).toHaveClass(/is-active/);
    await expect(page.locator('#tt-purch-new-pr')).toBeVisible();
    await page.locator('#tt-purch-new-pr').click();
    await assertComposerInViewport(page,'Create Purchase Request');
  });

  test('Purchase Orders card opens orders and New Purchase Order opens composer',async({page})=>{
    await login(page);
    await openPurchasingDomain(page);
    await cardAction(page,'Purchase Orders');
    await expect(page.locator('#tt-purchasing-workspace [data-tab="po"]')).toHaveClass(/is-active/);
    await expect(page.locator('#tt-purch-new-po')).toBeVisible();
    await page.locator('#tt-purch-new-po').click();
    await assertComposerInViewport(page,'Create Purchase Order');
  });

  test('Guide Me exact-action script is loaded with the current workflow cache key',async({page})=>{
    await login(page);
    await page.waitForFunction(()=>!!window.TotalToolsGuideMe?.openTask,{timeout:10000});
    const urls=await page.evaluate(()=>performance.getEntriesByType('resource').map(e=>e.name));
    expect(urls.some(url=>url.includes('/guided-mode-exact-action.js?v=20261021-workflow-fix2'))).toBeTruthy();
  });
});
