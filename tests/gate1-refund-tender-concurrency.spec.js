const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:3001';
const ADMIN_USER = process.env.POS_TEST_USER || 'admin';
const ADMIN_PASSWORD = process.env.POS_TEST_PASSWORD || '123456';

async function login(username = ADMIN_USER, password = ADMIN_PASSWORD) {
  const response = await fetch(`${BASE}/api/employees/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  expect(response.status).toBe(200);
  return { cookie: (response.headers.get('set-cookie') || '').split(';')[0], body: await response.json() };
}

async function api(cookie, path, options = {}) {
  const headers = { Cookie: cookie, Accept: 'application/json', ...(options.headers || {}) };
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${BASE}${path}`, { ...options, headers });
  return { status: response.status, body: await response.json().catch(() => null) };
}

test.describe('Gate 1 refund tender concurrency invariants', () => {
  test('concurrent refunds cannot return more cash than the original cash tender', async () => {
    const admin = await login();
    const branches = await api(admin.cookie, '/api/branches');
    expect(branches.status).toBe(200);
    const branch = branches.body.find(row => row.active !== 0);
    test.skip(!branch, 'Gate 1 refund concurrency requires an active branch');

    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
    let product = null;
    let drawer = null;
    let group = null;
    let employee = null;
    let session = null;
    const username = `g1ref_${suffix.slice(-12)}`;
    const password = `G1!${suffix}Aa9`;
    const pin = String(Date.now()).slice(-6);

    try {
      let response = await api(admin.cookie, '/api/products', {
        method: 'POST',
        body: JSON.stringify({ sku: `G1-REF-${suffix}`, name: `Gate 1 Refund Race ${suffix}`, price: 100, cost: 50, tax_rate: 0, stock_qty: 0, min_stock: 0, active: 1, branch_id: branch.id, taxable: 1 }),
      });
      expect(response.status).toBe(201);
      product = response.body;

      response = await api(admin.cookie, `/api/products/${product.id}/stock`, {
        method: 'PATCH',
        body: JSON.stringify({ branch_id: branch.id, adjustment: 2, reason: 'Gate 1 refund tender fixture' }),
      });
      expect(response.status).toBe(200);

      response = await api(admin.cookie, '/api/drawers', { method: 'POST', body: JSON.stringify({ branch_id: branch.id, name: `Gate 1 Refund Drawer ${suffix}` }) });
      expect(response.status).toBe(201);
      drawer = response.body;

      response = await api(admin.cookie, '/api/security-groups', {
        method: 'POST',
        body: JSON.stringify({ name: `Gate 1 Refund Cashier ${suffix}`, description: 'Refund tender concurrency fixture', reason: 'Gate 1 refund tender certification', permissions: { pos: true, transactions_returns: true, transactions_refund: true, drawers_open: true, drawers_close: true } }),
      });
      expect(response.status).toBe(201);
      group = response.body;

      response = await api(admin.cookie, '/api/employees', {
        method: 'POST',
        body: JSON.stringify({ first_name: 'Gate1', last_name: 'RefundRace', username, password, pin, security_group_id: group.id, default_branch_id: branch.id, must_change_password: false }),
      });
      expect(response.status).toBe(201);
      employee = response.body;

      const cashier = await login(username, password);
      response = await api(cashier.cookie, '/api/drawers/sessions', { method: 'POST', body: JSON.stringify({ drawer_id: drawer.id, opening_float: 200 }) });
      expect([200, 201]).toContain(response.status);
      session = response.body;

      const sale = await api(cashier.cookie, '/api/transactions', {
        method: 'POST',
        body: JSON.stringify({
          branch_id: branch.id,
          drawer_session_id: session.id,
          items: [{ product_id: product.id, quantity: 2 }],
          tenders: [
            { method: 'cash', amount: 100 },
            { method: 'card', amount: 100, approval_code: `CARD-${suffix}` },
          ],
          notes: 'Gate 1 split tender refund race',
        }),
      });
      expect(sale.status).toBe(201);
      expect(sale.body.payments.filter(p => p.payment_method === 'cash').reduce((sum, p) => sum + Number(p.amount), 0)).toBe(100);
      expect(sale.body.payments.filter(p => p.payment_method === 'card').reduce((sum, p) => sum + Number(p.amount), 0)).toBe(100);
      const transactionId = sale.body.id;
      const transactionItemId = sale.body.items?.[0]?.id;

      const makeReturn = notes => api(cashier.cookie, `/api/transactions/${transactionId}/return`, {
        method: 'POST',
        body: JSON.stringify({ resolution: 'refund', items: [{ transaction_item_id: transactionItemId, quantity: 1 }], notes }),
      });
      const firstReturn = await makeReturn('Gate 1 refund race return A');
      const secondReturn = await makeReturn('Gate 1 refund race return B');
      expect(firstReturn.status).toBe(201);
      expect(secondReturn.status).toBe(201);
      expect(Number(firstReturn.body.allocation.external_refund_total)).toBe(100);
      expect(Number(secondReturn.body.allocation.external_refund_total)).toBe(100);

      const settleCash = returnId => api(cashier.cookie, `/api/transactions/returns/${returnId}/settle`, {
        method: 'POST',
        body: JSON.stringify({ drawer_session_id: session.id, tenders: [{ method: 'cash', amount: 100 }] }),
      });
      const [settlementA, settlementB] = await Promise.all([settleCash(firstReturn.body.id), settleCash(secondReturn.body.id)]);
      const cashSuccesses = [settlementA, settlementB].filter(result => result.status === 201);
      const cashRejected = [settlementA, settlementB].filter(result => result.status !== 201);
      expect(cashSuccesses).toHaveLength(1);
      expect(cashRejected).toHaveLength(1);
      expect([400, 409]).toContain(cashRejected[0].status);
      expect(String(cashRejected[0].body?.error || '')).toMatch(/REFUND_EXCEEDS_ORIGINAL_TENDER|exceeds the remaining amount originally tendered/i);

      const rejectedReturnId = settlementA.status === 201 ? secondReturn.body.id : firstReturn.body.id;
      const cardSettlement = await api(cashier.cookie, `/api/transactions/returns/${rejectedReturnId}/settle`, {
        method: 'POST',
        body: JSON.stringify({ tenders: [{ method: 'card', amount: 100, reference_code: `REF-${suffix}` }] }),
      });
      expect(cardSettlement.status).toBe(201);

      const drawerEvidence = await api(cashier.cookie, `/api/drawers/sessions/${session.id}`);
      expect(drawerEvidence.status).toBe(200);
      const cashEvidence = drawerEvidence.body.net_tenders?.find(t => t.payment_method === 'cash');
      expect(Number(cashEvidence?.refunds || 0)).toBe(100);
    } finally {
      if (session?.id) await api(admin.cookie, `/api/drawers/sessions/${session.id}/close`, { method: 'PATCH', body: JSON.stringify({}) }).catch(() => {});
      if (employee) await api(admin.cookie, `/api/employees/${employee.id}`, { method: 'PUT', body: JSON.stringify({ first_name: employee.first_name, last_name: employee.last_name, username, active: 0, security_group_id: group?.id || null, default_branch_id: branch.id, must_change_password: false }) }).catch(() => {});
      if (group) await api(admin.cookie, `/api/security-groups/${group.id}?reason=Gate%201%20refund%20cleanup`, { method: 'DELETE' }).catch(() => {});
      if (drawer) await api(admin.cookie, `/api/drawers/${drawer.id}`, { method: 'DELETE' }).catch(() => {});
      if (product) await api(admin.cookie, `/api/products/${product.id}`, { method: 'DELETE' }).catch(() => {});
    }
  });
});
