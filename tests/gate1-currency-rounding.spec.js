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

async function fixture(cookie, suffix, { quantity, price, taxRate }) {
  const branches = await api(cookie, '/api/branches');
  expect(branches.status).toBe(200);
  const branch = branches.body.find(row => row.active !== 0);
  test.skip(!branch, 'Gate 1 currency certification requires an active branch');

  const customerResponse = await api(cookie, '/api/customers', {
    method: 'POST',
    body: JSON.stringify({
      first_name: 'Gate1',
      last_name: `Rounding${suffix}`,
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
      sku: `G1-RND-${suffix}`,
      name: `Gate 1 Rounding ${suffix}`,
      price,
      cost: 0,
      tax_rate: taxRate,
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
    body: JSON.stringify({ branch_id: branch.id, adjustment: quantity + 2, reason: 'Gate 1 cent-allocation certification' }),
  });
  expect(stock.status).toBe(200);

  const sale = await api(cookie, '/api/transactions', {
    method: 'POST',
    body: JSON.stringify({
      branch_id: branch.id,
      customer_id: customer.id,
      items: [{ product_id: product.id, quantity }],
      payment_method: 'credit',
      amount_tendered: 0,
      notes: 'Gate 1 deterministic rounding sale',
    }),
  });
  expect(sale.status, JSON.stringify(sale.body)).toBe(201);
  expect(sale.body.items?.[0]?.id).toBeTruthy();
  return { branch, customer, product, sale: sale.body, item: sale.body.items[0] };
}

async function creditOne(cookie, fx, note) {
  return api(cookie, `/api/transactions/${fx.sale.id}/return`, {
    method: 'POST',
    body: JSON.stringify({
      resolution: 'credit_note',
      items: [{ transaction_item_id: fx.item.id, quantity: 1 }],
      notes: note,
    }),
  });
}

async function activeReturnItems(transactionItemId) {
  const { rows } = await db.execute({
    sql: `SELECT ri.quantity,ri.total,ri.tax_amount,r.id return_id,r.status
          FROM return_items ri JOIN returns r ON r.id=ri.return_id
          WHERE ri.transaction_item_id=? AND COALESCE(r.status,'completed')!='cancelled'
          ORDER BY ri.id`,
    args: [transactionItemId],
  });
  return rows;
}

test.describe('Gate 1 deterministic currency and rounding invariants', () => {
  test('three partial returns reconcile fractional tax cents exactly to the original persisted line', async () => {
    const cookie = await login();
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
    const fx = await fixture(cookie, suffix, { quantity: 3, price: 0.07, taxRate: 8.5 });

    expect(Number(fx.item.total)).toBe(0.21);
    expect(Number(fx.item.tax_amount)).toBe(0.02);
    expect(Number(fx.sale.total)).toBe(0.23);

    const first = await creditOne(cookie, fx, 'Gate 1 rounding partial 1');
    const second = await creditOne(cookie, fx, 'Gate 1 rounding partial 2');
    const third = await creditOne(cookie, fx, 'Gate 1 rounding final residual');
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(third.status, JSON.stringify(third.body)).toBe(201);

    const rows = await activeReturnItems(fx.item.id);
    expect(rows).toHaveLength(3);
    const gross = Number(rows.reduce((sum, row) => sum + Number(row.total), 0).toFixed(2));
    const tax = Number(rows.reduce((sum, row) => sum + Number(row.tax_amount), 0).toFixed(2));
    expect(gross).toBe(0.21);
    expect(tax).toBe(0.02);
    expect(rows.map(row => Number(row.tax_amount))).toEqual([0.01, 0.01, 0]);

    const customer = await api(cookie, `/api/customers/${fx.customer.id}`);
    expect(customer.status).toBe(200);
    expect(Number(customer.body.account_balance)).toBe(0);
  });

  test('simultaneous partial returns cannot over-allocate one tax cent; retry receives the zero-cent residual', async () => {
    const cookie = await login();
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
    const fx = await fixture(cookie, suffix, { quantity: 2, price: 0.06, taxRate: 8.5 });

    expect(Number(fx.item.total)).toBe(0.12);
    expect(Number(fx.item.tax_amount)).toBe(0.01);
    expect(Number(fx.sale.total)).toBe(0.13);

    const [a, b] = await Promise.all([
      creditOne(cookie, fx, 'Gate 1 concurrent rounding A'),
      creditOne(cookie, fx, 'Gate 1 concurrent rounding B'),
    ]);
    const successes = [a, b].filter(result => result.status === 201);
    const rejected = [a, b].filter(result => result.status !== 201);
    expect(successes).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect([400, 409]).toContain(rejected[0].status);
    expect(String(rejected[0].body?.error || '')).toMatch(/RETURN_TAX_EXCEEDS_ORIGINAL_LINE|RETURN_QUANTITY_EXCEEDS_ELIGIBLE/);

    let rows = await activeReturnItems(fx.item.id);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].tax_amount)).toBe(0.01);

    const retry = await creditOne(cookie, fx, 'Gate 1 concurrent rounding deterministic retry');
    expect(retry.status, JSON.stringify(retry.body)).toBe(201);
    rows = await activeReturnItems(fx.item.id);
    expect(rows).toHaveLength(2);
    expect(Number(rows.reduce((sum, row) => sum + Number(row.total), 0).toFixed(2))).toBe(0.12);
    expect(Number(rows.reduce((sum, row) => sum + Number(row.tax_amount), 0).toFixed(2))).toBe(0.01);
    expect(rows.map(row => Number(row.tax_amount))).toEqual([0.01, 0]);

    const customer = await api(cookie, `/api/customers/${fx.customer.id}`);
    expect(customer.status).toBe(200);
    expect(Number(customer.body.account_balance)).toBe(0);
  });

  test('database return authority rejects sub-cent persisted money evidence', async () => {
    const cookie = await login();
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
    const fx = await fixture(cookie, suffix, { quantity: 1, price: 1, taxRate: 0 });

    // Touch the return pipeline so the authoritative trigger set is initialized.
    const init = await api(cookie, `/api/transactions/${fx.sale.id}/returns`);
    expect(init.status).toBe(200);
    await ensureReady();

    const tx = await db.transaction('write');
    let rolledBack = false;
    try {
      const returnNumber = `RND-DB-${suffix}`;
      const inserted = await tx.execute({
        sql: `INSERT INTO returns(return_number,original_transaction_id,customer_id,employee_id,branch_id,resolution,subtotal,tax_amount,total,notes)
              VALUES(?,?,?,?,?,'refund',1,0,1,'Sub-cent adversarial probe')`,
        args: [returnNumber, fx.sale.id, fx.customer.id, fx.sale.employee_id || 1, fx.branch.id],
      });
      const returnId = Number(inserted.lastInsertRowid);
      let error = null;
      try {
        await tx.execute({
          sql: `INSERT INTO return_items(return_id,transaction_item_id,product_id,product_name,sku,quantity,unit_price,tax_amount,total)
                VALUES(?,?,?,?,?,1,1,0,0.001)`,
          args: [returnId, fx.item.id, fx.product.id, fx.item.product_name, fx.item.sku],
        });
      } catch (e) {
        error = e;
      }
      expect(error).toBeTruthy();
      expect(String(error.message || error)).toMatch(/RETURN_VALUE_MUST_HAVE_CENT_PRECISION/);
      await tx.rollback();
      rolledBack = true;
    } finally {
      if (!rolledBack) await tx.rollback().catch(() => {});
    }
  });
});
