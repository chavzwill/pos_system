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
}

async function assertNoPageOverflow(page,label){
  const state=await page.evaluate(()=>{
    const root=document.documentElement;
    const shell=document.getElementById('shell-root');
    const workspace=document.querySelector('[data-tt-workspace]');
    return {
      innerWidth:window.innerWidth,
      docWidth:root.scrollWidth,
      bodyWidth:document.body.scrollWidth,
      shell: shell?{left:shell.getBoundingClientRect().left,right:shell.getBoundingClientRect().right,width:shell.getBoundingClientRect().width}:null,
      workspace: workspace?{left:workspace.getBoundingClientRect().left,right:workspace.getBoundingClientRect().right,width:workspace.getBoundingClientRect().width}:null,
    };
  });
  expect(state.docWidth,`${label}: document overflow ${state.docWidth}px > ${state.innerWidth}px`).toBeLessThanOrEqual(state.innerWidth+1);
  expect(state.bodyWidth,`${label}: body overflow ${state.bodyWidth}px > ${state.innerWidth}px`).toBeLessThanOrEqual(state.innerWidth+1);
  if(state.shell){
    expect(state.shell.left,`${label}: shell starts outside viewport`).toBeGreaterThanOrEqual(-1);
    expect(state.shell.right,`${label}: shell ends outside viewport`).toBeLessThanOrEqual(state.innerWidth+1);
  }
  if(state.workspace){
    expect(state.workspace.left,`${label}: workspace starts outside viewport`).toBeGreaterThanOrEqual(-1);
    expect(state.workspace.right,`${label}: workspace ends outside viewport`).toBeLessThanOrEqual(state.innerWidth+1);
  }
}

test.describe('responsive shell and workspaces',()=>{
  test('shell fits phone tablet and desktop breakpoints without horizontal page overflow',async({page})=>{
    await login(page);
    for(const viewport of [
      {width:360,height:780},
      {width:390,height:844},
      {width:768,height:1024},
      {width:1024,height:768},
    ]){
      await page.setViewportSize(viewport);
      await page.waitForTimeout(80);
      await assertNoPageOverflow(page,`shell ${viewport.width}x${viewport.height}`);
      if(viewport.width<=1023){
        await expect(page.locator('#shell-menu')).toBeVisible();
        await expect(page.locator('.shell-sidebar')).toHaveCSS('position','fixed');
      }
    }
  });

  test('representative operational workspaces stay inside narrow viewports',async({page})=>{
    await login(page);
    const targets=[
      ['sales-workspace','Point of Sale'],
      ['inventory-workspace','Inventory Operations'],
      ['purchasing-workspace','Purchase Orders'],
      ['work-orders-workspace','Work Orders'],
      ['rentals-workspace','Rental Operations'],
      ['admin-workspace','People & Access'],
    ];
    for(const viewport of [{width:390,height:844},{width:768,height:1024}]){
      await page.setViewportSize(viewport);
      for(const [key,title] of targets){
        const result=await page.evaluate(async({key,title})=>{
          try{await window.TotalToolsShellOpen(key,title);return {ok:true};}
          catch(error){return {ok:false,error:String(error?.message||error)};}
        },{key,title});
        expect(result.ok,`${key}: ${result.error||'open failed'}`).toBeTruthy();
        await expect(page.locator('[data-tt-workspace]')).toBeVisible({timeout:10000});
        await assertNoPageOverflow(page,`${key} at ${viewport.width}px`);
        await page.keyboard.press('Escape');
        await expect(page.locator('.shell-page-head')).toBeVisible({timeout:5000});
      }
    }
  });
});
