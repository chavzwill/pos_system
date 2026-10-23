import {test,expect} from '@playwright/test';
const BASE='http://localhost:3001',USER=process.env.POS_TEST_USER||'admin',PASSWORD=process.env.POS_TEST_PASSWORD||'123456';
async function login(){
 const r=await fetch(BASE+'/api/employees/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:USER,password:PASSWORD})});
 expect(r.status).toBe(200);
 return(r.headers.get('set-cookie')||'').split(';')[0];
}
async function api(cookie,method,path,body,key){
 const r=await fetch(BASE+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json',Accept:'application/json',...(key?{'Idempotency-Key':key}:{})},body:body===undefined?undefined:JSON.stringify(body)});
 return{status:r.status,body:await r.json().catch(()=>({}))};
}
const key=()=>String('invoice-receipt-ci-'+Date.now()+'-'+Math.random()).replace(/[^a-zA-Z0-9.-]/g,'');
test('posted supplier invoice reconciles to two partial delivery receipt lines without duplicating AP or retail stock',async()=>{
 const cookie=await login(),[suppliers,branches,products]=await Promise.all([
  api(cookie,'GET','/api/suppliers'),api(cookie,'GET','/api/branches'),api(cookie,'GET','/api/products')
 ]);
 const supplier=suppliers.body.find(x=>x.active!==0),branch=branches.body.find(x=>x.active!==0),product=products.body.find(x=>x.active!==0&&!x.is_service&&!x.is_rental);
 expect(supplier&&branch&&product).toBeTruthy();
 const unitCost=Number(product.cost)||1;
 const create=await api(cookie,'POST','/api/purchase-orders',{
  supplier_id:supplier.id,branch_id:branch.id,ship_to_branch_id:branch.id,
  ship_to_name:branch.name,ship_to_address:branch.address||'1 Test Street',
  ship_to_city:branch.city||'Kingston',ship_to_state:branch.state||'Kingston',
  approval_purpose:'Supplier invoice receipt linking verification',
  requested_for:'Receiving and payables',
  items:[{product_id:product.id,product_name:product.name,quantity_ordered:3,unit_cost:unitCost}]
 });
 expect(create.status,JSON.stringify(create.body)).toBe(201);
 const poId=create.body.id,lineId=create.body.items[0].id,root='/api/purchase-orders/receiving-controls/invoice-receipts';
 const unreceived=await api(cookie,'GET',root+'/orders/'+poId);
 expect(unreceived.status).toBe(200);expect(unreceived.body.receipt_items).toHaveLength(0);
 const approved=await api(cookie,'PATCH','/api/purchase-orders/'+poId+'/status',{status:'approved'});
 expect(approved.status).toBe(200);
 const one=await api(cookie,'PATCH','/api/purchase-orders/'+poId+'/receive',{items:[{item_id:lineId,quantity_received:1}]},key());
 expect(one.status,JSON.stringify(one.body)).toBe(200);
 const two=await api(cookie,'PATCH','/api/purchase-orders/'+poId+'/receive',{items:[{item_id:lineId,quantity_received:2}]},key());
 expect(two.status,JSON.stringify(two.body)).toBe(200);
 const matches=await api(cookie,'GET',root+'/orders/'+poId);
 expect(matches.status).toBe(200);expect(matches.body.receipt_items).toHaveLength(2);
 const date=new Date().toISOString().slice(0,10);
 const subtotal=Number((unitCost*3).toFixed(2));
 const invoice=await api(cookie,'POST','/api/supplier-ledger/invoices',{
  supplier_id:supplier.id,purchase_order_id:poId,branch_id:branch.id,
  invoice_number:'CI-RECEIPT-LINK-'+Date.now()+'-'+Math.random().toString(36).slice(2,6),
  invoice_date:date,subtotal,total:subtotal,tax_amount:0,
  freight_amount:0,duty_amount:0,other_landed_cost_amount:0,
  notes:'Synthetic receipt-level invoice evidence'
 });
 expect(invoice.status,JSON.stringify(invoice.body)).toBe(201);
 const invoiceId=invoice.body.id;
 const before=await api(cookie,'GET',root+'/orders/'+poId);
 expect(before.body.invoices.some(x=>x.id===invoiceId)).toBe(true);
 const rows=before.body.receipt_items.map(x=>({receipt_item_id:x.receipt_item_id,quantity_invoiced:String(x.quantity_received),invoice_unit_cost:unitCost.toFixed(2)}));
 const mutationKey=key(),url=root+'/orders/'+poId+'/invoices/'+invoiceId+'/allocate';
 const linked=await api(cookie,'POST',url,{lines:rows},mutationKey);
 expect(linked.status,JSON.stringify(linked.body)).toBe(201);
 expect(linked.body.match_status).toBe('matched');
 expect(linked.body.payment_cleared).toBe(true);
 const replay=await api(cookie,'POST',url,{lines:rows},mutationKey);
 expect(replay.status).toBe(200);expect(replay.body.replayed).toBe(true);
 const duplicated=await api(cookie,'POST',url,{lines:rows},key());
 expect(duplicated.status).toBe(409);
 const stale=await api(cookie,'POST',url,{lines:rows.map(x=>({...x,invoice_unit_cost:'1.25'}))},mutationKey);
 expect(stale.status).toBe(409);
 const after=await api(cookie,'GET',root+'/orders/'+poId);
 expect(after.body.links.filter(x=>x.supplier_invoice_id===invoiceId)).toHaveLength(2);
 expect(after.body.receipt_items.every(x=>Number(x.remaining_qty)===0)).toBe(true);
 const invRows=await api(cookie,'GET','/api/supplier-ledger/invoices?status=all&supplier_id='+supplier.id);
 expect(invRows.status).toBe(200);
 expect(invRows.body.filter(x=>x.id===invoiceId)).toHaveLength(1);
});
test('receiving review exposes invoice link interface without mobile horizontal overflow',async({page})=>{
 await page.goto('/app-shell.html');
 const loginForm=page.locator('#shell-login');
 if(await loginForm.count()){
  await loginForm.locator('input[name=username]').fill(USER);
  await loginForm.locator('input[name=password]').fill(PASSWORD);
  await loginForm.locator('button').first().click();
 }
 await expect(page.locator('.shell-app')).toBeVisible();
 await page.locator('.shell-nav [data-domain=purchasing]').click();
 const feature=page.locator('#shell-root [data-open="purchasing-workspace"][data-title="Purchase Orders"]').first();
 await expect(feature).toBeVisible();await feature.click();
 await page.locator('#tt-purchasing-workspace .tt-rr-launch').click();
 await expect(page.locator('.tt-rr__panel')).toBeVisible();
 await expect(page.locator('.tt-ir-launch')).toBeVisible();
 for(const width of [390,320]){
  await page.setViewportSize({width,height:750});
  const box=await page.locator('.tt-rr__panel').boundingBox();
  expect(box).not.toBeNull();expect(box.x+box.width).toBeLessThanOrEqual(width+1);
 }
});
test('capture screen matches received goods before Finance posts AP, at desktop and phone widths',async({page},testInfo)=>{
 const cookie=await login();
 const [suppliers,branches,products]=await Promise.all([api(cookie,'GET','/api/suppliers'),api(cookie,'GET','/api/branches'),api(cookie,'GET','/api/products')]);
 const supplier=suppliers.body.find(x=>x.active!==0),branch=branches.body.find(x=>x.active!==0),product=products.body.find(x=>x.active!==0&&!x.is_service&&!x.is_rental);
 const create=await api(cookie,'POST','/api/purchase-orders',{
  supplier_id:supplier.id,branch_id:branch.id,ship_to_branch_id:branch.id,ship_to_name:branch.name,ship_to_address:branch.address||'1 Test Street',ship_to_city:branch.city||'Kingston',ship_to_state:branch.state||'Kingston',
  approval_purpose:'Pre-posting supplier invoice workflow verification',requested_for:'Receiving and Finance',items:[{product_id:product.id,product_name:product.name,quantity_ordered:2,unit_cost:10}]
 });
 expect(create.status,JSON.stringify(create.body)).toBe(201);const poId=create.body.id;
 expect((await api(cookie,'PATCH','/api/purchase-orders/'+poId+'/status',{status:'approved'})).status).toBe(200);
 expect((await api(cookie,'PATCH','/api/purchase-orders/'+poId+'/receive',{items:[{item_id:create.body.items[0].id,quantity_received:2}]},key())).status).toBe(200);
 const [name,...value]=cookie.split('=');await page.context().addCookies([{name,value:value.join('='),url:BASE}]);
 await page.goto('/app-shell.html');await page.waitForFunction(()=>!!window.TotalToolsInvoiceReceiptMatching);
 await page.evaluate(id=>window.TotalToolsInvoiceReceiptMatching.open(id),poId);
 const panel=page.locator('.tt-ir__panel');await expect(panel.locator('#tt-ir-capture')).toBeAttached();
 await panel.getByText('Capture a supplier invoice',{exact:true}).click();
 const form=panel.locator('#tt-ir-capture'),invoiceNumber='UI-CAPTURE-'+Date.now();
 await form.getByLabel('Invoice number',{exact:true}).fill(invoiceNumber);await form.getByLabel('Invoice date',{exact:true}).fill('2026-10-23');await form.getByLabel('Merchandise subtotal (JMD)',{exact:true}).fill('20');
 for(const width of [1280,768,390,320]){
  await page.setViewportSize({width,height:850});
  const bounds=await panel.boundingBox();expect(bounds.x).toBeGreaterThanOrEqual(0);expect(bounds.x+bounds.width).toBeLessThanOrEqual(width+1);
  const overflow=await panel.locator('.tt-ir__body').evaluate(el=>el.scrollWidth-el.clientWidth);expect(overflow).toBeLessThanOrEqual(1);
 }
 await form.getByRole('button',{name:'Save captured invoice',exact:true}).click();
 await expect(panel.locator('.tt-ir__status')).toHaveText('Invoice captured. Stock and Accounts Payable are unchanged.');
 await expect(panel.getByRole('heading',{name:'Captured — not posted to Accounts Payable'})).toBeVisible();
 const captures=await api(cookie,'GET','/api/supplier-ledger/captured-invoices?purchase_order_id='+poId);expect(captures.body.invoices).toHaveLength(1);expect(captures.body.invoices[0].supplier_invoice_id).toBeNull();
 await panel.locator('input[name=qty]').fill('2');await panel.getByRole('button',{name:'Link invoice to received goods',exact:true}).click();
 await expect(panel.locator('.tt-ir__status')).toHaveText('Delivery evidence saved. Invoice remains captured and unposted.');
 for(const width of [1280,390]){await page.setViewportSize({width,height:850});await panel.screenshot({path:testInfo.outputPath('captured-invoice-'+width+'.png')});}
 await panel.getByRole('button',{name:'Post invoice to Accounts Payable',exact:true}).click();
 await expect(panel.locator('.tt-ir__status')).toHaveText('Invoice posted to Accounts Payable. Delivery evidence matches.');
 const invoices=await api(cookie,'GET','/api/supplier-ledger/invoices?status=all&supplier_id='+supplier.id);expect(invoices.body.filter(x=>x.invoice_number===invoiceNumber)).toHaveLength(1);
 await expect(panel.getByRole('button',{name:'Post invoice to Accounts Payable',exact:true})).toHaveCount(0);
});
