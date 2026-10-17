import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const widths=[375,390,430,768,1024,1280,1440];
const modules=[
 ['sales-workspace','Point of Sale',{}],
 ['inventory-workspace','Inventory',{}],
 ['purchasing-workspace','Purchase Orders',{tab:'po'}],
 ['receiving-workspace','Receiving',{}],
 ['rentals-workspace','Rentals',{}],
 ['work-orders-workspace','Repairs',{}],
 ['customer-crm-workspace','Customers',{}],
 ['logistics-intelligence','Dispatch',{}],
 ['accounting-ledger','Accounting',{}],
 ['operational-reports','Reports',{}],
 ['admin-workspace','Admin',{}],
 ['settings-workspace','Settings',{}],
];
async function login(page){
 await page.goto('/');
 await page.locator('[name=username]').fill(process.env.POS_TEST_USER||'admin');
 await page.locator('[name=password]').fill(process.env.POS_TEST_PASSWORD||'123456');
 await page.locator('#shell-login button').click();
 await expect(page.locator('.shell-app')).toBeVisible();
 await page.waitForFunction(()=>!!window.TotalToolsWorkspaceLoader?.open&&!!window.TotalToolsGuideMe?.open);
}
for(const width of widths){
 test('shared shell and keyboard interactions at '+width+'px',async({page})=>{
  await page.setViewportSize({width,height:1000});await login(page);
  const activeStyles=await page.locator('link[rel=stylesheet]').evaluateAll(nodes=>nodes.map(n=>new URL(n.href).pathname));
  expect(activeStyles.filter(s=>/premium-shell|late-2020s|total-tools-identity|meeting-demo|unified-ui-system|guided-mode-(efficiency|qa|final-pass)/.test(s))).toEqual([]);
  const guide=page.locator('#shell-guide');
  if(!await guide.isVisible())await page.locator('#shell-menu').click();
  await expect(guide).toBeVisible();
  expect(await page.getByRole('button',{name:'Open Guide Me',exact:true}).filter({visible:true}).count()).toBe(1);
  await guide.click();
  const coach=page.locator('#tt-guided-mode [role=dialog]');
  await expect(coach).toBeVisible();
  await expect(coach).toHaveAttribute('aria-modal','false');
  const rect=await coach.boundingBox();expect(rect.x).toBeGreaterThanOrEqual(0);expect(rect.x+rect.width).toBeLessThanOrEqual(width+1);
  await page.keyboard.press('Escape');await expect(coach).toHaveCount(0);await expect(guide).toBeFocused();
  await page.keyboard.press('Control+k');
  const command=page.getByRole('dialog',{name:'Quick Command'});await expect(command).toBeVisible();
  await expect(page.locator('#shell-command-input')).toBeFocused();
  await page.keyboard.press('Escape');await expect(command).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width+1);
  fs.mkdirSync('test-results/frontend-experience',{recursive:true});
  await page.screenshot({path:'test-results/frontend-experience/shell-'+width+'.png',fullPage:true});
 });
 test('operational workspaces fit and expose usable controls at '+width+'px',async({page})=>{
  test.setTimeout(180000);
  await page.setViewportSize({width,height:1000});await login(page);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  for(const [key,title,options] of modules){
   await page.goto('/');await expect(page.locator('.shell-app')).toBeVisible();
   await page.waitForFunction(()=>!!window.TotalToolsWorkspaceLoader?.open);
   await page.evaluate(async({key,title,options})=>window.TotalToolsWorkspaceLoader.open(key,title,options),{key,title,options});
   const root=page.locator('[data-tt-workspace="'+key+'"]').last();await expect(root).toBeVisible();
   const bounds=await root.boundingBox();expect(bounds.x,title).toBeGreaterThanOrEqual(0);expect(bounds.x+bounds.width,title).toBeLessThanOrEqual(width+1);
   expect(await page.evaluate(()=>document.documentElement.scrollWidth),title).toBeLessThanOrEqual(width+1);
   const controls=await root.locator('button:visible,input:not([type=checkbox]):not([type=radio]):visible,select:visible,textarea:visible').evaluateAll(nodes=>nodes.filter(n=>!n.disabled).map(n=>{const r=n.getBoundingClientRect();return {name:n.getAttribute('aria-label')||n.textContent.trim()||n.getAttribute('placeholder')||n.name,height:r.height,font:parseFloat(getComputedStyle(n).fontSize)};}));
   expect(controls.filter(c=>!c.name),title+' unnamed controls').toEqual([]);
   if(width<=430)expect(controls.filter(c=>c.height>0&&c.height<43),title+' touch targets').toEqual([]);
   fs.mkdirSync('test-results/frontend-experience',{recursive:true});
   await page.screenshot({path:'test-results/frontend-experience/'+title.toLowerCase().replace(/\s/g,'-')+'-'+width+'.png',fullPage:true});
  }
  expect(errors).toEqual([]);
 });
}
test('reduced motion disables decorative transitions',async({page})=>{
 await page.emulateMedia({reducedMotion:'reduce'});await login(page);
 expect(await page.evaluate(()=>[...document.querySelectorAll('button,input,a')].filter(n=>n.getClientRects().length).every(n=>getComputedStyle(n).transitionDuration.split(',').every(t=>parseFloat(t)===0)))).toBe(true);
});
