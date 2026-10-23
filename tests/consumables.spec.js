import {test,expect} from '@playwright/test';
const BASE='http://localhost:3001';
const adminName=process.env.POS_TEST_USER||'admin',adminPassword=process.env.POS_TEST_PASSWORD||'123456';
const key=()=>'ci-consumable-'+Date.now()+'-'+Math.random().toString(36).slice(2);
async function login(username=adminName,password=adminPassword){
 const r=await fetch(BASE+'/api/employees/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
 expect(r.status).toBe(200);
 return(r.headers.get('set-cookie')||'').split(';')[0];
}
async function api(cookie,method,path,body,requestKey){
 const r=await fetch(BASE+path,{method,headers:{Cookie:cookie,Accept:'application/json',...(body!==undefined?{'Content-Type':'application/json'}:{}),...(requestKey?{'Idempotency-Key':requestKey}:{})},body:body===undefined?undefined:JSON.stringify(body)});
 return{status:r.status,body:await r.json().catch(()=>null)};
}
test('separate consumable POs: approvals, partial receipt, allocations and idempotency',async()=>{
 const admin=await login();
 const [branches,suppliers,products,employeeList]=await Promise.all([
  api(admin,'GET','/api/branches'),api(admin,'GET','/api/suppliers'),
  api(admin,'GET','/api/products'),api(admin,'GET','/api/employees')
 ]);
 expect(branches.status).toBe(200);expect(suppliers.status).toBe(200);expect(products.status).toBe(200);
 const branch=branches.body.find(x=>x.active!==0),supplier=suppliers.body.find(x=>x.active!==0);
 expect(branch).toBeTruthy();expect(supplier).toBeTruthy();
 const ordinary=products.body.find(x=>x.active!==0&&!x.is_service&&!x.is_rental);
 expect(ordinary).toBeTruthy();
 const priorStock=Number(ordinary.stock_qty);
 const stamp=Date.now().toString()+Math.random().toString(36).slice(2,6);
 const cat=await api(admin,'POST','/api/consumables/catalog',{sku:'CI-CONS-'+stamp,name:'Synthetic workshop gloves '+stamp,uom:'pair'},key());
 expect(cat.status).toBe(201);
 const body={supplier_id:supplier.id,branch_id:branch.id,reason:'Scheduled workshop and rental maintenance',requested_for:'Maintenance and rental operations',allocation_type:'branch',items:[{consumable_id:cat.body.id,quantity:12,unit_cost:'3.25'}]};
 const createKey=key();
 const created=await api(admin,'POST','/api/consumables/orders',body,createKey);
 expect(created.status).toBe(201);
 expect(created.body.po_number).toMatch(/^CPO-\d{6,}$/);
 expect(created.body.total_cents).toBe(3900);
 const replay=await api(admin,'POST','/api/consumables/orders',body,createKey);
 expect(replay.status).toBe(200);expect(replay.body.replayed).toBe(true);expect(replay.body.id).toBe(created.body.id);
 const conflict=await api(admin,'POST','/api/consumables/orders',{...body,reason:'Different reason'},createKey);
 expect(conflict.status).toBe(409);
 const opened=await api(admin,'GET','/api/consumables/orders/'+created.body.id);
 expect(opened.status).toBe(200);expect(opened.body.items).toHaveLength(1);
 const lineId=opened.body.items[0].id,orderPath='/api/consumables/orders/'+created.body.id;
 const rejectedEarly=await api(admin,'POST',orderPath+'/receive',{items:[{line_id:lineId,quantity:1}]},key());
 expect(rejectedEarly.status).toBe(409);
 const submitted=await api(admin,'POST',orderPath+'/submit',{},key());
 expect(submitted.status).toBe(200);
 const selfApprove=await api(admin,'POST',orderPath+'/approve',{},key());
 expect(selfApprove.status).toBe(403);
 expect(employeeList.status).toBe(200);
 const empRows=Array.isArray(employeeList.body)?employeeList.body:employeeList.body?.employees||[];
 const primary=empRows.find(x=>x.username===adminName);
 expect(primary).toBeTruthy();
 const secondName='consumableApprover'+stamp,password='CI-Approver-'+stamp+'!';
 const second=await api(admin,'POST','/api/employees',{first_name:'Synthetic',last_name:'Approver',username:secondName,pin:'753186',password,must_change_password:false,security_group_id:primary.security_group_id,default_branch_id:branch.id});
 expect(second.status).toBe(201);
 const approver=await login(secondName,password);
 const approved=await api(approver,'POST',orderPath+'/approve',{},key());
 expect(approved.status).toBe(200);
 const receiptKey=key(),receiptPayload={items:[{line_id:lineId,quantity:5}]};
 const received=await api(admin,'POST',orderPath+'/receive',receiptPayload,receiptKey);
 expect(received.status).toBe(200);expect(received.body.status).toBe('partial');
 const receivedReplay=await api(admin,'POST',orderPath+'/receive',receiptPayload,receiptKey);
 expect(receivedReplay.status).toBe(200);expect(receivedReplay.body.replayed).toBe(true);
 const over=await api(admin,'POST',orderPath+'/receive',{items:[{line_id:lineId,quantity:8}]},key());
 expect(over.status).toBe(409);
 const balances=await api(admin,'GET','/api/consumables/balances');
 const balance=balances.body.find(x=>x.consumable_id===cat.body.id&&x.branch_id===branch.id);
 expect(balance.qty_on_hand).toBe(5);expect(balance.value_cents).toBe(1625);
 const dept=await api(admin,'POST','/api/department-approvals/departments',{code:'test-cons-'+stamp.toLowerCase(),name:'Synthetic Workshop '+stamp});
 expect(dept.status).toBe(201);
 const deptIssue={consumable_id:cat.body.id,branch_id:branch.id,quantity:2,allocation_type:'department',allocation_id:dept.body.id,purpose:'Workshop gloves for scheduled tool repairs'};
 const issued=await api(admin,'POST','/api/consumables/issues',deptIssue,key());
 expect(issued.status).toBe(200);expect(issued.body.cost_cents).toBe(650);
 const insufficient=await api(admin,'POST','/api/consumables/issues',{...deptIssue,quantity:8},key());
 expect(insufficient.status).toBe(409);
 const remainder=await api(admin,'POST',orderPath+'/receive',{items:[{line_id:lineId,quantity:7}]},key());
 expect(remainder.status).toBe(200);expect(remainder.body.status).toBe('received');
 const after=await api(admin,'GET','/api/consumables/balances');
 const current=after.body.find(x=>x.consumable_id===cat.body.id&&x.branch_id===branch.id);
 expect(current.qty_on_hand).toBe(10);expect(current.value_cents).toBe(3250);
 const rentalEquipment=await api(admin,'GET','/api/consumables/lookups');
 expect(rentalEquipment.status).toBe(200);
 let rentalProduct=rentalEquipment.body.rental_equipment?.[0];
 if(!rentalProduct){
  const newProduct=await api(admin,'POST','/api/products',{sku:'CI-RENT-'+stamp,name:'Synthetic Rental Drill '+stamp,price:50,cost:25,stock_qty:0,branch_id:branch.id,is_rental:1,active:1});
  expect(newProduct.status).toBe(201);
  rentalProduct={id:newProduct.body.id};
 }
 const rentalIssue=await api(admin,'POST','/api/consumables/issues',{consumable_id:cat.body.id,branch_id:branch.id,quantity:1,allocation_type:'rental',allocation_id:rentalProduct.id,unit_reference:'CI-UNIT-'+stamp,purpose:'Preventive service for rental machine'},key());
 expect(rentalIssue.status).toBe(200);
 const log=await api(admin,'GET','/api/consumables/usage');
 expect(log.status).toBe(200);
 expect(log.body.some(x=>x.consumable_id===cat.body.id&&x.department_id===dept.body.id&&x.quantity===2)).toBe(true);
 expect(log.body.some(x=>x.consumable_id===cat.body.id&&x.rental_unit_reference==='CI-UNIT-'+stamp)).toBe(true);
 const unchanged=await api(admin,'GET','/api/products/'+ordinary.id);
 expect(unchanged.status).toBe(200);expect(Number(unchanged.body.stock_qty)).toBe(priorStock);
});
test('consumables workspace opens at narrow mobile widths',async({page})=>{
 await page.goto('/app-shell.html?consumables-safety-test=1');
 const loginForm=page.locator('#shell-login');
 if(await loginForm.count()){
  await loginForm.locator('input[name=username]').fill(adminName);
  await loginForm.locator('input[name=password]').fill(adminPassword);
  await loginForm.locator('button').first().click();
 }
 await expect(page.locator('.shell-app')).toBeVisible();
 await page.locator('.shell-nav [data-domain=purchasing]').click();
 const btn=page.locator('#shell-root [data-open=consumables-workspace]').first();
 // Advanced purchasing tools live behind the progressive-disclosure section.
 if(!await btn.isVisible())await page.locator('.shell-more summary').click();
 await expect(btn).toBeVisible();
 await btn.click();
 await expect(page.locator('#tt-consumables .ttc-panel')).toBeVisible();
 await expect(page.locator('.ttc-header')).toContainText('Consumables control');
 for(const width of [390,320]){
  await page.setViewportSize({width,height:740});
  const box=await page.locator('.ttc-panel').boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.x+box.width).toBeLessThanOrEqual(width+1);
 }
});
