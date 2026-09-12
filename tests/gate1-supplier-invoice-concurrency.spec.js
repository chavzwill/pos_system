import { test, expect } from '@playwright/test';

const BASE='http://localhost:3001';
const TEST_USER=process.env.POS_TEST_USER||'admin';
const TEST_PASSWORD=process.env.POS_TEST_PASSWORD||'123456';

async function login(){
  const r=await fetch(`${BASE}/api/employees/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:TEST_USER,password:TEST_PASSWORD})});
  expect(r.status).toBe(200);
  return (r.headers.get('set-cookie')||'').split(';')[0];
}
async function api(cookie,path,body){
  const r=await fetch(`${BASE}${path}`,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(body)});
  return {status:r.status,body:await r.json().catch(()=>null)};
}
const normalize=v=>String(v||'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'');

test('concurrent normalized-equivalent supplier invoices create at most one liability',async()=>{
  const cookie=await login();
  const suppliers=await fetch(`${BASE}/api/suppliers`,{headers:{Cookie:cookie,Accept:'application/json'}});
  expect(suppliers.status).toBe(200);
  const supplier=(await suppliers.json()).find(x=>x.active!==0);
  expect(supplier).toBeTruthy();

  const stamp=`G1PROC02${Date.now()}`;
  const invoiceNumbers=[`${stamp}-A`,`${stamp} A`,`${stamp}.A`,`${stamp}/A`];
  const invoiceDate=new Date().toISOString().slice(0,10);
  const requests=invoiceNumbers.map(invoice_number=>api(cookie,'/api/supplier-ledger/invoices',{
    supplier_id:supplier.id,
    invoice_number,
    invoice_date:invoiceDate,
    subtotal:10,
    tax_amount:0,
    freight_amount:0,
    duty_amount:0,
    other_landed_cost_amount:0,
    total:10,
    notes:'Gate 1 I-PROC-02 normalized invoice concurrency probe'
  }));

  const results=await Promise.all(requests);
  const successes=results.filter(x=>x.status===201);
  expect(successes,JSON.stringify(results)).toHaveLength(1);
  expect(results.filter(x=>x.status===409||x.status===400).length).toBe(3);

  const listed=await fetch(`${BASE}/api/supplier-ledger/invoices?supplier_id=${supplier.id}&status=open&limit=500`,{headers:{Cookie:cookie,Accept:'application/json'}});
  expect(listed.status).toBe(200);
  const rows=await listed.json();
  const target=normalize(invoiceNumbers[0]);
  expect(rows.filter(x=>normalize(x.invoice_number)===target),JSON.stringify(rows.filter(x=>normalize(x.invoice_number)===target))).toHaveLength(1);
});
