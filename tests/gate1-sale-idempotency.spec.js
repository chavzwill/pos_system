import { test, expect } from '@playwright/test';

const BASE='http://localhost:3001';
async function login(username=process.env.POS_TEST_USER,password=process.env.POS_TEST_PASSWORD){
  expect(username,'POS_TEST_USER is required').toBeTruthy();
  expect(password,'POS_TEST_PASSWORD is required').toBeTruthy();
  const r=await fetch(`${BASE}/api/employees/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
  expect(r.status).toBe(200);return {cookie:(r.headers.get('set-cookie')||'').split(';')[0],body:await r.json()};
}
async function api(cookie,path,options={}){const headers={Cookie:cookie,Accept:'application/json',...(options.headers||{})};if(options.body&&!headers['Content-Type'])headers['Content-Type']='application/json';const r=await fetch(`${BASE}${path}`,{...options,headers});return {status:r.status,headers:r.headers,body:await r.json().catch(()=>null)};}

test.describe('Gate 1 sale settlement idempotency',()=>{
  test('sale settlement requires a durable operation identity for employee sessions and API keys',async()=>{
    const admin=await login();
    const unkeyed=await api(admin.cookie,'/api/transactions',{method:'POST',headers:{'X-Test-No-Idempotency':'1'},body:JSON.stringify({items:[]})});
    expect(unkeyed.status).toBe(428);
    expect(unkeyed.headers.get('idempotency-protection')).toBe('required');
    expect(unkeyed.body?.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const stamp=Date.now();
    const key=await api(admin.cookie,'/api/api-keys',{method:'POST',body:JSON.stringify({name:`Gate 1 sale API ${stamp}`,scopes:['orders:write'],reason:'Gate 1 mandatory sale idempotency certification'})});
    expect(key.status).toBe(201);
    try{
      const machine=await fetch(`${BASE}/api/transactions`,{method:'POST',headers:{'X-API-Key':key.body.key,'Content-Type':'application/json','X-Test-No-Idempotency':'1'},body:JSON.stringify({items:[]})});
      const machineBody=await machine.json().catch(()=>null);
      expect(machine.status).toBe(428);
      expect(machineBody?.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    }finally{
      await api(admin.cookie,`/api/api-keys/${key.body.id}`,{method:'DELETE',body:JSON.stringify({reason:'Gate 1 mandatory sale idempotency cleanup'})}).catch(()=>{});
    }
  });

  test('same operation key cannot create a second sale, second tender, or second stock decrement',async()=>{
    const admin=await login();
    const branches=await api(admin.cookie,'/api/branches');expect(branches.status).toBe(200);
    const branch=branches.body.find(b=>b.active!==0);test.skip(!branch,'Requires an active branch');
    const suffix=`${Date.now()}${Math.random().toString(36).slice(2,7)}`;
    let product=null,drawer=null,group=null,employee=null,session=null;
    const username=`idem_${suffix.slice(-12)}`,password=`Idem!${suffix}Aa1`,pin=String(Date.now()).slice(-6);
    try{
      let x=await api(admin.cookie,'/api/products',{method:'POST',body:JSON.stringify({sku:`IDEM-${suffix}`,name:`Idempotency SKU ${suffix}`,price:125,cost:70,tax_rate:0,stock_qty:0,min_stock:0,active:1,branch_id:branch.id,taxable:1})});expect(x.status).toBe(201);product=x.body;
      x=await api(admin.cookie,`/api/products/${product.id}/stock`,{method:'PATCH',body:JSON.stringify({branch_id:branch.id,adjustment:3,reason:'Gate 1 idempotency certification'})});expect(x.status).toBe(200);
      x=await api(admin.cookie,'/api/drawers',{method:'POST',body:JSON.stringify({branch_id:branch.id,name:`Idempotency Drawer ${suffix}`})});expect(x.status).toBe(201);drawer=x.body;
      x=await api(admin.cookie,'/api/security-groups',{method:'POST',body:JSON.stringify({name:`Idempotency Cashier ${suffix}`,description:'Temporary Gate 1 checkout proof',reason:'Gate 1 idempotency certification',permissions:{pos:true,transactions:true,drawers_open:true,drawers_close:true}})});expect(x.status).toBe(201);group=x.body;
      x=await api(admin.cookie,'/api/employees',{method:'POST',body:JSON.stringify({first_name:'Gate1',last_name:'Idempotency',username,password,pin,security_group_id:group.id,default_branch_id:branch.id,must_change_password:false})});expect(x.status).toBe(201);employee=x.body;
      const cashier=await login(username,password);
      x=await api(cashier.cookie,'/api/drawers/sessions',{method:'POST',body:JSON.stringify({drawer_id:drawer.id,opening_float:500})});expect([200,201]).toContain(x.status);session=x.body;

      const operationKey=`sale-${suffix}-same-operation`;
      const body={branch_id:branch.id,drawer_session_id:session.id,items:[{product_id:product.id,quantity:1}],payment_method:'cash',amount_tendered:125,notes:'Gate 1 sale idempotency certification'};
      const options={method:'POST',headers:{'Idempotency-Key':operationKey},body:JSON.stringify(body)};
      const [a,b]=await Promise.all([api(cashier.cookie,'/api/transactions',options),api(cashier.cookie,'/api/transactions',options)]);
      const successes=[a,b].filter(r=>r.status>=200&&r.status<300);
      expect(successes.length).toBeGreaterThanOrEqual(1);
      expect([a.status,b.status].every(s=>s===201||s===409)).toBe(true);
      const first=successes[0];expect(first.body?.id).toBeTruthy();

      const replay=await api(cashier.cookie,'/api/transactions',options);
      expect(replay.status).toBe(201);
      expect(replay.body.id).toBe(first.body.id);
      expect(replay.body.replayed).toBe(true);
      expect(replay.headers.get('idempotency-replayed')).toBe('true');

      const changed={...body,items:[{product_id:product.id,quantity:2}]};
      const conflict=await api(cashier.cookie,'/api/transactions',{method:'POST',headers:{'Idempotency-Key':operationKey},body:JSON.stringify(changed)});
      expect(conflict.status).toBe(409);
      expect(String(conflict.body?.error||'')).toMatch(/different sale request/i);

      const after=await api(cashier.cookie,`/api/products/${product.id}?branch_id=${branch.id}`);expect(after.status).toBe(200);expect(Number(after.body.branch_stock_qty)).toBe(2);
      const detail=await api(cashier.cookie,`/api/transactions/${first.body.id}`);expect(detail.status).toBe(200);
      expect(detail.body.payments).toHaveLength(1);
      expect(Number(detail.body.payments[0].amount)).toBe(125);
    }finally{
      if(session)await api(admin.cookie,`/api/drawers/sessions/${session.id}/close`,{method:'PATCH',body:JSON.stringify({})}).catch(()=>{});
      if(employee)await api(admin.cookie,`/api/employees/${employee.id}`,{method:'PUT',body:JSON.stringify({first_name:employee.first_name,last_name:employee.last_name,username,active:0,security_group_id:group?.id||null,default_branch_id:branch.id,must_change_password:false})}).catch(()=>{});
      if(group)await api(admin.cookie,`/api/security-groups/${group.id}?reason=Gate%201%20idempotency%20cleanup`,{method:'DELETE'}).catch(()=>{});
      if(drawer)await api(admin.cookie,`/api/drawers/${drawer.id}`,{method:'DELETE'}).catch(()=>{});
      if(product)await api(admin.cookie,`/api/products/${product.id}`,{method:'DELETE'}).catch(()=>{});
    }
  });
});
