import { test, expect } from '@playwright/test';

const BASE='http://localhost:3001';
async function login(){const r=await fetch(`${BASE}/api/employees/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'123456'})});expect(r.status).toBe(200);return (r.headers.get('set-cookie')||'').split(';')[0];}
async function api(cookie,method,path,body){const r=await fetch(`${BASE}${path}`,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json().catch(()=>null)};}

test.describe('Loss prevention and margin leakage intelligence',()=>{
  test('detects below-cost margin leakage and records a human-review case without automatic remediation',async()=>{
    const cookie=await login(),stamp=Date.now();
    const branches=await api(cookie,'GET','/api/branches');expect(branches.status).toBe(200);const branch=branches.body.find(x=>x.active!==0);expect(branch).toBeTruthy();
    const productCreate=await api(cookie,'POST','/api/products',{sku:`LOSS-${stamp}`,name:`Loss Control Test ${stamp}`,price:50,cost:100,tax_rate:0,stock_qty:3,min_stock:0,active:1,branch_id:branch.id});expect(productCreate.status).toBe(201);const product=productCreate.body;

    const drawers=await api(cookie,'GET',`/api/drawers?branch_id=${branch.id}`);expect(drawers.status).toBe(200);let drawerSessionId=null;
    if(drawers.body.length){const opened=await api(cookie,'POST','/api/drawers/sessions',{drawer_id:drawers.body[0].id,opening_float:0});expect([200,201]).toContain(opened.status);drawerSessionId=opened.body.id;}

    const sale=await api(cookie,'POST','/api/transactions',{branch_id:branch.id,drawer_session_id:drawerSessionId,items:[{product_id:product.id,quantity:1}],discount_amount:0,payment_method:'cash',amount_tendered:50});expect(sale.status).toBe(201);

    const signals=await api(cookie,'GET',`/api/inventory-traceability/loss-control/signals?days=1&branch_id=${branch.id}`);expect(signals.status).toBe(200);const leakage=signals.body.signals.find(x=>x.signal_type==='below_cost_sale'&&Number(x.product_id)===Number(product.id));expect(leakage).toBeTruthy();expect(Number(leakage.estimated_loss)).toBe(50);expect(leakage.recommended_action).toMatch(/confirm whether/i);

    const scan=await api(cookie,'POST','/api/inventory-traceability/loss-control/scan',{days:1,branch_id:branch.id});expect(scan.status).toBe(200);expect(scan.body.message).toMatch(/no disciplinary, purchasing, inventory, refund, or accounting action/i);
    const cases=await api(cookie,'GET',`/api/inventory-traceability/loss-control/cases?category=pricing_margin&branch_id=${branch.id}`);expect(cases.status).toBe(200);const c=cases.body.find(x=>Number(x.product_id)===Number(product.id)&&x.signal_type==='below_cost_sale');expect(c).toBeTruthy();expect(c.status).toBe('open');

    const resolvedWithoutNote=await api(cookie,'PATCH',`/api/inventory-traceability/loss-control/cases/${c.id}`,{status:'resolved',recovered_value:0});expect(resolvedWithoutNote.status).toBe(400);
    const investigating=await api(cookie,'PATCH',`/api/inventory-traceability/loss-control/cases/${c.id}`,{status:'investigating',resolution_note:'Automated integrity test review'});expect(investigating.status).toBe(200);expect(investigating.body.status).toBe('investigating');

    if(drawerSessionId)await api(cookie,'PATCH',`/api/drawers/sessions/${drawerSessionId}/close`,{});
  });
});
