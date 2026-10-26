const {test,expect}=require('@playwright/test');
const {db}=require('../database');
const bcrypt=require('bcryptjs'),crypto=require('node:crypto');
const BASE='http://localhost:3001';
let cookie,branch,product,customer,approver,password,settings;
const sql=(sql,args=[])=>db.execute({sql,args});
async function api(method,path,body,key){const r=await fetch(BASE+'/api'+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};}
const op=()=>crypto.randomUUID();
function ticket(qty=2){return {customer_id:customer,branch_id:branch,items:[{product_id:product,quantity:qty,line_discount_percent:10},{line_type:'comment',product_name:'Keep packaging <intact>',unit_price:999},{line_type:'delivery',product_name:'Kingston delivery',unit_price:25,tax_rate:99}],discount_mode:'percentage',discount_value:10,discount_amount:0,payment_method:'cash',amount_tendered:1000};}
test.beforeAll(async()=>{
 const r=await fetch(BASE+'/api/employees/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:process.env.POS_TEST_USER||'admin',password:process.env.POS_TEST_PASSWORD})});expect(r.status).toBe(200);cookie=(r.headers.get('set-cookie')||'').split(';')[0];
 const suffix=op();branch=Number((await sql('INSERT INTO branches(name,branch_code,active) VALUES(?,?,1)',['Sales Integrity '+suffix,'SI-'+suffix])).lastInsertRowid);
 product=Number((await sql('INSERT INTO products(sku,name,price,cost,tax_rate,stock_qty,active) VALUES(?,?,100,20,0,100,1)',['SI-'+suffix,'Integrity fixture '+suffix])).lastInsertRowid);
 await sql('INSERT INTO branch_inventory(product_id,branch_id,stock_qty,min_stock) VALUES(?,?,100,0)',[product,branch]);
 customer=Number((await sql("INSERT INTO customers(first_name,last_name,active) VALUES('Sales','Integrity',1)")).lastInsertRowid);
 password=crypto.randomBytes(18).toString('hex');const hash=await bcrypt.hash(password,10);
 approver=Number((await sql("INSERT INTO employees(first_name,last_name,username,pin,password,active,security_group_id,default_branch_id) VALUES('Independent','Approver',?,'unused',?,1,(SELECT id FROM security_groups WHERE name='Administrator'),?)",['approve-'+suffix,hash,branch])).lastInsertRowid);
 settings=(await sql("SELECT key,value FROM settings WHERE key IN ('tax_rate','max_discount_pct')")).rows;
 await sql("UPDATE settings SET value='15' WHERE key='tax_rate'");await sql("UPDATE settings SET value='50' WHERE key='max_discount_pct'");
});
test.afterAll(async()=>{for(const s of settings||[])await sql('UPDATE settings SET value=? WHERE key=?',[s.value,s.key]);db.close();});
test('hold, recall, replay and exact partial refund preserve discounts without moving non-stock inventory',async()=>{
 const initial=(await sql('SELECT stock_qty FROM products WHERE id=?',[product])).rows[0].stock_qty;
 const held=await api('POST','/transactions/hold',ticket());expect(held.status,JSON.stringify(held.body)).toBe(201);expect(held.body.discount_amount).toBe(38);expect(held.body.total).toBe(190.75);expect(held.body.items.filter(i=>i.line_type==='comment')[0].total).toBe(0);
 expect((await sql('SELECT stock_qty FROM products WHERE id=?',[product])).rows[0].stock_qty).toBe(initial);
 const p={...ticket(3),source_hold_id:held.body.id};const key=op();const sale=await api('POST','/transactions',p,key);expect(sale.status,JSON.stringify(sale.body)).toBe(201);expect(sale.body.discount_amount).toBe(57);expect(sale.body.total).toBe(271.75);
 const retry=await api('POST','/transactions',p,key);expect(retry.status).toBeLessThan(300);expect(retry.body.id).toBe(sale.body.id);
 expect((await sql('SELECT stock_qty FROM products WHERE id=?',[product])).rows[0].stock_qty).toBe(initial-3);
 expect((await api('POST',`/held-sales/${held.body.id}/finalize`,{completed_transaction_id:sale.body.id})).status).toBe(200);
 const item=sale.body.items.find(i=>i.product_id===product);
 const body={items:[{transaction_item_id:item.id,quantity:1}],resolution:'credit_note',notes:'Wrong size for customer',return_authorizer_id:approver,return_authorizer_password:password};
 const denied=await api('POST',`/transactions/${sale.body.id}/return`,{...body,return_authorizer_password:undefined});expect(denied.status).toBe(400);
 const ret=await api('POST',`/transactions/${sale.body.id}/return`,body);expect(ret.status,JSON.stringify(ret.body)).toBe(201);expect(ret.body.total).toBe(81);expect(ret.body.allocation.order_discount_allocated).toBe(19);
 const history=await api('GET',`/transactions/${sale.body.id}/returns`);expect(history.body[0].authorization.authorized_by_employee_id).toBe(approver);
 expect((await api('POST',`/transactions/${sale.body.id}/return`,{...body,items:[{transaction_item_id:sale.body.items.find(i=>i.line_type==='delivery').id,quantity:1}]})).status).toBe(409);
});
test('quote typed lines survive edit and conversion without purchasing requests',async()=>{
 const items=[{product_id:product,quantity:1},{line_type:'comment',description:'Customer note',unit_price:900},{line_type:'delivery',description:'Delivery',unit_price:25,tax_rate:99}];
 const created=await api('POST','/quotations',{customer_id:customer,branch_id:branch,items});expect(created.status,JSON.stringify(created.body)).toBe(201);
 const q=await api('GET',`/quotations/${created.body.id}`);expect(q.body.items.map(i=>i.line_type)).toEqual(['product','comment','delivery']);expect(q.body.items[1].is_temp_item).toBe(0);expect(q.body.items[2].tax_amount).toBe(3.75);
 const edit=await api('PUT',`/quotations/${q.body.id}`,{customer_id:customer,branch_id:branch,items,discount_amount:10});expect(edit.status,JSON.stringify(edit.body)).toBe(200);
 const converted=await api('POST',`/quotations/${q.body.id}/convert`,{branch_id:branch});expect(converted.status,JSON.stringify(converted.body)).toBe(201);expect(converted.body.items.map(i=>i.line_type)).toEqual(['product','comment','delivery']);
 expect((await sql('SELECT COUNT(*) n FROM quotation_items WHERE quote_id=? AND purchase_request_id IS NOT NULL',[q.body.id])).rows[0].n).toBe(0);
});
test('reject forged typed products, over-discounts and changed delivery replay',async()=>{
 const forged=ticket();forged.items[1].product_id=product;expect((await api('POST','/transactions/hold',forged)).status).toBe(400);
 const excess=ticket();excess.discount_value=1000;excess.discount_mode='amount';expect((await api('POST','/transactions/hold',excess)).status).toBe(400);
 const key=op(),p=ticket(1);const saved=await api('POST','/transactions',p,key);expect(saved.status,JSON.stringify(saved.body)).toBe(201);p.items[2].unit_price=26;expect((await api('POST','/transactions',p,key)).status).toBe(409);
});
test('variation discounts use the charged variation price and exact evidence',async()=>{
 const variation=Number((await sql('INSERT INTO product_variations(product_id,name,sku,price,stock_qty) VALUES(?,?,?,50,20)',[product,'Small','SI-V-'+op()])).lastInsertRowid);
 const p={customer_id:customer,branch_id:branch,items:[{product_id:product,variation_id:variation,quantity:1},{product_id:product,quantity:1}],discount_mode:'percentage',discount_value:10,payment_method:'cash',amount_tendered:200};
 const held=await api('POST','/transactions/hold',p);expect(held.status,JSON.stringify(held.body)).toBe(201);expect(held.body.discount_amount).toBe(15);expect(held.body.subtotal).toBe(150);
 const sale=await api('POST','/transactions',p,op());expect(sale.status,JSON.stringify(sale.body)).toBe(201);expect(sale.body.items.map(i=>i.discount_amount)).toEqual([5,10]);expect(sale.body.total).toBe(135);
});
test('scoped automatic promotion allocates discounts only to eligible merchandise',async()=>{
 const promotion=Number((await sql("INSERT INTO promotions(name,type,value,applies_to,active) VALUES('Scoped runtime','percentage',10,'items',1)")).lastInsertRowid);
 await sql("INSERT INTO promotion_items(promotion_id,item_type,item_id) VALUES(?,'product',?)",[promotion,product]);
 const other=Number((await sql('INSERT INTO products(sku,name,price,cost,tax_rate,stock_qty,active) VALUES(?,?,200,10,0,10,1)',['OTHER-'+op(),'Other fixture'])).lastInsertRowid);await sql('INSERT INTO branch_inventory(product_id,branch_id,stock_qty) VALUES(?,?,10)',[other,branch]);
 const p={customer_id:customer,branch_id:branch,items:[{product_id:product,quantity:1},{product_id:other,quantity:1}],discount_source:'automatic_promotion',discount_reference_id:promotion,discount_amount:1000,payment_method:'cash',amount_tendered:400};
 const saved=await api('POST','/transactions',p,op());expect(saved.status,JSON.stringify(saved.body)).toBe(201);expect(saved.body.discount_amount).toBe(10);expect(saved.body.items.map(i=>i.discount_amount)).toEqual([10,0]);expect(saved.body.discount_source).toBe('automatic_promotion');
});
for(const width of [1280,390])test('counter controls preserve typed text and percentage intent at '+width+'px',async({page})=>{
 await page.context().addCookies([{name:cookie.split('=')[0],value:cookie.slice(cookie.indexOf('=')+1),url:BASE}]);await page.setViewportSize({width,height:900});
 const {rows:[p]}=await sql('SELECT * FROM products WHERE id=?',[product]);
 await page.route('**/api/products?*',route=>route.fulfill({json:[p]}));
 await page.goto('/');await page.waitForFunction(()=>!!window.TotalToolsWorkspaceLoader?.open);
 await page.evaluate(()=>window.TotalToolsWorkspaceLoader.open('sales-workspace','Point of Sale'));
 const root=page.locator('#tt-sales-workspace');await root.locator('[data-product="'+product+'"]').click();
 await root.locator('#tt-sales-comment').click();await page.locator('#shell-input-dialog input[name="description"]').fill('<img src=x onerror=alert(1)> Customer note');await page.locator('#shell-input-dialog button[type="submit"]').click();await expect(page.locator('#shell-input-dialog')).toHaveCount(0);
 await expect(root.locator('.tt-sales__line').last()).toContainText('<img src=x onerror=alert(1)> Customer note');await expect(root.locator('.tt-sales__line img')).toHaveCount(0);
 await root.locator('#tt-sales-delivery').click();await page.locator('#shell-input-dialog input[name="description"]').fill('Kingston delivery');await page.locator('#shell-input-dialog input[name="amount"]').fill('25.50');await page.locator('#shell-input-dialog button[type="submit"]').click();await expect(page.locator('#shell-input-dialog')).toHaveCount(0);
 await root.locator('#tt-sales-discount-mode').selectOption('percentage');await root.locator('#tt-sales-discount-value').fill('10');await root.locator('#tt-sales-apply-discount').click();
 await expect(root.locator('.tt-sales__totals .total strong')).toContainText('119.33');
 await root.locator('[data-plus]').first().click();await expect(root.locator('.tt-sales__totals .total strong')).toContainText('209.33');
 const bounds=await root.boundingBox();expect(bounds.x+bounds.width).toBeLessThanOrEqual(width+1);await page.screenshot({path:'test-results/sales-integrity-'+width+'.png',fullPage:true});
});
test('three partial refunds exhaust a one-cent discount exactly',async()=>{
 const p={customer_id:customer,branch_id:branch,items:[{product_id:product,quantity:3}],discount_mode:'amount',discount_value:0.01,payment_method:'cash',amount_tendered:300};
 const sale=await api('POST','/transactions',p,op());expect(sale.status,JSON.stringify(sale.body)).toBe(201);
 const refunds=[];for(let i=0;i<3;i++){const ret=await api('POST',`/transactions/${sale.body.id}/return`,{resolution:'credit_note',notes:'Partial customer return',items:[{transaction_item_id:sale.body.items[0].id,quantity:1}],return_authorizer_id:approver,return_authorizer_password:password});expect(ret.status,JSON.stringify(ret.body)).toBe(201);refunds.push(ret.body)}
 expect(Math.round(refunds.reduce((s,r)=>s+r.total,0)*100)).toBe(29999);expect(refunds.map(r=>r.allocation.order_discount_allocated)).toEqual([0,0.01,0]);
 await expect(sql('UPDATE retail_line_discount_snapshots SET total_discount_cents=0 WHERE transaction_id=?',[sale.body.id])).rejects.toThrow(/immutable/);
});
test('manual discount authority cannot be forged and customer-card source is server verified',async()=>{
 const group=Number((await sql('INSERT INTO security_groups(name,permissions) VALUES(?,?)',['Limited '+op(),JSON.stringify({pos:true,pos_hold:true,pos_discounts:false})])).lastInsertRowid);
 const username='limited-'+op();await sql("INSERT INTO employees(first_name,last_name,username,pin,password,active,security_group_id,default_branch_id) VALUES('Limited','Cashier',?,'unused',?,1,?,?)",[username,await bcrypt.hash(password,10),group,branch]);
 const login=await fetch(BASE+'/api/employees/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});expect(login.status).toBe(200);const adminCookie=cookie;cookie=(login.headers.get('set-cookie')||'').split(';')[0];
 try{
  const p={customer_id:customer,branch_id:branch,items:[{product_id:product,quantity:1}],discount_mode:'percentage',discount_value:10};
  expect((await api('POST','/transactions/hold',p)).status).toBe(403);
  const card=Number((await sql('INSERT INTO discount_card_types(name,discount_percent,active) VALUES(?,10,1)',['Card '+op()])).lastInsertRowid);await sql('UPDATE customers SET discount_card_type_id=? WHERE id=?',[card,customer]);
  const valid=await api('POST','/transactions/hold',{...p,discount_source:'customer_discount_card',discount_value:99});expect(valid.status,JSON.stringify(valid.body)).toBe(201);expect(valid.body.discount_amount).toBe(10);expect(valid.body.discount_source).toBe('customer_discount_card');
  await sql('UPDATE discount_card_types SET active=0 WHERE id=?',[card]);expect((await api('POST','/transactions/hold',{...p,discount_source:'customer_discount_card'})).status).toBe(400);
 }finally{cookie=adminCookie}
});
