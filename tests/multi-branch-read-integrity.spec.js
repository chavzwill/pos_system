import { test, expect } from '@playwright/test';

const BASE=String(process.env.POS_TEST_BASE_URL||'http://localhost:3001').replace(/\/$/,'');

async function login(username,password){
  const r=await fetch(`${BASE}/api/employees/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
  return {status:r.status,cookie:(r.headers.get('set-cookie')||'').split(';')[0],body:await r.json().catch(()=>null)};
}
async function get(cookie,path){
  const r=await fetch(`${BASE}${path}`,{headers:{Cookie:cookie,Accept:'application/json'}});
  return {status:r.status,body:await r.json().catch(()=>null)};
}

test.describe('Multi-branch read integrity',()=>{
  test('branch-scoped employee cannot inspect an arbitrary branch_id',async()=>{
    const username=process.env.POS_BRANCH_TEST_USER;
    const password=process.env.POS_BRANCH_TEST_PASSWORD;
    const ownBranch=process.env.POS_BRANCH_TEST_OWN_BRANCH;
    const otherBranch=process.env.POS_BRANCH_TEST_OTHER_BRANCH;
    test.skip(!username||!password||!ownBranch||!otherBranch,'Set POS_BRANCH_TEST_* credentials and two branch ids for cross-branch runtime certification');

    const auth=await login(username,password);
    expect(auth.status).toBe(200);

    const own=await get(auth.cookie,`/api/products?active=1&branch_id=${encodeURIComponent(ownBranch)}`);
    expect(own.status).toBe(200);

    for(const path of [
      `/api/products?active=1&branch_id=${encodeURIComponent(otherBranch)}`,
      `/api/work-orders?branch_id=${encodeURIComponent(otherBranch)}&limit=1`,
      `/api/rentals/agreements?branch_id=${encodeURIComponent(otherBranch)}`,
      `/api/purchase-orders?branch_id=${encodeURIComponent(otherBranch)}`,
      `/api/purchase-requests?branch_id=${encodeURIComponent(otherBranch)}`,
    ]){
      const result=await get(auth.cookie,path);
      expect(result.status,`${path}: ${JSON.stringify(result.body)}`).toBe(403);
      expect(result.body?.control).toBe('multi_branch_integrity');
    }
  });
});
