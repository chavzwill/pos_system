import { test, expect } from '@playwright/test';

async function login(page){
  await page.goto('/app-shell.html');
  const login=page.locator('#shell-login');
  if(await login.count()){
    await login.locator('input[name="username"]').fill(process.env.POS_TEST_USER||'admin');
    await login.locator('input[name="password"]').fill(process.env.POS_TEST_PASSWORD||'123456');
    await login.locator('button[type="submit"],button').first().click();
  }
  await expect(page.locator('.shell-app')).toBeVisible({timeout:10000});
  await page.waitForFunction(()=>!!window.TotalToolsGuideMe?.openTask && !!window.TotalToolsShellOpen);
}

async function openGuidedTask(page,taskId){
  await page.evaluate(id=>window.TotalToolsGuideMe.openTask(id),taskId);
  await expect(page.locator('#tt-guided-mode')).toBeVisible();
  await expect(page.locator('#tt-purchasing-workspace')).toBeVisible({timeout:10000});
  await expect(page.locator('.tt-guide__step-count')).toHaveText(/Step 2 of /,{timeout:10000});
  await expect(page.locator('.tt-guide__exact-action button')).toBeVisible({timeout:10000});
}

test.describe('Guide Me purchasing workflow launchers',()=>{
  test('Create Purchase Request action opens the request composer',async({page})=>{
    await login(page);
    await openGuidedTask(page,'pr');
    const action=page.locator('.tt-guide__exact-action button');
    await expect(action).toHaveText(/New Purchase Request/i);
    await action.click();
    await expect(page.locator('.tt-purch__composer')).toBeVisible({timeout:5000});
    await expect(page.locator('#tt-purch-compose-title')).toHaveText('Create Purchase Request');
  });

  test('Create Purchase Order action opens the order composer',async({page})=>{
    await login(page);
    await openGuidedTask(page,'po');
    const action=page.locator('.tt-guide__exact-action button');
    await expect(action).toHaveText(/New Purchase Order/i);
    await action.click();
    await expect(page.locator('.tt-purch__composer')).toBeVisible({timeout:5000});
    await expect(page.locator('#tt-purch-compose-title')).toHaveText('Create Purchase Order');
  });
});
