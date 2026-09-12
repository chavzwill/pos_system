import { test, expect } from '@playwright/test';

const BASE='http://localhost:3001';
const TEST_USER=process.env.POS_TEST_USER||'admin';
const TEST_PASSWORD=process.env.POS_TEST_PASSWORD||'123456';

async function login(){
  const r=await fetch(`${BASE}/api/employees/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:TEST_USER,password:TEST_PASSWORD})});
  expect(r.status).toBe(200);
  return {cookie:(r.headers.get('set-cookie')||'').split(';')[0],body:await r.json()};
}
async function request(cookie,method,path,body,extraHeaders={}){
  const r=await fetch(`${BASE}${path}`,{method,headers:{Cookie:cookie,'Content-Type':'application/json',Accept:'application/json',...extraHeaders},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:r.status,headers:r.headers,body:await r.json().catch(()=>null)};
}

test('supplier payment operation identity prevents duplicate settlement and replays deterministically',async()=>{
  const admin=await login();
  const [branches,suppliers]=await Promise.all([
    request(admin.cookie,'GET','/api/branches'),
    request(admin.cookie,'GET','/api/suppliers')
  ]);
  expect(branches.status).toBe(200);expect(suppliers.status).toBe(200);
  const branch=branches.body.find(x=>x.active!==0),supplier=suppliers.body.find(x=>x.active!==0);
  expect(branch).toBeTruthy();expect(supplier).toBeTruthy();
  const stamp=`G1PAY${Date.now()}`;

  const product=await request(admin.cookie,'POST','/api/products',{
    sku:`${stamp}-SKU`,name:`Gate 1 supplier payment probe ${stamp}`,price:75,cost:0,tax_rate:0,stock_qty:0,min_stock:0,active:1,branch_id:branch.id,taxable:1
  });
  expect(product.status).toBe(201);

  const po=await request(admin.cookie,'POST','/api/purchase-orders',{
    supplier_id:supplier.id,branch_id:branch.id,ship_to_branch_id:branch.id,ship_to_name:branch.name,
    ship_to_address:branch.address||'1 Runtime Test Road',ship_to_city:branch.city||'Kingston',ship_to_state:branch.state||'Kingston',
    employee_id:admin.body.id,notes:'Gate 1 I-PROC-02 payment concurrency probe',items:[{product_id:product.body.id,quantity_ordered:2,unit_cost:50}]
  });
  expect(po.status).toBe(201);expect(po.body.items?.length).toBe(1);

  const approved=await request(admin.cookie,'PATCH',`/api/purchase-orders/${po.body.id}/status`,{status:'approved'});
  expect(approved.status).toBe(200);
  const received=await request(admin.cookie,'PATCH',`/api/purchase-orders/${po.body.id}/receive`,{
    items:[{item_id:po.body.items[0].id,quantity_received:2}]
  },{'Idempotency-Key':`proc02-receive-${stamp}`});
  expect(received.status).toBe(200);

  const today=new Date().toISOString().slice(0,10);
  const invoice=await request(admin.cookie,'POST','/api/supplier-ledger/invoices',{
    supplier_id:supplier.id,purchase_order_id:po.body.id,branch_id:branch.id,invoice_number:`INV-${stamp}`,invoice_date:today,
    subtotal:100,tax_amount:0,freight_amount:0,duty_amount:0,other_landed_cost_amount:0,total:100,notes:'Gate 1 I-PROC-02 payment probe invoice'
  });
  expect(invoice.status).toBe(201);

  const paymentBody={supplier_id:supplier.id,branch_id:branch.id,payment_date:today,amount:50,payment_method:'bank_transfer',reference:`REF-${stamp}`,allocations:[{invoice_id:invoice.body.id,amount:50}],notes:'Gate 1 duplicate-payment concurrency probe'};
  const operationKey=`supplier-payment-${stamp}`;
  const headers={'Idempotency-Key':operationKey};
  const results=await Promise.all([
    request(admin.cookie,'POST','/api/supplier-ledger/payments',paymentBody,headers),
    request(admin.cookie,'POST','/api/supplier-ledger/payments',paymentBody,headers)
  ]);
  const successes=results.filter(x=>x.status===201);
  expect(successes,JSON.stringify(results)).toHaveLength(1);
  expect(results.some(x=>x.status===409)).toBe(true);
  const paymentId=successes[0].body.id;

  const replay=await request(admin.cookie,'POST','/api/supplier-ledger/payments',paymentBody,headers);
  expect(replay.status).toBe(201);
  expect(replay.body.id).toBe(paymentId);
  expect(replay.body.replayed).toBe(true);
  expect(replay.headers.get('idempotency-replayed')).toBe('true');

  const changed={...paymentBody,amount:40,allocations:[{invoice_id:invoice.body.id,amount:40}]};
  const conflict=await request(admin.cookie,'POST','/api/supplier-ledger/payments',changed,headers);
  expect(conflict.status).toBe(409);
  expect(String(conflict.body?.error||'')).toMatch(/different supplier payment request/i);

  const unkeyed=await request(admin.cookie,'POST','/api/supplier-ledger/payments',{...paymentBody,reference:`UNKEYED-${stamp}`});
  expect(unkeyed.status).toBe(428);
  expect(unkeyed.body?.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

  const invoices=await request(admin.cookie,'GET',`/api/supplier-ledger/invoices?supplier_id=${supplier.id}&status=open&limit=500`);
  expect(invoices.status).toBe(200);
  const probe=invoices.body.find(x=>Number(x.id)===Number(invoice.body.id));
  expect(probe).toBeTruthy();
  expect(Number(probe.paid_amount)).toBe(50);
  expect(Number(probe.balance_due)).toBe(50);
});
