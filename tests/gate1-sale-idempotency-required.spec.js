import { test, expect } from '@playwright/test';

const BASE='http://localhost:3001';
async function login(){
  const username=process.env.POS_TEST_USER;
  const password=process.env.POS_TEST_PASSWORD;
  expect(username,'POS_TEST_USER is required').toBeTruthy();
  expect(password,'POS_TEST_PASSWORD is required').toBeTruthy();
  const r=await fetch(`${BASE}/api/employees/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
  expect(r.status).toBe(200);
  return (r.headers.get('set-cookie')||'').split(';')[0];
}
async function jsonFetch(url,init={}){
  const r=await fetch(url,init);
  return {status:r.status,headers:r.headers,body:await r.json().catch(()=>null)};
}

test.describe('Gate 1 mandatory sale operation identity',()=>{
  test('employee-session sale settlement without an operation key fails before checkout validation',async()=>{
    const cookie=await login();
    const r=await jsonFetch(`${BASE}/api/transactions`,{
      method:'POST',
      headers:{Cookie:cookie,'Content-Type':'application/json','X-Test-No-Idempotency':'1'},
      body:JSON.stringify({items:[]})
    });
    expect(r.status).toBe(428);
    expect(r.headers.get('idempotency-protection')).toBe('required');
    expect(r.body?.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  test('orders-write API key is also unable to settle an unkeyed sale',async()=>{
    const cookie=await login();
    const stamp=Date.now();
    const created=await jsonFetch(`${BASE}/api/api-keys`,{
      method:'POST',
      headers:{Cookie:cookie,'Content-Type':'application/json'},
      body:JSON.stringify({name:`Gate 1 sale key ${stamp}`,scopes:['orders:write'],reason:'Gate 1 mandatory sale idempotency certification'})
    });
    expect(created.status).toBe(201);
    const id=created.body.id;
    try{
      const r=await jsonFetch(`${BASE}/api/transactions`,{
        method:'POST',
        headers:{'X-API-Key':created.body.key,'Content-Type':'application/json','X-Test-No-Idempotency':'1'},
        body:JSON.stringify({items:[]})
      });
      expect(r.status).toBe(428);
      expect(r.body?.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    }finally{
      await jsonFetch(`${BASE}/api/api-keys/${id}`,{
        method:'DELETE',
        headers:{Cookie:cookie,'Content-Type':'application/json'},
        body:JSON.stringify({reason:'Gate 1 mandatory sale idempotency cleanup'})
      }).catch(()=>{});
    }
  });
});
