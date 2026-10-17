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
 const auth=await page.request.post('/api/employees/reauth-self',{data:{purpose:'security_admin',password:process.env.POS_TEST_PASSWORD||'123456'}});expect(auth.status()).toBe(200);
}

async function fixtures(page,width){
 expect(new URL(page.url()).hostname).toBe('localhost');
 const branches=await (await page.request.get('/api/branches')).json(),branch=branches.find(b=>b.active!==0);
 expect(branch).toBeTruthy();
 const p=await page.request.post('/api/products',{data:{sku:'UI-'+width+'-'+Date.now(),name:'Cordless drill · UI verification',price:100,cost:60,tax_rate:0,stock_qty:0,min_stock:0,active:1,branch_id:branch.id,taxable:1}});
 expect(p.status()).toBe(201);const product=await p.json();
 const stock=await page.request.patch('/api/products/'+product.id+'/stock',{data:{branch_id:branch.id,adjustment:3,reason:'Isolated frontend layout verification'}});expect(stock.status()).toBe(200);
 const suppliers=await(await page.request.get('/api/suppliers')).json(),supplier=suppliers.find(s=>s.active!==0);
 expect(supplier).toBeTruthy();
 const po=await page.request.post('/api/purchase-orders',{data:{supplier_id:supplier.id,branch_id:branch.id,ship_to_branch_id:branch.id,ship_to_name:branch.name,ship_to_address:branch.address||'1 UI Test Road',ship_to_city:branch.city||'Kingston',ship_to_state:branch.state||'Kingston',items:[{product_id:product.id,quantity_ordered:2,unit_cost:60}],notes:'Isolated UI receiving verification'}});
 expect(po.status()).toBe(201);const order=await po.json();const approval=await page.request.patch('/api/purchase-orders/'+order.id+'/status',{data:{status:'approved'}});expect(approval.status()).toBe(200);
 return{product,order};
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
  fs.mkdirSync('test-results/frontend-experience',{recursive:true});await page.screenshot({path:'test-results/frontend-experience/guide-me-home-'+width+'.png',fullPage:true});
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
  const fixture=await fixtures(page,width);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  for(const [key,title,options] of modules){
   await page.goto('/');await expect(page.locator('.shell-app')).toBeVisible();
   await page.waitForFunction(()=>!!window.TotalToolsWorkspaceLoader?.open);
   await page.evaluate(async({key,title,options})=>window.TotalToolsWorkspaceLoader.open(key,title,options),{key,title,options:key==='receiving-workspace'?{poId:fixture.order.id}:options});
   const root=page.locator('[data-tt-workspace="'+key+'"]').last();await expect(root).toBeVisible();
   if(key==='sales-workspace'){await root.locator('[data-product="'+fixture.product.id+'"]').click();await expect(root.locator('.tt-sales__line').first()).toBeVisible();const product=root.locator('[data-product="'+fixture.product.id+'"]');expect(await product.evaluate(n=>[...n.querySelectorAll('strong,span,footer')].every(child=>{const a=n.getBoundingClientRect(),b=child.getBoundingClientRect();return b.top>=a.top&&b.bottom<=a.bottom+1}))).toBe(true);}
   const bounds=await root.boundingBox();expect(bounds.x,title).toBeGreaterThanOrEqual(0);expect(bounds.x+bounds.width,title).toBeLessThanOrEqual(width+1);
   expect(await page.evaluate(()=>document.documentElement.scrollWidth),title).toBeLessThanOrEqual(width+1);
   const controls=await root.locator('button:visible,input:not([type=checkbox]):not([type=radio]):visible,select:visible,textarea:visible').evaluateAll(nodes=>nodes.filter(n=>!n.disabled).map(n=>{const r=n.getBoundingClientRect();return {name:n.getAttribute('aria-label')||n.getAttribute('aria-labelledby')?.split(/\s+/).map(id=>document.getElementById(id)?.textContent||'').join(' ').trim()||[...(n.labels||[])].map(l=>l.textContent.trim()).join(' ')||n.textContent.trim()||n.getAttribute('placeholder'),height:r.height,font:parseFloat(getComputedStyle(n).fontSize)};}));
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

for(const width of [375,1440]){
 test('purchasing composer preserves modal keyboard flow at '+width+'px',async({page})=>{
  await page.setViewportSize({width,height:1000});await login(page);
  await page.evaluate(()=>window.TotalToolsWorkspaceLoader.open('purchasing-workspace','Purchase Orders',{tab:'po'}));
  const trigger=page.locator('#tt-purch-new-po');await trigger.click();
  const dialog=page.getByRole('dialog',{name:'Create Purchase Order',exact:true});await expect(dialog).toBeVisible();
  const box=await dialog.boundingBox();expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(width+1);
  await dialog.evaluate(n=>{const a=[...n.querySelectorAll('button,input,select,textarea,a[href]')].filter(x=>!x.disabled&&x.getClientRects().length);a.at(-1).focus()});
  await page.keyboard.press('Tab');expect(await dialog.evaluate(n=>n.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(page.locator('#tt-purch-new-po')).toBeFocused();
 });
}

for(const width of widths){
 test('Guide Me opens Inventory and leaves its controls usable at '+width+'px',async({page})=>{
  await page.setViewportSize({width,height:1000});await login(page);await page.locator('#shell-guide').click();
  await page.locator('#tt-guide-input').fill('adjust inventory');await page.locator('[data-guide-search] button[type=submit]').click();
  const inventory=page.locator('[data-tt-workspace="inventory-workspace"]');await expect(inventory).toBeVisible({timeout:15000});
  await expect(page.locator('.tt-guide__step-count')).toContainText('Step 2',{timeout:15000});
  const search=inventory.locator('#tt-inv-search');await search.click();await search.fill('Baseball');await expect(search).toHaveValue('Baseball');
  const coach=page.locator('#tt-guided-mode .tt-guide');const box=await coach.boundingBox();expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(width+1);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width+1);
  fs.mkdirSync('test-results/frontend-experience',{recursive:true});await page.screenshot({path:'test-results/frontend-experience/guide-me-inventory-'+width+'.png',fullPage:true});
 });
}
