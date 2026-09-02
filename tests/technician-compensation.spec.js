import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:3001';
const TEST_USER = process.env.POS_TEST_USER || 'admin';
const TEST_PASSWORD = process.env.POS_TEST_PASSWORD || 'CI-Test-Auth!2026';

async function loginCookie() {
  const r = await fetch(`${BASE}/api/employees/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: TEST_USER, password: TEST_PASSWORD }),
  });
  expect(r.status).toBe(200);
  return (r.headers.get('set-cookie') || '').split(';')[0];
}

async function getPeriod(cookie, date) {
  const r = await fetch(`${BASE}/api/technician-compensation/period?date=${date}`, { headers: { Cookie: cookie } });
  expect(r.status).toBe(200);
  return r.json();
}

test.describe('Technician compensation', () => {
  test('requires staff authentication', async () => {
    const r = await fetch(`${BASE}/api/technician-compensation/period?date=2026-08-23`);
    expect(r.status).toBe(401);
  });

  test('uses the 14th through 28th pay period', async () => {
    const cookie = await loginCookie();
    expect(await getPeriod(cookie, '2026-08-14')).toMatchObject({ start: '2026-08-14', end: '2026-08-28', label: '14th–28th' });
    expect(await getPeriod(cookie, '2026-08-28')).toMatchObject({ start: '2026-08-14', end: '2026-08-28', label: '14th–28th' });
  });

  test('uses the 29th through 13th pay period across month boundary', async () => {
    const cookie = await loginCookie();
    expect(await getPeriod(cookie, '2026-08-29')).toMatchObject({ start: '2026-08-29', end: '2026-09-13', label: '29th–13th' });
    expect(await getPeriod(cookie, '2026-09-05')).toMatchObject({ start: '2026-08-29', end: '2026-09-13', label: '29th–13th' });
    expect(await getPeriod(cookie, '2026-09-13')).toMatchObject({ start: '2026-08-29', end: '2026-09-13', label: '29th–13th' });
  });

  test('summary exposes evidence status instead of inventing unavailable metrics', async () => {
    const cookie = await loginCookie();
    const r = await fetch(`${BASE}/api/technician-compensation/summary?date=2026-08-23`, { headers: { Cookie: cookie } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.period).toMatchObject({ start: '2026-08-14', end: '2026-08-28' });
    expect(Array.isArray(body.rows)).toBe(true);
    expect(body.note).toMatch(/verified|unavailable/i);
    for (const row of body.rows) {
      expect(row.evidence).toMatchObject({
        time_entries: 'verified', attendance: 'unavailable', overtime_hours: 'unavailable',
        qc_first_pass: 'unavailable', comeback_rework: 'unavailable', safety_events: 'unavailable',
      });
    }
  });
});
