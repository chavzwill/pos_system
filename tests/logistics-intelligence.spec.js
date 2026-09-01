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

test.describe('Dispatch and logistics intelligence', () => {
  test('requires authentication', async () => {
    const r = await fetch(`${BASE}/api/logistics-intelligence/command-center`);
    expect(r.status).toBe(401);
  });

  test('command center exposes deterministic operational intelligence', async () => {
    const cookie = await loginCookie();
    const r = await fetch(`${BASE}/api/logistics-intelligence/command-center`, { headers: { Cookie: cookie } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.summary).toEqual(expect.objectContaining({ open_jobs: expect.any(Number), at_risk: expect.any(Number), unassigned: expect.any(Number), in_transit: expect.any(Number) }));
    expect(Array.isArray(body.jobs)).toBe(true);
    expect(Array.isArray(body.uncovered_transfers)).toBe(true);
    expect(body.routing_note).toMatch(/geocoded|distance|not fabricated/i);
  });

  test('manual dispatch jobs preserve source and route labels', async () => {
    const cookie = await loginCookie();
    const r = await fetch(`${BASE}/api/logistics-intelligence/jobs`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_type: 'test', origin_label: 'North Branch', destination_label: 'South Branch', job_type: 'branch_transfer', priority: 'high' }),
    });
    expect(r.status).toBe(201);
    const job = await r.json();
    expect(job).toMatchObject({ source_type: 'test', origin_label: 'North Branch', destination_label: 'South Branch', job_type: 'branch_transfer', priority: 'high', status: 'unassigned' });
  });
});
