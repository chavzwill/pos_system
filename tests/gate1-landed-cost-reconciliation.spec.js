import { test, expect } from '@playwright/test';

const {db}=require('../database');
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
  return {status:r.status,body:await r.json().catch(()=>null)};
}
const round2=v=>Number(Number(v||0).toFixed(2));

test('I-PROC-03 allocates landed cost exactly once before supplier payment',async()=>{
  const admin=await login();
  const [branches,suppliers]=await Promise.all([
    request(admin.cookie,'GET','/api/branches'),
    request(admin.cookie,'GET','/api/suppliers')
  ]);
  expect(branches.status).toBe(200);expect(suppliers.status).toBe(200);
  const branch=branches.body.find(x=>x.active!==0),supplier=suppliers.body.find(x=>x.active!==0);
  expect(branch).toBeTruthy();expect(supplier).toBeTruthy();
  const stamp=`G1PROC03${Date.now()}`;

  const product=await request(admin.cookie,'POST','/api/products',{
    sku:`${stamp}-SKU`,name:`Gate 1 landed cost probe ${stamp}`,price:100,cost:0,tax_rate:0,stock_qty:0,min_stock:0,active:1,branch_id:branch.id,taxable:1
  });
  expect(product.status).toBe(201);

  const po=await request(admin.cookie,'POST','/api/purchase-orders',{
    supplier_id:supplier.id,branch_id:branch.id,ship_to_branch_id:branch.id,ship_to_name:branch.name,
    ship_to_address:branch.address||'1 Runtime Test Road',ship_to_city:branch.city||'Kingston',ship_to_state:branch.state||'Kingston',
    employee_id:admin.body.id,notes:'Gate 1 I-PROC-03 landed-cost reconciliation probe',items:[{product_id:product.body.id,quantity_ordered:2,unit_cost:50}]
  });
  expect(po.status).toBe(201);expect(po.body.items?.length).toBe(1);
  expect((await request(admin.cookie,'PATCH',`/api/purchase-orders/${po.body.id}/status`,{status:'approved'})).status).toBe(200);
  const received=await request(admin.cookie,'PATCH',`/api/purchase-orders/${po.body.id}/receive`,{items:[{item_id:po.body.items[0].id,quantity_received:2}]},{'Idempotency-Key':`proc03-receive-${stamp}`});
  expect(received.status,JSON.stringify(received)).toBe(200);

  const today=new Date().toISOString().slice(0,10);
  const invoice=await request(admin.cookie,'POST','/api/supplier-ledger/invoices',{
    supplier_id:supplier.id,purchase_order_id:po.body.id,branch_id:branch.id,invoice_number:`INV-${stamp}`,invoice_date:today,
    subtotal:100,tax_amount:0,freight_amount:12,duty_amount:3,other_landed_cost_amount:5,total:120,notes:'Gate 1 I-PROC-03 landed-cost probe invoice'
  });
  expect(invoice.status,JSON.stringify(invoice)).toBe(201);
  expect(invoice.body.invoice_match_status).toBe('matched');

  const {rows:[poolBefore]}=await db.execute({sql:'SELECT tracked_qty,tracked_value FROM inventory_cost_pools WHERE product_id=? AND branch_key=?',args:[product.body.id,branch.id]});
  expect(Number(poolBefore.tracked_qty)).toBeCloseTo(2,4);
  expect(Number(poolBefore.tracked_value)).toBeCloseTo(100,4);

  const paymentBody={supplier_id:supplier.id,branch_id:branch.id,payment_date:today,amount:120,payment_method:'bank_transfer',reference:`LC-${stamp}`,allocations:[{invoice_id:invoice.body.id,amount:120}],notes:'I-PROC-03 payment must force landed-cost reconciliation'};
  const payment=await request(admin.cookie,'POST','/api/supplier-ledger/payments',paymentBody,{'Idempotency-Key':`proc03-pay-${stamp}`});
  expect(payment.status,JSON.stringify(payment)).toBe(201);

  const {rows:[recon]}=await db.execute({sql:'SELECT * FROM landed_cost_reconciliations WHERE supplier_invoice_id=?',args:[invoice.body.id]});
  expect(recon).toBeTruthy();expect(recon.status).toBe('allocated');
  expect(round2(recon.expected_amount)).toBe(20);expect(round2(recon.allocated_amount)).toBe(20);
  const {rows:[allocation]}=await db.execute({sql:'SELECT * FROM landed_cost_allocations WHERE supplier_invoice_id=?',args:[invoice.body.id]});
  expect(allocation).toBeTruthy();expect(round2(allocation.capitalizable_amount)).toBe(20);
  const {rows:items}=await db.execute({sql:'SELECT * FROM landed_cost_allocation_items WHERE allocation_id=? ORDER BY id',args:[allocation.id]});
  expect(items.length).toBeGreaterThan(0);
  expect(round2(items.reduce((s,x)=>s+Number(x.allocated_amount||0),0))).toBe(20);
  const {rows:revalues}=await db.execute({sql:'SELECT * FROM landed_cost_revaluations WHERE allocation_id=? ORDER BY id',args:[allocation.id]});
  expect(revalues.length).toBe(items.length);
  expect(round2(revalues.reduce((s,x)=>s+Number(x.inventory_adjustment||0)+Number(x.cogs_adjustment||0),0))).toBe(20);
  const {rows:[poolAfter]}=await db.execute({sql:'SELECT tracked_qty,tracked_value FROM inventory_cost_pools WHERE product_id=? AND branch_key=?',args:[product.body.id,branch.id]});
  expect(Number(poolAfter.tracked_qty)).toBeCloseTo(2,4);
  expect(Number(poolAfter.tracked_value)).toBeCloseTo(120,4);

  const replay=await request(admin.cookie,'POST','/api/supplier-ledger/payments',paymentBody,{'Idempotency-Key':`proc03-pay-${stamp}`});
  expect(replay.status,JSON.stringify(replay)).toBe(200);
  expect(Number(replay.body.id)).toBe(Number(payment.body.id));
  const {rows:[counts]}=await db.execute({sql:`SELECT
    (SELECT COUNT(*) FROM landed_cost_allocations WHERE supplier_invoice_id=?) allocation_count,
    (SELECT COUNT(*) FROM landed_cost_reconciliations WHERE supplier_invoice_id=?) reconciliation_count,
    (SELECT COUNT(*) FROM landed_cost_revaluations WHERE allocation_id=?) revaluation_count`,args:[invoice.body.id,invoice.body.id,allocation.id]});
  expect(Number(counts.allocation_count)).toBe(1);expect(Number(counts.reconciliation_count)).toBe(1);expect(Number(counts.revaluation_count)).toBe(items.length);
  const {rows:[poolReplay]}=await db.execute({sql:'SELECT tracked_value FROM inventory_cost_pools WHERE product_id=? AND branch_key=?',args:[product.body.id,branch.id]});
  expect(Number(poolReplay.tracked_value)).toBeCloseTo(120,4);
});
