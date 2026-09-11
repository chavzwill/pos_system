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
  return {
    cookie: (response.headers.get('set-cookie') || '').split(';')[0],
    body: await response.json(),
  };
}

async function api(cookie, path, options = {}) {
  const headers = { Cookie: cookie, Accept: 'application/json', ...(options.headers || {}) };
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${BASE}${path}`, { ...options, headers });
  return { status: response.status, body: await response.json().catch(() => null) };
}

test.describe('Gate 1 return concurrency invariants', () => {
  test('two simultaneous full returns cannot restore the same sold quantity twice', async () => {
    const admin = await login();
    const branches = await api(admin.cookie, '/api/branches');
    expect(branches.status).toBe(200);
    const branch = branches.body.find(row => row.active !== 0);
    test.skip(!branch, 'Gate 1 return concurrency requires an active branch');

    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
    let product = null;
    let drawer = null;
    let group = null;
    let employee = null;
    let session = null;
    const username = `g1ret_${suffix.slice(-12)}`;
    const password = `G1!${suffix}Aa9`;
    const pin = String(Date.now()).slice(-6);

    try {
      let response = await api(admin.cookie, '/api/products', {
        method: 'POST',
        body: JSON.stringify({
          sku: `G1-RET-${suffix}`,
          name: `Gate 1 Return Race ${suffix}`,
          price: 100,
          cost: 55,
          tax_rate: 0,
          stock_qty: 0,
          min_stock: 0,
          active: 1,
          branch_id: branch.id,
          taxable: 1,
        }),
      });
      expect(response.status).toBe(201);
      product = response.body;

      response = await api(admin.cookie, `/api/products/${product.id}/stock`, {
        method: 'PATCH',
        body: JSON.stringify({ branch_id: branch.id, adjustment: 1, reason: 'Gate 1 concurrent return fixture' }),
      });
      expect(response.status).toBe(200);

      response = await api(admin.cookie, '/api/drawers', {
        method: 'POST',
        body: JSON.stringify({ branch_id: branch.id, name: `Gate 1 Return Drawer ${suffix}` }),
      });
      expect(response.status).toBe(201);
      drawer = response.body;

      response = await api(admin.cookie, '/api/security-groups', {
        method: 'POST',
        body: JSON.stringify({
          name: `Gate 1 Return Cashier ${suffix}`,
          description: 'Concurrent return certification fixture',
          reason: 'Gate 1 return concurrency certification',
          permissions: {
            pos: true,
            transactions_returns: true,
            transactions_refund: true,
            drawers_open: true,
            drawers_close: true,
          },
        }),
      });
      expect(response.status).toBe(201);
      group = response.body;

      response = await api(admin.cookie, '/api/employees', {
        method: 'POST',
        body: JSON.stringify({
          first_name: 'Gate1',
          last_name: 'ReturnRace',
          username,
          password,
          pin,
          security_group_id: group.id,
          default_branch_id: branch.id,
          must_change_password: false,
        }),
      });
      expect(response.status).toBe(201);
      employee = response.body;

      const cashier = await login(username, password);
      response = await api(cashier.cookie, '/api/drawers/sessions', {
        method: 'POST',
        body: JSON.stringify({ drawer_id: drawer.id, opening_float: 0 }),
      });
      expect([200, 201]).toContain(response.status);
      session = response.body;

      const sale = await api(cashier.cookie, '/api/transactions', {
        method: 'POST',
        body: JSON.stringify({
          branch_id: branch.id,
          drawer_session_id: session.id,
          items: [{ product_id: product.id, quantity: 1 }],
          payment_method: 'cash',
          amount_tendered: 100,
          notes: 'Gate 1 concurrent return sale',
        }),
      });
      expect(sale.status).toBe(201);
      const transactionId = sale.body.id;
      const transactionItemId = sale.body.items?.[0]?.id;
      expect(transactionItemId).toBeTruthy();

      const afterSale = await api(cashier.cookie, `/api/products/${product.id}?branch_id=${branch.id}`);
      expect(afterSale.status).toBe(200);
      expect(Number(afterSale.body.branch_stock_qty)).toBe(0);

      const returnBody = JSON.stringify({
        resolution: 'refund',
        items: [{ transaction_item_id: transactionItemId, quantity: 1 }],
        notes: 'Gate 1 simultaneous double-return attack',
      });
      const [first, second] = await Promise.all([
        api(cashier.cookie, `/api/transactions/${transactionId}/return`, { method: 'POST', body: returnBody }),
        api(cashier.cookie, `/api/transactions/${transactionId}/return`, { method: 'POST', body: returnBody }),
      ]);

      const successes = [first, second].filter(result => result.status === 201);
      const rejected = [first, second].filter(result => result.status !== 201);
      expect(successes).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect([400, 409]).toContain(rejected[0].status);
      expect(String(rejected[0].body?.error || '')).toMatch(/RETURN_QUANTITY_EXCEEDS_ELIGIBLE|Max returnable|remaining unreturned/i);

      const afterRace = await api(cashier.cookie, `/api/products/${product.id}?branch_id=${branch.id}`);
      expect(afterRace.status).toBe(200);
      expect(Number(afterRace.body.branch_stock_qty)).toBe(1);

      const returns = await api(cashier.cookie, `/api/transactions/${transactionId}/returns`);
      expect(returns.status).toBe(200);
      expect(returns.body.filter(row => String(row.status || 'completed') !== 'cancelled')).toHaveLength(1);
    } finally {
      if (session?.id) {
        await api(admin.cookie, `/api/drawers/sessions/${session.id}/close`, { method: 'PATCH', body: JSON.stringify({}) }).catch(() => {});
      }
      if (employee) {
        await api(admin.cookie, `/api/employees/${employee.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            first_name: employee.first_name,
            last_name: employee.last_name,
            username,
            active: 0,
            security_group_id: group?.id || null,
            default_branch_id: branch.id,
            must_change_password: false,
          }),
        }).catch(() => {});
      }
      if (group) await api(admin.cookie, `/api/security-groups/${group.id}?reason=Gate%201%20return%20cleanup`, { method: 'DELETE' }).catch(() => {});
      if (drawer) await api(admin.cookie, `/api/drawers/${drawer.id}`, { method: 'DELETE' }).catch(() => {});
      if (product) await api(admin.cookie, `/api/products/${product.id}`, { method: 'DELETE' }).catch(() => {});
    }
  });
});
