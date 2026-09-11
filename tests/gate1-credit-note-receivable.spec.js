const { test, expect } = require('@playwright/test');
const { db, ensureReady } = require('../database');

const BASE = 'http://localhost:3001';
const ADMIN_USER = process.env.POS_TEST_USER || 'admin';
const ADMIN_PASSWORD = process.env.POS_TEST_PASSWORD || '123456';

async function login() {
  const response = await fetch(`${BASE}/api/employees/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASSWORD }),
  });
  expect(response.status).toBe(200);
  return (response.headers.get('set-cookie') || '').split(';')[0];
}

async function api(cookie, path, options = {}) {
  const headers = { Cookie: cookie, Accept: 'application/json', ...(options.headers || {}) };
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${BASE}${path}`, { ...options, headers });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function fixture(cookie, suffix, quantity = 2, price = 50) {
  const branches = await api(cookie, '/api/branches');
  expect(branches.status).toBe(200);
  const branch = branches.body.find(row => row.active !== 0);
  test.skip(!branch, 'Gate 1 credit-note certification requires an active branch');

  const customerResponse = await api(cookie, '/api/customers', {
    method: 'POST',
    body: JSON.stringify({
      first_name: 'Gate1',
      last_name: `CreditNote${suffix}`,
      customer_type: 'credit',
      credit_limit: 10000,
      credit_terms_days: 30,
    }),
  });
  expect(customerResponse.status, JSON.stringify(customerResponse.body)).toBe(201);
  const customer = customerResponse.body;

  const productResponse = await api(cookie, '/api/products', {
    method: 'POST',
    body: JSON.stringify({
      sku: `G1-CN-${suffix}`,
      name: `Gate 1 Credit Note ${suffix}`,
      price,
      cost: Math.max(1, price / 2),
      tax_rate: 0,
      stock_qty: 0,
      min_stock: 0,
      active: 1,
      branch_id: branch.id,
      taxable: 1,
    }),
  });
  expect(productResponse.status, JSON.stringify(productResponse.body)).toBe(201);
  const product = productResponse.body;

  const stock = await api(cookie, `/api/products/${product.id}/stock`, {
    method: 'PATCH',
    body: JSON.stringify({ branch_id: branch.id, adjustment: quantity + 2, reason: 'Gate 1 credit-note receivable certification' }),
  });
  expect(stock.status).toBe(200);

  return { branch, customer, product, quantity, price };
}

async function sell(cookie, fx, paymentMethod = 'credit', quantity = fx.quantity) {
  const sale = await api(cookie, '/api/transactions', {
    method: 'POST',
    body: JSON.stringify({
      branch_id: fx.branch.id,
      customer_id: fx.customer.id,
      items: [{ product_id: fx.product.id, quantity }],
      payment_method: paymentMethod,
      amount_tendered: paymentMethod === 'credit' ? 0 : fx.price * quantity,
      notes: `Gate 1 ${paymentMethod} sale for credit-note invariant`,
    }),
  });
  expect(sale.status, JSON.stringify(sale.body)).toBe(201);
  expect(sale.body.items?.[0]?.id).toBeTruthy();
  return sale.body;
}

async function customer(cookie, id) {
  const response = await api(cookie, `/api/customers/${id}`);
  expect(response.status).toBe(200);
  return response.body;
}

test.describe('Gate 1 credit-note receivable invariant', () => {
  test('database authority rejects a credit note that tries to move receivable in the wrong direction', async () => {
    const cookie = await login();
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
    const fx = await fixture(cookie, suffix, 1, 40);
    const sale = await sell(cookie, fx, 'credit', 1);
    expect(Number((await customer(cookie, fx.customer.id)).account_balance)).toBe(40);

    const init = await api(cookie, '/api/accounts/aging');
    expect(init.status).toBe(200);
    await ensureReady();

    const tx = await db.transaction('write');
    let rolledBack = false;
    try {
      const returnNumber = `CN-GUARD-${suffix}`;
      await tx.execute({
        sql: `INSERT INTO returns(return_number,original_transaction_id,customer_id,employee_id,branch_id,resolution,subtotal,tax_amount,total,notes)
              VALUES(?,?,?,?,?,'credit_note',40,0,40,'Adversarial wrong-direction probe')`,
        args: [returnNumber, sale.id, fx.customer.id, sale.employee_id || 1, fx.branch.id],
      });
      let error = null;
      try {
        await tx.execute({ sql: 'UPDATE customers SET account_balance=account_balance+40 WHERE id=?', args: [fx.customer.id] });
      } catch (e) {
        error = e;
      }
      expect(error).toBeTruthy();
      expect(String(error.message || error)).toMatch(/CREDIT_NOTE_RECEIVABLE_DIRECTION_VIOLATION/);
      await tx.rollback();
      rolledBack = true;
    } finally {
      if (!rolledBack) await tx.rollback().catch(() => {});
    }

    expect(Number((await customer(cookie, fx.customer.id)).account_balance)).toBe(40);
  });

  test('two valid concurrent partial credit notes reduce receivable exactly once each and reconcile the invoice', async () => {
    const cookie = await login();
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
    const fx = await fixture(cookie, suffix, 2, 50);
    const sale = await sell(cookie, fx, 'credit', 2);
    const itemId = sale.items[0].id;

    expect(Number((await customer(cookie, fx.customer.id)).account_balance)).toBe(100);
    let invoices = await api(cookie, `/api/accounts/invoices/${fx.customer.id}`);
    expect(invoices.status).toBe(200);
    expect(Number(invoices.body.find(row => Number(row.id) === Number(sale.id))?.balance_due)).toBe(100);

    const returnBody = JSON.stringify({
      resolution: 'credit_note',
      items: [{ transaction_item_id: itemId, quantity: 1 }],
      notes: 'Gate 1 concurrent partial credit note',
    });
    const [first, second] = await Promise.all([
      api(cookie, `/api/transactions/${sale.id}/return`, { method: 'POST', body: returnBody }),
      api(cookie, `/api/transactions/${sale.id}/return`, { method: 'POST', body: returnBody }),
    ]);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(Number(first.body.total)).toBe(50);
    expect(Number(second.body.total)).toBe(50);

    const after = await customer(cookie, fx.customer.id);
    expect(Number(after.account_balance)).toBe(0);

    invoices = await api(cookie, `/api/accounts/invoices/${fx.customer.id}`);
    expect(invoices.status).toBe(200);
    expect(invoices.body.some(row => Number(row.id) === Number(sale.id))).toBe(false);

    const returns = await api(cookie, `/api/transactions/${sale.id}/returns`);
    expect(returns.status).toBe(200);
    const active = returns.body.filter(row => String(row.status || 'completed') !== 'cancelled');
    expect(active).toHaveLength(2);
    expect(active.reduce((sum, row) => sum + Number(row.total || 0), 0)).toBe(100);

    const overCredit = await api(cookie, `/api/transactions/${sale.id}/return`, {
      method: 'POST',
      body: returnBody,
    });
    expect([400, 409]).toContain(overCredit.status);
    expect(Number((await customer(cookie, fx.customer.id)).account_balance)).toBe(0);
  });

  test('a credit note on a paid cash sale creates store credit instead of a positive receivable', async () => {
    const cookie = await login();
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
    const fx = await fixture(cookie, suffix, 1, 30);
    const sale = await sell(cookie, fx, 'cash', 1);
    expect(Number((await customer(cookie, fx.customer.id)).account_balance)).toBe(0);

    const credit = await api(cookie, `/api/transactions/${sale.id}/return`, {
      method: 'POST',
      body: JSON.stringify({
        resolution: 'credit_note',
        items: [{ transaction_item_id: sale.items[0].id, quantity: 1 }],
        notes: 'Gate 1 store-credit direction proof',
      }),
    });
    expect(credit.status, JSON.stringify(credit.body)).toBe(201);
    expect(Number(credit.body.total)).toBe(30);
    expect(Number((await customer(cookie, fx.customer.id)).account_balance)).toBe(-30);
  });
});
