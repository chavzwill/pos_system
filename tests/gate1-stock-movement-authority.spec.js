import {test,expect} from '@playwright/test';
const BASE='http://localhost:3001';
async function login(){
  const r=await fetch(`${BASE}/api/employees/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:process.env.POS_TEST_USER||'admin',password:process.env.POS_TEST_PASSWORD||'123456'})});
  expect(r.status).toBe(200);
  return (r.headers.get('set-cookie')||'').split(';')[0];
}
async function api(cookie,method,path,body){
  const r=await fetch(`${BASE}${path}`,{method,headers:{Cookie:cookie,Accept:'application/json',...(body!==undefined?{'Content-Type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:r.status,body:await r.json().catch(()=>null)};
}

test('catalog edits cannot create or destroy physical stock without movement evidence',async()=>{
  const cookie=await login(),stamp=`STK${Date.now()}`;
  const branches=await api(cookie,'GET','/api/branches');
  const branch=branches.body.find(x=>x.active!==0);
  expect(branch).toBeTruthy();
  const blocked=await api(cookie,'POST','/api/products',{sku:`${stamp}-P`,name:`Stock ${stamp}`,price:10,cost:4,stock_qty:5,branch_id:branch.id,active:1});
  expect(blocked.status).toBe(409);
  const created=await api(cookie,'POST','/api/products',{sku:`${stamp}-P`,name:`Stock ${stamp}`,price:10,cost:4,stock_qty:0,branch_id:branch.id,active:1});
  expect(created.status).toBe(201);
  const productId=created.body.id;
  const adjusted=await api(cookie,'PATCH',`/api/products/${productId}/stock`,{adjustment:5,branch_id:branch.id,reason:'Initial physical count'});
  expect(adjusted.status).toBe(200);
  expect(Number(adjusted.body.stock_qty)).toBe(5);
  expect(Number(adjusted.body.movement_id)).toBeGreaterThan(0);
  const edited=await api(cookie,'PUT',`/api/products/${productId}`,{...created.body,stock_qty:8,branch_id:branch.id});
  expect(edited.status).toBe(409);

  const badVariation=await api(cookie,'POST',`/api/products/${productId}/variations`,{name:'Box',sku:`${stamp}-V`,attributes:{pack:'box'},stock_qty:2,active:1});
  expect(badVariation.status).toBe(409);
  const variation=await api(cookie,'POST',`/api/products/${productId}/variations`,{name:'Box',sku:`${stamp}-V`,attributes:{pack:'box'},stock_qty:0,active:1});
  expect(variation.status).toBe(201);
  const vAdj=await api(cookie,'PATCH',`/api/products/${productId}/variations/${variation.body.id}/stock`,{adjustment:3,reason:'Initial variation count'});
  expect(vAdj.status).toBe(200);
  expect(Number(vAdj.body.stock_qty)).toBe(3);
  expect(Number(vAdj.body.movement_id)).toBeGreaterThan(0);
  const vEdit=await api(cookie,'PUT',`/api/products/${productId}/variations/${variation.body.id}`,{...variation.body,stock_qty:4});
  expect(vEdit.status).toBe(409);
  const overReduce=await api(cookie,'PATCH',`/api/products/${productId}/variations/${variation.body.id}/stock`,{adjustment:-4,reason:'Attempt invalid reduction'});
  expect(overReduce.status).toBe(409);
  const after=await api(cookie,'GET',`/api/products/${productId}/variations`);
  expect(Number(after.body.find(x=>Number(x.id)===Number(variation.body.id)).stock_qty)).toBe(3);
});
