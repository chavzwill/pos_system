import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:3001';

async function loginCookie() {
  const r = await fetch(`${BASE}/api/employees/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.POS_TEST_USER || 'admin', password: process.env.POS_TEST_PASSWORD || '123456' }),
  });
  expect(r.status).toBe(200);
  return (r.headers.get('set-cookie') || '').split(';')[0];
}

async function json(r) { return r.json().catch(() => ({})); }

test.describe('Repair quality integrity', () => {
  test('quality evidence endpoints require authentication', async () => {
    const [readiness, history, qc, comeback] = await Promise.all([
      fetch(`${BASE}/api/repair-quality/work-orders/1/readiness`),
      fetch(`${BASE}/api/repair-quality/work-orders/1/quality-history`),
      fetch(`${BASE}/api/repair-quality/work-orders/1/qc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ result: 'pass' }) }),
      fetch(`${BASE}/api/repair-quality/work-orders/1/comeback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'test' }) }),
    ]);
    for (const r of [readiness, history, qc, comeback]) expect(r.status).toBe(401);
  });

  test('nonexistent work orders fail consistently instead of returning empty evidence', async () => {
    const cookie = await loginCookie();
    const id = 2147483000;
    const readiness = await fetch(`${BASE}/api/repair-quality/work-orders/${id}/readiness`, { headers: { Cookie: cookie } });
    const history = await fetch(`${BASE}/api/repair-quality/work-orders/${id}/quality-history`, { headers: { Cookie: cookie } });
    expect(readiness.status).toBe(404);
    expect(history.status).toBe(404);
  });

  test('readiness exposes explicit blockers and pass QC cannot bypass them', async () => {
    const cookie = await loginCookie();
    const list = await fetch(`${BASE}/api/work-orders?limit=200`, { headers: { Cookie: cookie } });
    expect(list.status).toBe(200);
    const workOrders = await json(list);
    expect(Array.isArray(workOrders)).toBe(true);

    let candidate = null;
    let readinessBody = null;
    for (const wo of workOrders) {
      const r = await fetch(`${BASE}/api/repair-quality/work-orders/${wo.id}/readiness`, { headers: { Cookie: cookie } });
      if (!r.ok) continue;
      const body = await json(r);
      expect(typeof body.ready_for_qc).toBe('boolean');
      expect(body.checks).toBeTruthy();
      expect(Array.isArray(body.blocking_reasons)).toBe(true);
      if (!body.ready_for_qc) { candidate = wo; readinessBody = body; break; }
    }

    test.skip(!candidate, 'No non-QC-ready work order exists in this dataset');
    expect(readinessBody.blocking_reasons.length).toBeGreaterThan(0);

    const pass = await fetch(`${BASE}/api/repair-quality/work-orders/${candidate.id}/qc`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ result: 'pass', checklist: {} }),
    });
    expect(pass.status).toBe(409);
    const body = await json(pass);
    expect(body.error).toMatch(/not ready/i);
    expect(body.blocking_reasons).toEqual(readinessBody.blocking_reasons);
  });

  test('a work order cannot be linked to itself as a comeback', async () => {
    const cookie = await loginCookie();
    const list = await fetch(`${BASE}/api/work-orders?limit=200`, { headers: { Cookie: cookie } });
    expect(list.status).toBe(200);
    const workOrders = await json(list);
    const candidate = workOrders.find(wo => wo.id);
    test.skip(!candidate, 'No work orders exist in this dataset');

    const readiness = await fetch(`${BASE}/api/repair-quality/work-orders/${candidate.id}/readiness`, { headers: { Cookie: cookie } });
    expect(readiness.status).toBe(200);
    const evidence = await json(readiness);
    test.skip(!evidence.technician_id, 'Selected work order has no attributable technician');

    const r = await fetch(`${BASE}/api/repair-quality/work-orders/${candidate.id}/comeback`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        comeback_work_order_id: candidate.id,
        technician_id: evidence.technician_id,
        confirmed: true,
        reason: 'Release-gate self-link rejection check',
      }),
    });
    expect(r.status).toBe(409);
    expect((await json(r)).error).toMatch(/own comeback/i);
  });
});
