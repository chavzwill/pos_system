import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:3001';

async function loginCookie() {
  const r = await fetch(`${BASE}/api/employees/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
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
  test('approval gates receiving, prevents over-receipt, and audits valid receipts', async () => {
    const cookie = await loginCookie();
    const [suppliers, branches, products] = await Promise.all([
      api(cookie, 'GET', '/api/suppliers'), api(cookie, 'GET', '/api/branches'), api(cookie, 'GET', '/api/products'),
    ]);
    expect(suppliers.status).toBe(200); expect(branches.status).toBe(200); expect(products.status).toBe(200);
    const supplier = suppliers.body.find(x => x.active !== 0);
    const branch = branches.body.find(x => x.active !== 0);
    const product = products.body.find(x => x.active !== 0 && !x.is_service);
    expect(supplier).toBeTruthy(); expect(branch).toBeTruthy(); expect(product).toBeTruthy();

    const created = await api(cookie, 'POST', '/api/purchase-orders', {
      supplier_id: supplier.id, branch_id: branch.id,
      items: [{ product_id: product.id, quantity_ordered: 2, unit_cost: Number(product.cost) || 1 }],
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
    expect(over.body.error).toMatch(/only 2 remain open/i);

    const received = await api(cookie, 'PATCH', `/api/purchase-orders/${po.id}/receive`, { items: [{ item_id: item.id, quantity_received: 2 }] });
    expect(received.status).toBe(200);
    expect(received.body.status).toBe('received');
    expect(Number(received.body.items[0].quantity_received)).toBe(2);

    const movements = await api(cookie, 'GET', '/api/operational-reports/inventory-movements?start=2020-01-01&end=2030-12-31');
    expect(movements.status).toBe(200);
    expect(movements.body.rows.some(x => x.reference === po.po_number && x.type === 'purchase_receive' && Number(x.quantity_change) === 2)).toBe(true);
  });
});
