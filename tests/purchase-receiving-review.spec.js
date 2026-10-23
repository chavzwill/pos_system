import {test,expect} from '@playwright/test';
const BASE='http://localhost:3001',user=process.env.POS_TEST_USER||'admin',password=process.env.POS_TEST_PASSWORD||'CI-Test-Auth!2026';
async function login(u=user,p=password){
 const response=await fetch(BASE+'/api/employees/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})});
 expect(response.status).toBe(200);
 return (response.headers.get('set-cookie')||'').split(';')[0];
}
async function api(cookie,method,path,body,key){
 const response=await fetch(BASE+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},body:body==null?undefined:JSON.stringify(body)});
 return{status:response.status,body:await response.json().catch(()=>({}))};
}
test('receiving review tracks backorders, reports cost exceptions, and gates retail repricing',async()=>{
 const cookie=await login(),[suppliers,branches,products,staff]=await Promise.all([
  api(cookie,'GET','/api/suppliers'),api(cookie,'GET','/api/branches'),api(cookie,'GET','/api/products'),api(cookie,'GET','/api/employees')
 ]);
 expect(suppliers.status).toBe(200);expect(branches.status).toBe(200);expect(products.status).toBe(200);
 const supplier=suppliers.body.find(x=>x.active!==0),branch=branches.body.find(x=>x.active!==0);
 const product=products.body.find(x=>x.active!==0&&!x.is_service&&!x.is_rental);
 expect(supplier&&branch&&product).toBeTruthy();
 const originalPrice=Number(product.price),newPrice=Number((originalPrice+4.37).toFixed(2));
 const po=await api(cookie,'POST','/api/purchase-orders',{
  supplier_id:supplier.id,branch_id:branch.id,
  ship_to_branch_id:branch.id,ship_to_name:branch.name,ship_to_address:branch.address||'1 QA Road',
  ship_to_city:branch.city||'Kingston',ship_to_state:branch.state||'Kingston',
  items:[{product_id:product.id,product_name:product.name,quantity_ordered:3,unit_cost:Number(product.cost)||1}],
  approval_purpose:'Restock for controlled receiving backorder review',
  requested_for:'Retail replenishment operations'
 });
 expect(po.status).toBe(201);
 const poId=po.body.id,lineId=po.body.items[0].id;
 const root='/api/purchase-orders/receiving-controls/review',order=root+'/orders/'+poId;
 const before=await api(cookie,'GET',order);
 expect(before.status).toBe(200);expect(before.body.lines[0].backorder_qty).toBe(3);
 const prematurely=await api(cookie,'POST',order+'/price-proposals',{item_id:lineId,proposed_price:newPrice,reason:'New supplier invoice'});
 expect(prematurely.status).toBe(409);
 const unapprovedFollow=await api(cookie,'POST',order+'/backorders/'+lineId,{expected_date:'2026-11-05',supplier_reference:'QA-ACK',supplier_response:'Supplier promised second shipment'});
 expect(unapprovedFollow.status).toBe(409);
 const approved=await api(cookie,'PATCH','/api/purchase-orders/'+poId+'/status',{status:'approved'});
 expect(approved.status).toBe(200);
 const follow=await api(cookie,'POST',order+'/backorders/'+lineId,{expected_date:'2026-11-05',supplier_reference:'QA-ACK',supplier_response:'Supplier promised outstanding units'});
 expect(follow.status).toBe(201);expect(follow.body.backorder_qty).toBe(3);
 const receipt=await api(cookie,'PATCH','/api/purchase-orders/'+poId+'/receive',{items:[{item_id:lineId,quantity_received:1}]},'receive-review-'+Date.now()+'-'+Math.random());
 expect(receipt.status).toBe(200);expect(receipt.body.status).toBe('partial');
 const review=await api(cookie,'GET',order);
 expect(review.status).toBe(200);
 expect(review.body.lines[0].backorder_qty).toBe(2);
 expect(review.body.lines[0].supplier_eta).toBe('2026-11-05');
 const request=await api(cookie,'POST',order+'/price-proposals',{item_id:lineId,proposed_price:newPrice.toFixed(2),reason:'Updated landed supplier cost requires retail margin review'});
 expect(request.status).toBe(201);expect(request.body.status).toBe('pending');
 const duplicate=await api(cookie,'POST',order+'/price-proposals',{item_id:lineId,proposed_price:(newPrice+1).toFixed(2),reason:'Second pending proposal'});
 expect(duplicate.status).toBe(409);
 const self=await api(cookie,'POST',root+'/price-proposals/'+request.body.id+'/decision',{decision:'approve',reason:'Approved by same employee'});
 expect(self.status).toBe(403);
 const unchanged=await api(cookie,'GET','/api/products/'+product.id);
 expect(unchanged.status).toBe(200);expect(Number(unchanged.body.price)).toBe(originalPrice);
 // Only a second, permissioned staff session may apply a retail price.
 expect(staff.status).toBe(200);
 const employeeRows=Array.isArray(staff.body)?staff.body:staff.body?.employees||[];
 const primary=employeeRows.find(x=>x.username===user);
 expect(primary).toBeTruthy();
 const stamp=Date.now().toString(36),secondUser='priceApprover'+stamp,secondPass='CI-Price-'+stamp+'!';
 const created=await api(cookie,'POST','/api/employees',{first_name:'Synthetic',last_name:'PriceReviewer',username:secondUser,pin:'683257',password:secondPass,must_change_password:false,security_group_id:primary.security_group_id,default_branch_id:branch.id});
 expect(created.status).toBe(201);
 const reviewer=await login(secondUser,secondPass);
 const decided=await api(reviewer,'POST',root+'/price-proposals/'+request.body.id+'/decision',{decision:'approve',reason:'Verified new margin and supplier receipt'});
 expect(decided.status).toBe(200);expect(decided.body.status).toBe('approved');
 const changed=await api(cookie,'GET','/api/products/'+product.id);
 expect(changed.status).toBe(200);expect(Number(changed.body.price)).toBe(newPrice);
 const repeat=await api(reviewer,'POST',root+'/price-proposals/'+request.body.id+'/decision',{decision:'approve',reason:'Repeated attempt'});
 expect(repeat.status).toBe(409);
 const final=await api(cookie,'GET',order);
 expect(final.body.price_proposals.find(x=>x.id===request.body.id).status).toBe('approved');
});
test('receiving-review launcher is accessible from purchasing and mobile dialog fits viewport',async({page})=>{
 await page.goto('/app-shell.html');
 const signIn=page.locator('#shell-login');
 if(await signIn.count()){
  await signIn.locator('input[name=username]').fill(user);
  await signIn.locator('input[name=password]').fill(password);
  await signIn.locator('button').first().click();
 }
 await expect(page.locator('.shell-app')).toBeVisible();
 await page.locator('.shell-nav [data-domain=purchasing]').click();
 const feature=page.locator('#shell-root [data-open=purchasing-workspace]').first();
 await expect(feature).toBeVisible();await feature.click();
 const launcher=page.locator('#tt-purchasing-workspace .tt-rr-launch');
 await expect(launcher).toBeVisible();await launcher.click();
 await expect(page.locator('.tt-rr__panel')).toBeVisible();
 await expect(page.locator('#tt-rr-title')).toContainText('Receiving review');
 for(const width of [390,320]){
  await page.setViewportSize({width,height:750});
  const bounds=await page.locator('.tt-rr__panel').boundingBox();
  expect(bounds).not.toBeNull();expect(bounds.x).toBeGreaterThanOrEqual(-1);
  expect(bounds.x+bounds.width).toBeLessThanOrEqual(width+1);
 }
});
