import {test,expect} from '@playwright/test';
const BASE='http://localhost:3001',USER=process.env.POS_TEST_USER||'admin',PASS=process.env.POS_TEST_PASSWORD||'123456';
async function login(user=USER,password=PASS){const r=await fetch(BASE+'/api/employees/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:user,password})});expect(r.status).toBe(200);return(r.headers.get('set-cookie')||'').split(';')[0];}
async function api(cookie,method,path,body,key){const r=await fetch(BASE+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},body:body===undefined?undefined:JSON.stringify(body)});return{status:r.status,body:await r.json().catch(()=>({}))};}
const key=()=> 'receipt-price-'+crypto.randomUUID();
async function fixture(cookie){
 const [suppliers,branches,products]=await Promise.all([api(cookie,'GET','/api/suppliers'),api(cookie,'GET','/api/branches'),api(cookie,'GET','/api/products')]);
 const supplier=suppliers.body.find(x=>x.active!==0),branch=branches.body.find(x=>x.active!==0),product=products.body.find(x=>x.active!==0&&!x.is_service&&!x.is_rental&&!x.is_non_inventory);
 const po=await api(cookie,'POST','/api/purchase-orders',{supplier_id:supplier.id,branch_id:branch.id,ship_to_branch_id:branch.id,ship_to_name:branch.name,ship_to_address:branch.address||'1 Test Street',ship_to_city:branch.city||'Kingston',ship_to_state:branch.state||'Kingston',approval_purpose:'Verify receiving price adjustment',requested_for:'Retail inventory',items:[{product_id:product.id,product_name:product.name,quantity_ordered:3,unit_cost:10}]});
 expect(po.status,JSON.stringify(po.body)).toBe(201);expect((await api(cookie,'PATCH','/api/purchase-orders/'+po.body.id+'/status',{status:'approved'})).status).toBe(200);
 return{supplier,branch,product,poId:po.body.id,itemId:po.body.items[0].id};
}
const review=id=>'/api/purchase-orders/receiving-controls/review/orders/'+id;
test('receipt adjusts actual cost and queues retail approval atomically without changing ordered cost or posting AP',async()=>{
 const cookie=await login(),f=await fixture(cookie),newPrice=(Number(f.product.price)+7.19).toFixed(2);
 const before=await api(cookie,'GET','/api/supplier-ledger/overview');
 const body={items:[{item_id:f.itemId,quantity_received:1,receipt_unit_cost:'12.3456',proposed_retail_price:newPrice,expected_retail_price:Number(f.product.price).toFixed(2),pricing_reason:'Supplier delivery cost changed; preserve retail margin'}]};
 const operation=key(),url='/api/purchase-orders/'+f.poId+'/receive';
 const received=await api(cookie,'PATCH',url,body,operation);expect(received.status,JSON.stringify(received.body)).toBe(200);
 const product=await api(cookie,'GET','/api/products/'+f.product.id);expect(Number(product.body.cost)).toBe(12.3456);expect(Number(product.body.price)).toBe(Number(f.product.price));
 expect(Number(received.body.items[0].unit_cost)).toBe(10);expect(received.body.price_adjustments[0].receipt_unit_cost).toBe(12.3456);
 const details=await api(cookie,'GET',review(f.poId));expect(details.body.cost_adjustments).toHaveLength(1);expect(details.body.price_proposals).toHaveLength(1);expect(details.body.price_proposals[0].purchase_receipt_item_id).toBe(received.body.price_adjustments[0].receipt_item_id);
 const receipts=await api(cookie,'GET','/api/purchase-orders/receiving-controls/invoice-receipts/orders/'+f.poId);expect(Number(receipts.body.receipt_items[0].unit_cost)).toBe(12.3456);
 const replay=await api(cookie,'PATCH',url,body,operation);expect(replay.status).toBe(200);expect(replay.body.receipt_id).toBe(received.body.receipt_id);
 expect((await api(cookie,'GET',review(f.poId))).body.price_proposals).toHaveLength(1);
 expect((await api(cookie,'GET','/api/supplier-ledger/overview')).body.summary.open_ap).toBe(before.body.summary.open_ap);
 const refused=await api(cookie,'POST','/api/purchase-orders/receiving-controls/review/price-proposals/'+details.body.price_proposals[0].id+'/decision',{decision:'approve',reason:'Attempt by receiving staff'});expect(refused.status).toBe(403);
 // Clear the pending proposal so other receiving tests can use this catalog item.
 const staff=await api(cookie,'GET','/api/employees'),primary=staff.body.find(x=>x.username===USER),stamp=Date.now().toString(36),u='priceSecond'+stamp,p='CI-Receive-'+stamp+'!';
 expect((await api(cookie,'POST','/api/employees',{first_name:'Test',last_name:'Reviewer',username:u,pin:'681397',password:p,must_change_password:false,security_group_id:primary.security_group_id,default_branch_id:f.branch.id})).status).toBe(201);
 const reviewer=await login(u,p);const approved=await api(reviewer,'POST','/api/purchase-orders/receiving-controls/review/price-proposals/'+details.body.price_proposals[0].id+'/decision',{decision:'approve',reason:'Delivery cost and margin independently verified'});expect(approved.status).toBe(200);
 expect(Number((await api(cookie,'GET','/api/products/'+f.product.id)).body.price)).toBe(Number(newPrice));
});
test('invalid or stale receiving prices reject the whole receipt without adding stock',async()=>{
 const cookie=await login(),f=await fixture(cookie),url='/api/purchase-orders/'+f.poId+'/receive';
 for(const patch of [{receipt_unit_cost:'-1'},{receipt_unit_cost:'NaN'},{receipt_unit_cost:'12.34567'},{receipt_unit_cost:'12'},{proposed_retail_price:'20',expected_retail_price:'999999',pricing_reason:'Stale price version'}]){
  const r=await api(cookie,'PATCH',url,{items:[{item_id:f.itemId,quantity_received:1,...patch}]},key());expect([400,409],JSON.stringify(r.body)).toContain(r.status);
 }
 const after=await api(cookie,'GET','/api/products/'+f.product.id);expect(Number(after.body.stock_qty)).toBe(Number(f.product.stock_qty));
 const details=await api(cookie,'GET',review(f.poId));expect(Number(details.body.lines[0].quantity_received)).toBe(0);
});
test('Fast Receive exposes cost and retail fields and records delivery pricing on desktop and phones',async({page},testInfo)=>{
 const cookie=await login(),f=await fixture(cookie),[name,...value]=cookie.split('=');await page.context().addCookies([{name,value:value.join('='),url:BASE}]);
 await page.goto('/app-shell.html');await page.waitForFunction(()=>!!window.TotalToolsFastReceiving);await page.evaluate(id=>window.TotalToolsFastReceiving.open(id),f.poId);
 const panel=page.locator('.tt-fr__panel');await expect(panel.locator('[data-qty]').first()).toBeVisible();await panel.locator('[data-qty]').first().fill('1');await panel.locator('[data-qty]').first().dispatchEvent('change');
 await panel.getByText('Delivery cost & retail price',{exact:true}).click();
 await panel.getByLabel('Actual receipt unit cost (JMD)').fill('13.25');await panel.getByLabel('Pricing reason').fill('Actual delivery cost from supplier packing slip');
 for(const width of [1280,390,320]){await page.setViewportSize({width,height:850});const box=await panel.boundingBox();expect(box.x+box.width).toBeLessThanOrEqual(width+1);expect(await panel.locator('#tt-fr-body').evaluate(el=>el.scrollWidth-el.clientWidth)).toBeLessThanOrEqual(1);await panel.locator('.tt-fr__pricing').scrollIntoViewIfNeeded();await panel.screenshot({path:testInfo.outputPath('receiving-prices-'+width+'.png')});}
 await panel.getByRole('button',{name:'Receive selected items',exact:true}).click();
 await expect(panel.locator('#tt-fr-message')).toContainText('recorded successfully');expect(Number((await api(cookie,'GET','/api/products/'+f.product.id)).body.cost)).toBe(13.25);
});
test('receiving-only staff cannot override cost, and a pending retail review cannot leave a partial receipt',async()=>{
 const cookie=await login(),f=await fixture(cookie),stamp=Date.now().toString(36),u='receiveOnly'+stamp,p='CI-Receiver-'+stamp+'!';
 expect((await api(cookie,'POST','/api/employees/reauth-self',{purpose:'security_admin',password:PASS})).status).toBe(200);
 const group=await api(cookie,'POST','/api/security-groups',{name:'ReceiptOnly '+stamp,reason:'Create restricted receiver test account',permissions:{purchasing_receive:true}});expect(group.status,JSON.stringify(group.body)).toBe(201);
 expect((await api(cookie,'POST','/api/employees',{first_name:'Test',last_name:'Receiver',username:u,pin:'681392',password:p,must_change_password:false,security_group_id:group.body.id,default_branch_id:f.branch.id})).status).toBe(201);
 const receiver=await login(u,p),url='/api/purchase-orders/'+f.poId+'/receive';
 const denied=await api(receiver,'PATCH',url,{items:[{item_id:f.itemId,quantity_received:1,receipt_unit_cost:'15',pricing_reason:'Unauthorized cost override'}]},key());expect(denied.status,JSON.stringify(denied.body)).toBe(403);
 const retail=(Number(f.product.price)+1.73).toFixed(2),body={items:[{item_id:f.itemId,quantity_received:1,proposed_retail_price:retail,expected_retail_price:Number(f.product.price).toFixed(2),pricing_reason:'New stock price request from receiver'}]};
 const first=await api(receiver,'PATCH',url,body,key());expect(first.status,JSON.stringify(first.body)).toBe(200);
 const duplicate=await api(cookie,'PATCH',url,{items:[{...body.items[0],receipt_unit_cost:'14'}]},key());expect(duplicate.status,JSON.stringify(duplicate.body)).toBe(409);
 const current=await api(cookie,'GET','/api/products/'+f.product.id);expect(Number(current.body.stock_qty)).toBe(Number(f.product.stock_qty)+1);expect(Number(current.body.cost)).toBe(10);
 const details=await api(cookie,'GET',review(f.poId));expect(details.body.price_proposals).toHaveLength(1);expect(details.body.cost_adjustments).toHaveLength(0);expect(Number(details.body.lines[0].quantity_received)).toBe(1);
 const rejected=await api(cookie,'POST','/api/purchase-orders/receiving-controls/review/price-proposals/'+details.body.price_proposals[0].id+'/decision',{decision:'reject',reason:'Keep current selling price after margin review'});expect(rejected.status).toBe(200);
});
