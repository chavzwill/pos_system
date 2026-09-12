import { test, expect } from '@playwright/test';

const BASE='http://localhost:3001';
const TEST_USER=process.env.POS_TEST_USER||'admin';
const TEST_PASSWORD=process.env.POS_TEST_PASSWORD||'CI-Test-Auth!2026';

async function loginCookie(){
  const r=await fetch(`${BASE}/api/employees/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:TEST_USER,password:TEST_PASSWORD})});
  expect(r.status).toBe(200);
  return(r.headers.get('set-cookie')||'').split(';')[0];
}
async function api(cookie,method,path,body,headers={}){
  const r=await fetch(`${BASE}${path}`,{method,headers:{Cookie:cookie,'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
  return{status:r.status,headers:r.headers,body:await r.json().catch(()=>null)};
}
function op(){return `recv-${Date.now()}-${Math.random().toString(36).slice(2)}`;}
async function fixture(cookie,qty=2){
  const [ss,bs,ps]=await Promise.all([api(cookie,'GET','/api/suppliers'),api(cookie,'GET','/api/branches'),api(cookie,'GET','/api/products')]);
  const supplier=ss.body.find(x=>x.active!==0),branch=bs.body.find(x=>x.active!==0),product=ps.body.find(x=>x.active!==0&&!x.is_service);
  expect(supplier&&branch&&product).toBeTruthy();
  const created=await api(cookie,'POST','/api/purchase-orders',{
    supplier_id:supplier.id,branch_id:branch.id,
    ship_to_branch_id:branch.id,ship_to_name:branch.name,
    ship_to_address:branch.address||'1 Runtime Test Road',ship_to_city:branch.city||'Kingston',ship_to_state:branch.state||'Kingston',
    items:[{product_id:product.id,quantity_ordered:qty,unit_cost:Number(product.cost)||1}],notes:'Gate 1 receive idempotency'
  });
  expect(created.status).toBe(201);
  const approved=await api(cookie,'PATCH',`/api/purchase-orders/${created.body.id}/status`,{status:'approved'});
  expect(approved.status).toBe(200);
  return{po:created.body,item:created.body.items[0],product,branch};
}

test.describe('Gate 1 purchase receiving replay/concurrency invariants',()=>{
  test('requires operation identity and replays a completed receipt without double stock',async()=>{
    const cookie=await loginCookie(),f=await fixture(cookie,2),key=op(),payload={items:[{item_id:f.item.id,quantity_received:1}]};
    const missing=await api(cookie,'PATCH',`/api/purchase-orders/${f.po.id}/receive`,payload);
    expect(missing.status).toBe(428);

    const first=await api(cookie,'PATCH',`/api/purchase-orders/${f.po.id}/receive`,payload,{'Idempotency-Key':key});
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('partial');

    const replay=await api(cookie,'PATCH',`/api/purchase-orders/${f.po.id}/receive`,payload,{'Idempotency-Key':key});
    expect(replay.status).toBe(200);
    expect(replay.headers.get('idempotency-replayed')).toBe('true');
    expect(replay.body.receipt_number).toBe(first.body.receipt_number);

    const current=await api(cookie,'GET',`/api/purchase-orders/${f.po.id}`);
    expect(Number(current.body.items[0].quantity_received)).toBe(1);
    const operations=await api(cookie,'GET',`/api/purchase-orders/${f.po.id}/receive-operations`);
    expect(operations.status).toBe(200);
    expect(operations.body.filter(x=>x.operation_key===key&&x.state==='completed')).toHaveLength(1);
  });

  test('rejects reuse of an operation key with a changed payload',async()=>{
    const cookie=await loginCookie(),f=await fixture(cookie,3),key=op();
    const first=await api(cookie,'PATCH',`/api/purchase-orders/${f.po.id}/receive`,{items:[{item_id:f.item.id,quantity_received:1}]},{'Idempotency-Key':key});
    expect(first.status).toBe(200);
    const conflict=await api(cookie,'PATCH',`/api/purchase-orders/${f.po.id}/receive`,{items:[{item_id:f.item.id,quantity_received:2}]},{'Idempotency-Key':key});
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toMatch(/different receiving payload/i);
    const current=await api(cookie,'GET',`/api/purchase-orders/${f.po.id}`);
    expect(Number(current.body.items[0].quantity_received)).toBe(1);
  });

  test('serializes concurrent receive attempts for one PO and never over-receives',async()=>{
    const cookie=await loginCookie(),f=await fixture(cookie,1),payload={items:[{item_id:f.item.id,quantity_received:1}]};
    const [a,b]=await Promise.all([
      api(cookie,'PATCH',`/api/purchase-orders/${f.po.id}/receive`,payload,{'Idempotency-Key':op()}),
      api(cookie,'PATCH',`/api/purchase-orders/${f.po.id}/receive`,payload,{'Idempotency-Key':op()})
    ]);
    expect([a.status,b.status].filter(x=>x===200)).toHaveLength(1);
    expect([a.status,b.status].some(x=>x===409||x===400)).toBe(true);
    const current=await api(cookie,'GET',`/api/purchase-orders/${f.po.id}`);
    expect(Number(current.body.items[0].quantity_received)).toBe(1);
    expect(current.body.status).toBe('received');
  });
});
