import { test, expect } from '@playwright/test';
import { registerPurchasingFinancialRuntimeCertification } from './purchasing-financial-runtime-helper.js';
import { registerRentalFinancialRuntimeCertification } from './rental-financial-runtime-helper.js';
import { registerRepairFinancialRuntimeCertification } from './repair-financial-runtime-helper.js';
import { registerDispatchFieldRuntimeCertification } from './dispatch-field-runtime-helper.js';

const BASE = 'http://localhost:3001';

async function loginCookie() {
  const r = await fetch(`${BASE}/api/employees/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: process.env.POS_TEST_USER || 'admin',
      password: process.env.POS_TEST_PASSWORD || '123456',
    }),
  });
  expect(r.status).toBe(200);
  return (r.headers.get('set-cookie') || '').split(';')[0];
}

async function api(cookie, path) {
  const r = await fetch(`${BASE}${path}`, {
    headers: { Cookie: cookie, Accept: 'application/json' },
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

function expectObject(value) {
  expect(value).toBeTruthy();
  expect(typeof value).toBe('object');
}

test.describe('Cross-module business integrity', () => {
  test('authenticated business domains return coherent live payloads', async () => {
    const cookie = await loginCookie();

    const [profile, erp, accounting, performance, management] = await Promise.all([
      api(cookie, '/api/workspace-profile/me'),
      api(cookie, '/api/erp-intelligence/alerts'),
      api(cookie, '/api/accounting-intelligence/overview'),
      api(cookie, '/api/technician-compensation/performance/summary'),
      api(cookie, '/api/technician-management-intelligence/overview?days=30'),
    ]);

    expect(profile.status).toBe(200);
    expectObject(profile.body);
    expectObject(profile.body.permissions);

    expect(erp.status).toBe(200);
    expect(Array.isArray(erp.body.alerts)).toBe(true);
    expectObject(erp.body.counts);

    expect(accounting.status).toBe(200);
    expectObject(accounting.body.sales);
    expectObject(accounting.body.margin);
    expectObject(accounting.body.receivables);

    expect(performance.status).toBe(200);
    expect(Array.isArray(performance.body.rows)).toBe(true);
    expectObject(performance.body.weights);
    for (const row of performance.body.rows) {
      expectObject(row.scorecard);
      expect(row.scorecard.incentive_review?.automatic_pay_change).toBe(false);
      expect(Number(row.scorecard.evidence_coverage_percent)).toBeGreaterThanOrEqual(0);
      expect(Number(row.scorecard.evidence_coverage_percent)).toBeLessThanOrEqual(100);
    }

    expect(management.status).toBe(200);
    expect(Array.isArray(management.body.alerts)).toBe(true);
    expectObject(management.body.summary);
  });

  test('repair QC evidence chain is internally consistent for existing work orders', async () => {
    const cookie = await loginCookie();
    const list = await api(cookie, '/api/work-orders?limit=20');
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);
    if (!list.body.length) return;

    const wo = list.body[0];
    const [detail, readiness, history] = await Promise.all([
      api(cookie, `/api/work-orders/${wo.id}`),
      api(cookie, `/api/repair-quality/work-orders/${wo.id}/readiness`),
      api(cookie, `/api/repair-quality/work-orders/${wo.id}/quality-history`),
    ]);

    expect(detail.status).toBe(200);
    expect(detail.body.id).toBe(wo.id);
    expect(Array.isArray(detail.body.tasks)).toBe(true);
    expect(Array.isArray(detail.body.items)).toBe(true);

    expect(readiness.status).toBe(200);
    expect(readiness.body.work_order_id).toBe(wo.id);
    expect(typeof readiness.body.ready_for_qc).toBe('boolean');
    expectObject(readiness.body.checks);
    expect(Array.isArray(readiness.body.blocking_reasons)).toBe(true);

    expect(history.status).toBe(200);
    expect(Array.isArray(history.body.quality_reviews)).toBe(true);
    expect(Array.isArray(history.body.comebacks)).toBe(true);
    expect(Array.isArray(history.body.performance_events)).toBe(true);
  });

  test('rental lifecycle queue and detail agree on core identity and status', async () => {
    const cookie = await loginCookie();
    const list = await api(cookie, '/api/rentals/agreements');
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);
    if (!list.body.length) return;

    const row = list.body[0];
    const detail = await api(cookie, `/api/rentals/agreements/${row.id}`);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body.id).toBe(row.id);
    expect(detail.body.agreement_number).toBe(row.agreement_number);
    expect(detail.body.status).toBeTruthy();
    expect(Array.isArray(detail.body.items)).toBe(true);

    if (row.status) expect(detail.body.status).toBe(row.status);
  });

  test('operational intelligence remains read-only while surfacing real business evidence', async () => {
    const cookie = await loginCookie();
    const before = await api(cookie, '/api/erp-intelligence/alerts');
    expect(before.status).toBe(200);
    expect(Array.isArray(before.body.alerts)).toBe(true);

    const after = await api(cookie, '/api/erp-intelligence/alerts');
    expect(after.status).toBe(200);
    expect(Array.isArray(after.body.alerts)).toBe(true);

    for (const alert of after.body.alerts) {
      expect(alert.automatic_action_taken).not.toBe(true);
      expect(alert.automatic_pay_change).not.toBe(true);
    }
  });
});

registerPurchasingFinancialRuntimeCertification();
registerRentalFinancialRuntimeCertification();
registerRepairFinancialRuntimeCertification();
registerDispatchFieldRuntimeCertification();
