import { test, expect } from '@playwright/test';

const user=process.env.POS_TEST_USER||'admin';
const password=process.env.POS_TEST_PASSWORD||'123456';

async function openLogin(page){
  await page.goto('/');
  await expect(page.locator('#shell-login')).toBeVisible({timeout:10_000});
}
async function signIn(page,u=user,p=password){
  const form=page.locator('#shell-login');
  await form.locator('input[name="username"]').fill(u);
  await form.locator('input[name="password"]').fill(p);
  await form.locator('button[type="submit"],button').first().click();
}

test.describe('Native POS authentication',()=>{
  test('login page renders without client crash',async({page})=>{
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await openLogin(page);
    await expect(page.locator('input[name="username"]')).toBeVisible();
    await expect(page.locator('input[name="password"]')).toBeVisible();
    await expect(page.getByRole('button',{name:/sign in/i})).toBeVisible();
    expect(errors,errors.join('\n')).toEqual([]);
  });

  test('wrong password stays on login and gives recoverable feedback',async({page})=>{
    await openLogin(page);
    await signIn(page,user,'definitely-not-the-password');
    await expect(page.locator('#shell-login-error')).not.toBeEmpty({timeout:8_000});
    await expect(page.locator('#shell-login')).toBeVisible();
    await expect(page.getByRole('button',{name:/sign in/i})).toBeEnabled();
    await expect(page.locator('.tt-shell-recovery')).toHaveCount(0);
  });

  test('successful login survives authenticated reload',async({page})=>{
    await openLogin(page);
    await signIn(page);
    const forced=page.locator('#tt-password-change');
    if(await forced.count()) test.skip(true,'Disposable fixture requires password rotation; use a non-forced POS_TEST_USER for shell certification.');
    await expect(page.locator('.shell-app')).toBeVisible({timeout:10_000});
    await page.reload();
    await expect(page.locator('.shell-app')).toBeVisible({timeout:10_000});
    await expect(page.locator('#shell-login')).toHaveCount(0);
  });

  test('logout revokes authenticated shell session',async({page})=>{
    await openLogin(page);await signIn(page);
    if(await page.locator('#tt-password-change').count()) test.skip(true,'Disposable fixture requires password rotation.');
    await expect(page.locator('.shell-app')).toBeVisible({timeout:10_000});
    await page.locator('#shell-logout').click();
    await expect(page.locator('#shell-login')).toBeVisible({timeout:10_000});
    const response=await page.request.get('/api/workspace-profile/me');
    expect(response.status()).toBe(401);
  });
});
