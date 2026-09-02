import { test, expect } from '@playwright/test';

const BASE='http://localhost:3001';
const TEST_USER=process.env.POS_TEST_USER||'admin';
const TEST_PASSWORD=process.env.POS_TEST_PASSWORD||'CI-Test-Auth!2026';
const TEST_PIN=process.env.POS_TEST_PIN||'864209';
async function login(){const r=await fetch(`${BASE}/api/employees/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:TEST_USER,password:TEST_PASSWORD})});expect(r.status).toBe(200);return (r.headers.get('set-cookie')||'').split(';')[0];}
async function api(cookie,method,path,body){const r=await fetch(`${BASE}${path}`,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json().catch(()=>null)};}

test.describe('Loss prevention and margin leakage intelligence',()=>{
  test('blocks uncontrolled below-cost sale, records authorized exception, then surfaces the realized leakage for review',async()=>{
    const cookie=await login(),stamp=Date.now();
    const branches=await api(cookie,'GET','/api/branches');expect(branches.status).toBe(200);const branch=branches.body.find(x=>x.active!==0);expect(branch).toBeTruthy();
    const productCreate=await api(cookie,'POST','/api/products',{sku:`LOSS-${stamp}`,name:`Loss Control Test ${stamp}`,price:50,cost:100,tax_rate:0,stock_qty:0,min_stock:0,active:1,branch_id:branch.id});expect(productCreate.status).toBe(201);const product=productCreate.body;
    const stock=await api(cookie,'PATCH',`/api/products/${product.id}/stock`,{branch_id:branch.id,adjustment:3,reason:'Loss-control runtime certification'});expect(stock.status,JSON.stringify(stock.body)).toBe(200);

    const drawers=await api(cookie,'GET',`/api/drawers?branch_id=${branch.id}`);expect(drawers.status).toBe(200);let drawerSessionId=null;
    if(drawers.body.length){const opened=await api(cookie,'POST','/api/drawers/sessions',{drawer_id:drawers.body[0].id,opening_float:0});expect([200,201]).toContain(opened.status);drawerSessionId=opened.body.id;}

    const blocked=await api(cookie,'POST','/api/transactions',{branch_id:branch.id,drawer_session_id:drawerSessionId,items:[{product_id:product.id,quantity:1}],discount_amount:0,payment_method:'cash',amount_tendered:50});expect(blocked.status).toBe(409);expect(blocked.body.error).toMatch(/supervisor authorization/i);expect(Number(blocked.body.projected_gross_margin)).toBe(-50);

    const selfSetting=await api(cookie,'PUT','/api/settings',{loss_control_margin_override_allow_self:'true'});expect(selfSetting.status).toBe(200);
    const sale=await api(cookie,'POST','/api/transactions',{branch_id:branch.id,drawer_session_id:drawerSessionId,items:[{product_id:product.id,quantity:1}],discount_amount:0,payment_method:'cash',amount_tendered:50,margin_override_pin:TEST_PIN,margin_override_reason:'Controlled integrity-test exception'});expect(sale.status,JSON.stringify(sale.body)).toBe(201);expect(sale.body.margin_override_recorded).toBe(true);
    await api(cookie,'PUT','/api/settings',{loss_control_margin_override_allow_self:'false'});

    const signals=await api(cookie,'GET',`/api/inventory-traceability/loss-control/signals?days=1&branch_id=${branch.id}`);expect(signals.status).toBe(200);const leakage=signals.body.signals.find(x=>x.signal_type==='below_cost_sale'&&Number(x.product_id)===Number(product.id));expect(leakage).toBeTruthy();expect(Number(leakage.estimated_loss)).toBe(50);expect(leakage.recommended_action).toMatch(/confirm whether/i);

    const scan=await api(cookie,'POST','/api/inventory-traceability/loss-control/scan',{days:1,branch_id:branch.id});expect(scan.status).toBe(200);expect(scan.body.message).toMatch(/no disciplinary, purchasing, inventory, refund, or accounting action/i);
    const cases=await api(cookie,'GET',`/api/inventory-traceability/loss-control/cases?category=pricing_margin&branch_id=${branch.id}`);expect(cases.status).toBe(200);const c=cases.body.find(x=>Number(x.product_id)===Number(product.id)&&x.signal_type==='below_cost_sale');expect(c).toBeTruthy();expect(c.status).toBe('open');

    const resolvedWithoutNote=await api(cookie,'PATCH',`/api/inventory-traceability/loss-control/cases/${c.id}`,{status:'resolved',recovered_value:0});expect(resolvedWithoutNote.status).toBe(400);
    const investigating=await api(cookie,'PATCH',`/api/inventory-traceability/loss-control/cases/${c.id}`,{status:'investigating',resolution_note:'Automated integrity test review'});expect(investigating.status).toBe(200);expect(investigating.body.status).toBe('investigating');

    if(drawerSessionId)await api(cookie,'PATCH',`/api/drawers/sessions/${drawerSessionId}/close`,{});
  });
});
