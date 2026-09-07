const { test, expect } = require('@playwright/test');
const { ensureReady } = require('../database');
const concurrency = require('../routes/lifecycle-concurrency-guard');

function req(path, method='PATCH', body={}) {
  return { path, method, body, employee: { id: 987654 }, apiKey: null };
}

test.describe('POS lifecycle concurrency certification', () => {
  test.beforeAll(async () => {
    await ensureReady();
    await concurrency.ensureSchema();
  });

  test('distinct requests cannot concurrently own the same business lifecycle resource', async () => {
    const key = `certification:concurrency:${Date.now()}:${Math.random()}`;
    const actor = req('/purchase-orders/1/receive');
    const [a,b] = await Promise.all([
      concurrency.acquire(key, actor),
      concurrency.acquire(key, actor),
    ]);
    const winners = [a,b].filter(Boolean);
    expect(winners).toHaveLength(1);
    const loser = a ? b : a;
    expect(loser).toBeNull();

    await concurrency.release(key, winners[0].token);
    const afterRelease = await concurrency.acquire(key, actor);
    expect(afterRelease).toBeTruthy();
    await concurrency.release(key, afterRelease.token);
  });

  test('high-risk routes collapse onto authoritative lifecycle resource keys', async () => {
    expect(concurrency.resourceFor(req('/purchase-orders/42/receive'))).toBe('purchase_order:42:receiving');
    expect(concurrency.resourceFor(req('/rentals/agreements/9/checkout'))).toBe('rental_agreement:9:lifecycle');
    expect(concurrency.resourceFor(req('/rentals/agreements/9/return'))).toBe('rental_agreement:9:lifecycle');
    expect(concurrency.resourceFor(req('/work-orders/7/signoff'))).toBe('work_order:7:financial_lifecycle');
    expect(concurrency.resourceFor(req('/work-orders/7/final-payment'))).toBe('work_order:7:financial_lifecycle');
    expect(concurrency.resourceFor(req('/transfers/5/receive'))).toBe('transfer:5:receive');
    expect(concurrency.resourceFor(req('/transactions/11/return','POST'))).toBe('transaction:11:return');
    expect(concurrency.resourceFor(req('/logistics-intelligence/from-purchase-order/3','POST'))).toBe('dispatch:purchase_order:3:supplier_pickup');
    expect(concurrency.resourceFor(req('/logistics-intelligence/from-rental/4','POST',{direction:'pickup'}))).toBe('dispatch:rental:4:pickup');
  });

  test('native sale and rental creation require operation identity', async () => {
    expect(concurrency.requiresRequestIdentity(req('/transactions','POST'))).toBe(true);
    expect(concurrency.requiresRequestIdentity(req('/rentals/agreements','POST'))).toBe(true);
    expect(concurrency.requiresRequestIdentity(req('/transactions/11/return','POST'))).toBe(false);
  });
});
