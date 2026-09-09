import { test, expect } from '@playwright/test';

const user=process.env.POS_TEST_USER||'admin';
const password=process.env.POS_TEST_PASSWORD||'123456';

async function login(page){
  await page.goto('/');
  const form=page.locator('#shell-login');
  if(await form.count()){
    await form.locator('input[name="username"]').fill(user);
    await form.locator('input[name="password"]').fill(password);
    await form.locator('button[type="submit"],button').first().click();
  }
  if(await page.locator('#tt-password-change').count()) test.skip(true,'Use a non-forced-password POS_TEST_USER for full workspace certification.');
  await expect(page.locator('.shell-app')).toBeVisible({timeout:12_000});
}
function monitor(page){
  const errors=[];
  page.on('pageerror',e=>errors.push(`pageerror: ${e.stack||e.message}`));
  page.on('console',m=>{if(m.type()==='error'&&!/favicon/i.test(m.text()))errors.push(`console: ${m.text()}`);});
  page.on('requestfailed',r=>errors.push(`requestfailed: ${r.method()} ${r.url()} ${r.failure()?.errorText||''}`));
  page.on('response',r=>{const u=r.url();if(r.status()>=500&&u.includes('/api/'))errors.push(`http ${r.status()}: ${r.request().method()} ${u}`);});
  return errors;
}
async function reset(page){
  await page.keyboard.press('Escape').catch(()=>{});
  await page.evaluate(()=>{
    document.getElementById('tt-workspace-load-error')?.remove();
    document.getElementById('tt-runtime-error-banner')?.remove();
  });
}

test.describe('Native POS complete workspace smoke audit',()=>{
  test('every registered workspace loads through the authoritative loader',async({page})=>{
    const errors=monitor(page);await login(page);
    const entries=await page.evaluate(()=>Object.entries(window.TotalToolsWorkspaceLoader?.assets||{}).map(([key,[css,js,global]])=>({key,css,js,global})));
    expect(entries.length).toBeGreaterThan(35);
    const results=[];
    for(const entry of entries){
      await reset(page);
      const result=await page.evaluate(async({key})=>{
        try{await window.TotalToolsShellOpen(key,key);return{ok:true,active:document.documentElement.dataset.ttActiveWorkspace||''};}
        catch(error){return{ok:false,error:error?.stack||error?.message||String(error)};}
      },entry);
      results.push({...entry,...result});
      expect(result.ok,`${entry.key}: ${result.error||'failed to open'}`).toBeTruthy();
      expect(result.active,`${entry.key}: loader did not mark active workspace`).toBe(entry.key);
      await expect(page.locator('#tt-workspace-load-error')).toHaveCount(0);
      await expect(page.locator('.tt-shell-recovery')).toHaveCount(0);
      await expect(page.locator('#tt-runtime-error-banner')).toHaveCount(0);
    }
    expect(results.filter(x=>!x.ok),JSON.stringify(results.filter(x=>!x.ok),null,2)).toEqual([]);
    expect(errors,errors.join('\n')).toEqual([]);
  });

  test('every sidebar domain renders cards and registered actions',async({page})=>{
    const errors=monitor(page);await login(page);
    const domains=page.locator('.shell-nav [data-domain]');
    const count=await domains.count();expect(count).toBeGreaterThan(0);
    for(let i=0;i<count;i++){
      const button=domains.nth(i);await button.click();await expect(button).toHaveClass(/is-active/);
      const grid=page.locator('#shell-grid');await expect(grid).toBeVisible();
      const openButtons=grid.locator('[data-open]');
      if(await openButtons.count()){
        const keys=await openButtons.evaluateAll(nodes=>nodes.map(n=>n.dataset.open));
        const registered=await page.evaluate(keys=>keys.map(k=>[k,Boolean(window.TotalToolsWorkspaceLoader?.assets?.[k])]),keys);
        expect(registered.filter(([,ok])=>!ok),`Unregistered cards in domain ${await button.getAttribute('data-domain')}`).toEqual([]);
      }
    }
    expect(errors,errors.join('\n')).toEqual([]);
  });

  test('Guided Mode routes every registered task without shell crash',async({page})=>{
    const errors=monitor(page);await login(page);
    const tasks=await page.evaluate(()=>window.TotalToolsGuidedMode?.tasks?.map(t=>t.id)||[]);
    expect(tasks.length).toBeGreaterThan(10);
    for(const id of tasks){
      await reset(page);
      await page.evaluate(id=>window.TotalToolsGuidedMode.open({task:id}),id);
      await expect(page.locator('#tt-guided-mode')).toBeVisible();
      await page.waitForTimeout(180);
      await expect(page.locator('.tt-shell-recovery')).toHaveCount(0);
      await expect(page.locator('#tt-runtime-error-banner')).toHaveCount(0);
      await page.evaluate(()=>window.TotalToolsGuidedMode.close());
    }
    expect(errors,errors.join('\n')).toEqual([]);
  });
});

const viewports=[
  {name:'wide desktop',width:1440,height:900},
  {name:'desktop',width:1280,height:800},
  {name:'small laptop',width:1024,height:768},
  {name:'tablet portrait',width:768,height:1024},
  {name:'phone',width:390,height:844},
];
for(const vp of viewports){
  test(`responsive shell and Guided Mode: ${vp.name}`,async({page})=>{
    await page.setViewportSize({width:vp.width,height:vp.height});const errors=monitor(page);await login(page);
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
    expect(overflow,`Horizontal shell overflow at ${vp.width}x${vp.height}`).toBeLessThanOrEqual(2);
    await page.evaluate(()=>window.TotalToolsGuidedMode.open());
    await expect(page.locator('#tt-guided-mode .tt-guide')).toBeVisible();
    const box=await page.locator('#tt-guided-mode .tt-guide').boundingBox();
    expect(box).not.toBeNull();
    expect(box.x).toBeGreaterThanOrEqual(-1);expect(box.y).toBeGreaterThanOrEqual(-1);
    expect(box.x+box.width).toBeLessThanOrEqual(vp.width+1);expect(box.y+box.height).toBeLessThanOrEqual(vp.height+1);
    expect(errors,errors.join('\n')).toEqual([]);
  });
}
