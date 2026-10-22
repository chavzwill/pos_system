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


test('A PO accepts an existing catalog item before choosing a supplier',async({page})=>{
  await login(page);
  await openPurchasingDomain(page);
  await cardAction(page,'Purchase Orders');
  await page.locator('#tt-purch-new-po').click();
  await assertComposerInViewport(page,'Create Purchase Order');
  await expect(page.locator('.tt-purch__catalog-hint')).toContainText('No product-to-supplier link is required');
  await page.route('**/api/predictive-lookup?**',async route=>{
    const url=new URL(route.request().url());
    if(url.searchParams.get('domain')!=='product')return route.continue();
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({
      domain:'product',
      results:[{entity_type:'product',entity_id:424242,primary_label:'Independent catalog item',secondary_label:'ANY-ITEM',context:{sku:'ANY-ITEM',cost:55}}],
      exact_match:null,ambiguous_exact:false
    })});
  });
  const product=page.locator('[data-line="0"] [data-line-field="product_name"]');
  await product.fill('Independent catalog');
  await expect(page.locator('.tt-predictive-option')).toBeVisible({timeout:5000});
  await page.locator('.tt-predictive-option').first().click();
  await expect(product).toHaveAttribute('data-product-id','424242');
  await expect(page.locator('[data-line="0"] [data-line-status]')).toContainText('supplier link not required');
  await expect(page.locator('#tt-purch-compose-supplier')).toHaveValue('');
});

test('The PO composer fits tablet, mobile, and narrow phone widths',async({page})=>{
  await login(page);
  await openPurchasingDomain(page);
  await cardAction(page,'Purchase Orders');
  await page.locator('#tt-purch-new-po').click();
  await page.locator('[data-add-line]').click();
  for(const width of [768,390,320]){
    await page.setViewportSize({width,height:720});
    await assertComposerInViewport(page,'Create Purchase Order');
    const result=await page.locator('.tt-purch__composer').evaluate(el=>({
      width:el.clientWidth,scrollWidth:el.scrollWidth,
      inputs:[...el.querySelectorAll('[data-line-field]')].map(input=>({
        left:input.getBoundingClientRect().left,right:input.getBoundingClientRect().right
      }))
    }));
    expect(result.scrollWidth).toBeLessThanOrEqual(result.width+2);
    for(const bounds of result.inputs){
      expect(bounds.left).toBeGreaterThanOrEqual(-1);
      expect(bounds.right).toBeLessThanOrEqual(width+1);
    }
  }
});


test('Required PO approval justification survives line edits and fits a phone',async({page})=>{
  await login(page);
  await openPurchasingDomain(page);
  await cardAction(page,'Purchase Orders');
  await page.locator('#tt-purch-new-po').click();
  const form=page.locator('#tt-purch-compose-form');
  const reason=form.locator('[name="approval_purpose"]');
  const recipient=form.locator('[name="requested_for"]');
  await expect(reason).toHaveAttribute('required','');
  await expect(recipient).toHaveAttribute('required','');
  await reason.fill('Replace broken saws for this week’s confirmed customer jobs');
  await recipient.fill('Workshop team / service customers');
  await form.locator('[data-add-line]').click();
  await expect(form.locator('[name="approval_purpose"]')).toHaveValue('Replace broken saws for this week’s confirmed customer jobs');
  await expect(form.locator('[name="requested_for"]')).toHaveValue('Workshop team / service customers');
  await page.setViewportSize({width:390,height:740});
  const bounds=await form.locator('.tt-purch__approval-fields').evaluate(el=>({x:el.getBoundingClientRect().x,right:el.getBoundingClientRect().right}));
  expect(bounds.x).toBeGreaterThanOrEqual(-1);
  expect(bounds.right).toBeLessThanOrEqual(391);
});


