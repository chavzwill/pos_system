import {test,expect} from '@playwright/test';
const BASE='http://localhost:3001';
const user=process.env.POS_TEST_USER||'admin',pw=process.env.POS_TEST_PASSWORD||'123456';
const key=()=>'receipt-invoice-'+Date.now()+'-'+Math.random().toString(36).slice(2);
async function login(){
 const r=await fetch(BASE+'/api/employees/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:user,password:pw})});
 expect(r.status).toBe(200);return(r.headers.get('set-cookie')||'').split(';')[0];
}
async function api(cookie,method,path,body,op){
 const r=await fetch(BASE+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json',...(op?{'Idempotency-Key':op}:{})},body:body===undefined?undefined:JSON.stringify(body)});
 return{status:r.status,body:await r.json().catch(()=>({}))};
}
test('one posted supplier invoice links to two deliveries without duplicate payable or stock',async()=>{
 const cookie=await login();
 const [a,b,c]=await Promise.all(['/api/suppliers','/api/branches','/api/products'].map(x=>api(cookie,'GET',x)));
 const supplier=a.body.find(x=>x.active!==0),branch=b.body.find(x=>x.active!==0),product=c.body.find(x=>x.active!==0&&!x.is_service&&!x.is_rental);
 expect(supplier&&branch&&product).toBeTruthy();
 const cost=Number(product.cost)||2;
 const created=await api(cookie,'POST','/api/purchase-orders',{supplier_id:supplier.id,branch_id:branch.id,ship_to_branch_id:branch.id,ship_to_name:branch.name,ship_to_address:branch.address||'1 QA Road',ship_to_city:branch.city||'Kingston',ship_to_state:branch.state||'Kingston',items:[{product_id:product.id,quantity_ordered:3,unit_cost:cost}],approval_purpose:'Split supplier invoice delivery',requested_for:'Retail replenishment'});
 expect(created.status).toBe(201);const poId=created.body.id,poLine=created.body.items[0].id;
 expect((await api(cookie,'PATCH','/api/purchase-orders/'+poId+'/status',{status:'approved'})).status).toBe(200);
 for(let i=0;i<2;i++)expect((await api(cookie,'PATCH','/api/purchase-orders/'+poId+'/receive',{items:[{item_id:poLine,quantity_received:1}]},key())).status).toBe(200);
 const root='/api/purchase-orders/receiving-controls/invoices';
 const overview=await api(cookie,'GET',root+'/orders/'+poId);
 expect(overview.status).toBe(200);expect(overview.body.receipts).toHaveLength(2);
 const receipts=overview.body.receipts,total=receipts.reduce((a,r)=>a+Number(r.total_cost),0).toFixed(2);
 const number='RECINVOICE'+Date.now()+Math.random().toString(36).slice(2,6);
 const first={invoice_number:number,invoice_date:'2026-10-23',invoice_subtotal:total,allocated_value:Number(receipts[0].total_cost).toFixed(2),notes:'First delivery'};
 const saved=await api(cookie,'POST',root+'/receipts/'+receipts[0].id,first);
 expect(saved.status).toBe(201);expect(saved.body.finance_status).toBe('pending_ap');
 const replay=await api(cookie,'POST',root+'/receipts/'+receipts[0].id,first);
 expect(replay.status).toBe(200);expect(replay.body.replayed).toBe(true);
 const wrong=await api(cookie,'POST',root+'/receipts/'+receipts[0].id,{...first,allocated_value:total});
 expect(wrong.status).toBe(409);
 const second=await api(cookie,'POST',root+'/receipts/'+receipts[1].id,{...first,allocated_value:Number(receipts[1].total_cost).toFixed(2),notes:'Second delivery'});
 expect(second.status).toBe(201);
 const pending=await api(cookie,'GET',root+'/orders/'+poId);
 expect(pending.body.evidence).toHaveLength(2);
 expect(pending.body.receipts.every(x=>x.unmatched_receipt_cents===0)).toBe(true);
 expect((await api(cookie,'POST',root+'/evidence/'+saved.body.id+'/confirm',{supplier_invoice_id:9999999})).status).toBe(409);
 const posted=await api(cookie,'POST','/api/supplier-ledger/invoices',{supplier_id:supplier.id,purchase_order_id:poId,branch_id:branch.id,invoice_number:number,invoice_date:'2026-10-23',subtotal:total,tax_amount:0,freight_amount:0,duty_amount:0,other_landed_cost_amount:0,total,notes:'AP posted once for split delivery'});
 expect(posted.status).toBe(201);
 expect((await api(cookie,'POST',root+'/evidence/'+saved.body.id+'/confirm',{supplier_invoice_id:posted.body.id})).status).toBe(200);
 expect((await api(cookie,'POST',root+'/evidence/'+second.body.id+'/confirm',{supplier_invoice_id:posted.body.id})).status).toBe(200);
 const repeat=await api(cookie,'POST',root+'/evidence/'+saved.body.id+'/confirm',{supplier_invoice_id:posted.body.id});
 expect(repeat.status).toBe(200);expect(repeat.body.replayed).toBe(true);
 const matched=await api(cookie,'GET',root+'/orders/'+poId);
 expect(matched.body.evidence.filter(x=>x.finance_status==='linked_posted')).toHaveLength(2);
 const invoices=await api(cookie,'GET','/api/supplier-ledger/invoices?supplier_id='+supplier.id+'&status=all&limit=500');
 expect(invoices.status).toBe(200);expect(invoices.body.filter(x=>Number(x.id)===Number(posted.body.id))).toHaveLength(1);
 const po=await api(cookie,'GET','/api/purchase-orders/'+poId);
 expect(po.status).toBe(200);expect(Number(po.body.items[0].quantity_received)).toBe(2);
});
test('supplier invoice link button is shown in receiving review',async({page})=>{
 await page.goto('/app-shell.html');
 const loginPanel=page.locator('#shell-login');
 if(await loginPanel.count()){await loginPanel.locator('input[name=username]').fill(user);await loginPanel.locator('input[name=password]').fill(pw);await loginPanel.locator('button').first().click();}
 await expect(page.locator('.shell-app')).toBeVisible();
 await page.locator('.shell-nav [data-domain=purchasing]').click();
 const purchasing=page.locator('#shell-root [data-open=purchasing-workspace]').first();
 await expect(purchasing).toBeVisible();await purchasing.click();
 const composer=page.locator('#tt-purchasing-workspace .tt-purch__composer');
 if(await composer.count())await composer.locator('[data-compose-close]').first().click();
 const review=page.locator('#tt-purchasing-workspace .tt-rr-launch');
 await expect(review).toBeVisible();await review.click();
 await expect(page.locator('#tt-rr-invoice-links')).toBeVisible();
 for(const width of [390,320]){
  await page.setViewportSize({width,height:750});
  const box=await page.locator('.tt-rr__panel').boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.x+box.width).toBeLessThanOrEqual(width+1);
 }
});
