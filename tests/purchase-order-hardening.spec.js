import { test, expect } from '@playwright/test';
import { TEST_BASE_URL, assertSafeMutationTarget } from './test-base-url.js';

const BASE = TEST_BASE_URL;
const TEST_USER = process.env.POS_TEST_USER;
const TEST_PASSWORD = process.env.POS_TEST_PASSWORD;
if (!TEST_USER || !TEST_PASSWORD) throw new Error('POS_TEST_USER and POS_TEST_PASSWORD are required');
assertSafeMutationTarget();

async function loginCookie() {
  const r = await fetch(`${BASE}/api/employees/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: TEST_USER, password: TEST_PASSWORD }),
  });
  expect(r.status).toBe(200);
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
async function api(cookie, method, path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method, headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

test.describe('Purchase order lifecycle hardening', () => {
  test('approval gates receiving, preserves receipt evidence, and allocates landed cost audibly', async () => {
    const cookie = await loginCookie();
    const [suppliers, branches, products] = await Promise.all([
      api(cookie, 'GET', '/api/suppliers'), api(cookie, 'GET', '/api/branches'), api(cookie, 'GET', '/api/products'),
    ]);
    expect(suppliers.status).toBe(200); expect(branches.status).toBe(200); expect(products.status).toBe(200);
    const supplier = suppliers.body.find(x => x.active !== 0);
    const branch = branches.body.find(x => x.active !== 0);
    const product = products.body.find(x => x.active !== 0 && !x.is_service && Number(x.has_variations || 0) === 0);
    expect(supplier).toBeTruthy(); expect(branch).toBeTruthy(); expect(product).toBeTruthy();

    const unitCost = Number(product.cost) || 1;
    const created = await api(cookie, 'POST', '/api/purchase-orders', {
      supplier_id: supplier.id, branch_id: branch.id,
      ship_to_branch_id: branch.id,
      ship_to_name: branch.name,
      ship_to_address: branch.address || '1 Runtime Test Road',
      ship_to_city: branch.city || 'Kingston',
      ship_to_state: branch.state || 'Kingston',
      items: [{ product_id: product.id, quantity_ordered: 2, unit_cost: unitCost }],
      notes: 'Automated lifecycle integrity test',
    });
    expect(created.status).toBe(201);
    const po = created.body;
    const item = po.items[0];

    const beforeApproval = await api(cookie, 'PATCH', `/api/purchase-orders/${po.id}/receive`, { items: [{ item_id: item.id, quantity_received: 1 }] });
    expect(beforeApproval.status).toBe(400);
    expect(beforeApproval.body.error).toMatch(/approved before receiving/i);

    const approved = await api(cookie, 'PATCH', `/api/purchase-orders/${po.id}/status`, { status: 'approved' });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('approved');

    const over = await api(cookie, 'PATCH', `/api/purchase-orders/${po.id}/receive`, { items: [{ item_id: item.id, quantity_received: 3 }] });
    expect(over.status).toBe(400);
    expect(over.body.error).toMatch(/over-receipt.*requires an exception reason/i);

    const received = await api(cookie, 'PATCH', `/api/purchase-orders/${po.id}/receive`, { items: [{ item_id: item.id, quantity_received: 2 }] });
    expect(received.status).toBe(200);
    expect(received.body.status).toBe('received');
    expect(Number(received.body.items[0].quantity_received)).toBe(2);
    expect(received.body.receipt_number).toMatch(/^RCV-/);

    const movements = await api(cookie, 'GET', '/api/operational-reports/inventory-movements?start=2020-01-01&end=2030-12-31');
    expect(movements.status).toBe(200);
    expect(movements.body.rows.some(x => x.reference === received.body.receipt_number && x.type === 'purchase_receive' && Number(x.quantity_change) === 2)).toBe(true);

    const merchandise = Number((unitCost * 2).toFixed(2));
    const freight = 10;
    const invoice = await api(cookie, 'POST', '/api/supplier-ledger/invoices', {
      supplier_id: supplier.id, purchase_order_id: po.id, branch_id: branch.id,
      invoice_number: `TEST-${po.id}-${Date.now()}`, invoice_date: new Date().toISOString().slice(0,10),
      subtotal: merchandise, tax_amount: 0, freight_amount: freight, duty_amount: 0, other_landed_cost_amount: 0,
      total: Number((merchandise + freight).toFixed(2)),
    });
    expect(invoice.status).toBe(201);

    const allocation = await api(cookie, 'POST', `/api/purchase-orders/${po.id}/landed-cost-allocations`, {
      supplier_invoice_id: invoice.body.id, basis: 'value', notes: 'Automated landed-cost integrity test',
    });
    expect(allocation.status).toBe(201);
    expect(Number(allocation.body.capitalizable_amount)).toBe(freight);
    expect(allocation.body.items).toHaveLength(1);
    expect(Number(allocation.body.items[0].allocated_amount)).toBe(freight);
    expect(Number(allocation.body.items[0].adjusted_unit_cost)).toBe(Number((unitCost + freight / 2).toFixed(2)));

    const duplicate = await api(cookie, 'POST', `/api/purchase-orders/${po.id}/landed-cost-allocations`, { supplier_invoice_id: invoice.body.id, basis: 'quantity' });
    expect(duplicate.status).toBe(409);

    const listed = await api(cookie, 'GET', `/api/purchase-orders/${po.id}/landed-cost-allocations`);
    expect(listed.status).toBe(200);
    expect(listed.body.some(x => x.id === allocation.body.id && x.items.length === 1)).toBe(true);
  });

  test('variation-bearing products fail closed until the exact variation is authoritative', async () => {
    const cookie = await loginCookie();
    const [suppliers, branches, products] = await Promise.all([
      api(cookie, 'GET', '/api/suppliers'), api(cookie, 'GET', '/api/branches'), api(cookie, 'GET', '/api/products'),
    ]);
    const supplier=suppliers.body.find(x=>x.active!==0),branch=branches.body.find(x=>x.active!==0);
    const product=products.body.find(x=>x.active!==0&&!x.is_service&&Number(x.has_variations||0)>0);
    test.skip(!supplier||!branch||!product,'No active variation-bearing catalog product is available in this test database');
    const vars=await api(cookie,'GET',`/api/products/${product.id}/variations`);expect(vars.status).toBe(200);
    const variation=vars.body.find(v=>Number(v.active)!==0);test.skip(!variation,'No active variation is available for the selected product');
    const cost=Number(variation.cost??product.cost)||1;

    const missing=await api(cookie,'POST','/api/purchase-orders',{supplier_id:supplier.id,branch_id:branch.id,items:[{product_id:product.id,quantity_ordered:1,unit_cost:cost}]});
    expect(missing.status).toBe(409);expect(missing.body.control).toBe('po_variation_required');

    const created=await api(cookie,'POST','/api/purchase-orders',{supplier_id:supplier.id,branch_id:branch.id,items:[{product_id:product.id,variation_id:variation.id,quantity_ordered:1,unit_cost:cost}],notes:'Variation authority acceptance test'});
    expect(created.status).toBe(201);expect(Number(created.body.items[0].variation_id)).toBe(Number(variation.id));
    expect(created.body.items[0].variation_name).toBe(variation.name);

    const detail=await api(cookie,'GET',`/api/purchase-orders/${created.body.id}`);
    expect(detail.status).toBe(200);expect(Number(detail.body.items[0].variation_id)).toBe(Number(variation.id));
    expect(detail.body.items[0].variation_sku).toBe(variation.sku);

    const otherProduct=products.body.find(x=>Number(x.id)!==Number(product.id)&&Number(x.has_variations||0)>0);
    if(otherProduct){
      const otherVars=await api(cookie,'GET',`/api/products/${otherProduct.id}/variations`);const wrong=otherVars.body.find(v=>Number(v.active)!==0);
      if(wrong){const rejected=await api(cookie,'POST','/api/purchase-orders',{supplier_id:supplier.id,branch_id:branch.id,items:[{product_id:product.id,variation_id:wrong.id,quantity_ordered:1,unit_cost:cost}]});expect(rejected.status).toBe(409);expect(rejected.body.control).toBe('po_variation_invalid');}
    }
  });

  test('PR conversion is single-winner and receiving updates exact variation stock', async () => {
    const cookie=await loginCookie();
    const [suppliers,branches,products]=await Promise.all([api(cookie,'GET','/api/suppliers'),api(cookie,'GET','/api/branches'),api(cookie,'GET','/api/products')]);
    const supplier=suppliers.body.find(x=>x.active!==0),branch=branches.body.find(x=>x.active!==0);
    let product=null,variation=null;
    for(const candidate of products.body.filter(x=>x.active!==0&&!x.is_service&&Number(x.has_variations||0)>0)){
      const profile=await api(cookie,'GET',`/api/inventory-traceability/profiles/${candidate.id}`);if(profile.status!==200||profile.body.tracking_mode!=='none')continue;
      const v=await api(cookie,'GET',`/api/products/${candidate.id}/variations`);const active=v.body?.find(x=>Number(x.active)!==0);if(active){product=candidate;variation=active;break;}
    }
    test.skip(!supplier||!branch||!product||!variation,'No untracked active variation-bearing product is available in this test database');
    const cost=Number(variation.cost??product.cost)||1;
    const createdPr=await api(cookie,'POST','/api/purchase-requests',{branch_id:branch.id,request_type:'sale_items',items:[{product_id:product.id,product_name:product.name,quantity:1,unit_cost:cost}],notes:'PR variation conversion race test'});
    expect(createdPr.status).toBe(201);
    expect((await api(cookie,'PATCH',`/api/purchase-requests/${createdPr.body.id}/status`,{status:'submitted'})).status).toBe(200);
    expect((await api(cookie,'PATCH',`/api/purchase-requests/${createdPr.body.id}/status`,{status:'approved'})).status).toBe(200);
    const pr=await api(cookie,'GET',`/api/purchase-requests/${createdPr.body.id}`);expect(pr.status).toBe(200);
    const prItem=pr.body.items[0];expect(Number(prItem.active_variation_count)).toBeGreaterThan(0);
    const payload={supplier_id:supplier.id,expected_date:new Date(Date.now()+86400000).toISOString().slice(0,10),variations:[{pr_item_id:prItem.id,variation_id:variation.id}]};
    const attempts=await Promise.all([api(cookie,'POST',`/api/purchase-requests/${pr.body.id}/convert`,payload),api(cookie,'POST',`/api/purchase-requests/${pr.body.id}/convert`,payload)]);
    const winners=attempts.filter(x=>x.status===201),losers=attempts.filter(x=>x.status===409);
    expect(winners).toHaveLength(1);expect(losers).toHaveLength(1);
    const po=winners[0].body;expect(Number(po.items[0].variation_id)).toBe(Number(variation.id));
    const approved=await api(cookie,'PATCH',`/api/purchase-orders/${po.id}/status`,{status:'approved'});expect(approved.status).toBe(200);
    const beforeVars=await api(cookie,'GET',`/api/products/${product.id}/variations`);const before=beforeVars.body.find(x=>Number(x.id)===Number(variation.id));
    const received=await api(cookie,'PATCH',`/api/purchase-orders/${po.id}/receive`,{items:[{item_id:po.items[0].id,quantity_received:1}]});expect(received.status).toBe(200);
    const afterVars=await api(cookie,'GET',`/api/products/${product.id}/variations`);const after=afterVars.body.find(x=>Number(x.id)===Number(variation.id));
    expect(Number(after.stock_qty)).toBe(Number(before.stock_qty||0)+1);
    expect(Number(received.body.items[0].variation_id)).toBe(Number(variation.id));
  });
});