test('Copy an approved PO into a fresh editable order without writing or copying approval status',async({page})=>{
  await login(page);
  await openPurchasingDomain(page);
  const old={
    id:480,po_number:'PO-00480',status:'approved',supplier_id:17,supplier_name:'Existing Supplier',
    branch_name:'Test Branch',expected_date:'2026-01-01',total:160,
    approval_purpose:'Restock tools',requested_for:'Maintenance team',additional_notes:'Inspect on arrival',
    items:[
      {id:91,product_id:54,product_name:'Drill',sku:'D-54',quantity_ordered:2,quantity_received:2,unit_cost:50},
      {id:92,product_id:null,product_name:'One-time repair part',sku:'',quantity_ordered:3,quantity_received:1,unit_cost:20}
    ]
  };
  const writes=[];
  await page.route('**/api/purchase-orders**',route=>{
    const url=new URL(route.request().url());
    if(route.request().method()!=='GET'){writes.push(route.request().method());return route.continue();}
    if(url.pathname==='/api/purchase-orders')return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify([old])});
    if(url.pathname==='/api/purchase-orders/480')return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(old)});
    return route.continue();
  });
  await cardAction(page,'Purchase Orders');
  await page.locator('#tt-purchasing-workspace [data-id="480"]').click();
  await expect(page.locator('[data-copy-document]')).toBeVisible();
  await page.locator('[data-copy-document]').click();
  const form=page.locator('#tt-purch-compose-form');
  await expect(form).toBeVisible();
  await expect(form.locator('.tt-purch__copy-notice')).toContainText('PO-00480');
  await expect(form.locator('#tt-purch-compose-supplier')).toHaveValue('Existing Supplier');
  await expect(form.locator('[name="date"]')).toHaveValue('');
  await expect(form.locator('[name="approval_purpose"]')).toHaveValue('Restock tools');
  await expect(form.locator('[name="requested_for"]')).toHaveValue('Maintenance team');
  await expect(form.locator('[name="notes"]')).toHaveValue('Inspect on arrival');
  await expect(form.locator('[data-line]')).toHaveCount(2);
  await expect(form.locator('[data-line="0"] [data-line-field="quantity"]')).toHaveValue('2');
  await expect(form.locator('[data-line="1"] [data-line-field="quantity"]')).toHaveValue('3');
  await expect(form.locator('[data-line="0"] [data-line-field="unit_cost"]')).toHaveValue('50');
  await form.locator('[data-line="0"] [data-duplicate-line]').click();
  await expect(form.locator('[data-line]')).toHaveCount(3);
  await expect(form.locator('[data-line="1"] [data-line-field="product_name"]')).toHaveValue('Drill');
  await expect(form.locator('[data-line="1"] [data-line-field="quantity"]')).toHaveValue('2');
  await form.locator('[data-line="1"] [data-line-field="quantity"]').fill('9');
  await expect(form.locator('[data-line="0"] [data-line-field="quantity"]')).toHaveValue('2');
  expect(writes).toEqual([]);
  for(const width of [390,320]){
    await page.setViewportSize({width,height:740});
    const box=await form.locator('[data-line="1"] [data-duplicate-line]').boundingBox();
    expect(box).not.toBeNull();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x+box.width).toBeLessThanOrEqual(width+1);
  }
});

test('Copy an approved Purchase Request as a new unsubmitted request',async({page})=>{
  await login(page);
  await openPurchasingDomain(page);
  const original={
    id:777,pr_number:'PR-00777',status:'approved',supplier_id:23,supplier_name:'Preferred Supplier',
    department:'Workshop',request_type:'internal_use',notes:'Maintenance of equipment',required_date:'2026-01-01',
    items:[{id:66,product_id:120,product_name:'Workshop gloves',sku:'G-120',quantity:5,unit_cost:25,item_type:'internal'}]
  };
  await page.route('**/api/purchase-requests**',route=>{
    const url=new URL(route.request().url());
    if(route.request().method()!=='GET')return route.continue();
    if(url.pathname==='/api/purchase-requests')return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify([original])});
    if(url.pathname==='/api/purchase-requests/777')return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(original)});
    return route.continue();
  });
  await cardAction(page,'Purchase Requests');
  await page.locator('#tt-purchasing-workspace [data-id="777"]').click();
  await expect(page.locator('[data-copy-document]')).toBeVisible();
  await page.locator('[data-copy-document]').click();
  const form=page.locator('#tt-purch-compose-form');
  await expect(form.locator('.tt-purch__copy-notice')).toContainText('PR-00777');
  await expect(form.locator('#tt-purch-compose-supplier')).toHaveValue('Preferred Supplier');
  await expect(form.locator('[name="department"]')).toHaveValue('Workshop');
  await expect(form.locator('[name="request_type"]')).toHaveValue('internal_use');
  await expect(form.locator('[name="date"]')).toHaveValue('');
  await expect(form.locator('[data-line="0"] [data-line-field="quantity"]')).toHaveValue('5');
  await expect(form.locator('[name="notes"]')).toHaveValue('Maintenance of equipment');
  await expect(form.locator('button[type="submit"]')).toHaveText('Create Purchase Request');
});
