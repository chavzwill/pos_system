import { test, expect } from '@playwright/test';
import { TEST_BASE_URL as BASE, assertSafeMutationTarget } from './test-base-url.js';

async function login() {
  const username = process.env.POS_TEST_USER;
  const password = process.env.POS_TEST_PASSWORD;
  if (!username || !password) throw new Error('POS_TEST_USER and POS_TEST_PASSWORD are required');
  const r = await fetch(`${BASE}/api/employees/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  expect(r.status).toBe(200);
  return (r.headers.get('set-cookie') || '').split(';')[0];
}

async function api(cookie, method, path, body, key) {
  const headers = { Cookie: cookie, Accept: 'application/json', 'Content-Type': 'application/json' };
  if (key) headers['Idempotency-Key'] = key;
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: r.status,
    replayed: r.headers.get('Idempotency-Replayed'),
    idempotencyKey: r.headers.get('Idempotency-Key'),
    body: await r.json().catch(() => null),
  };
}

assertSafeMutationTarget();

test.describe('Durable POS mutation idempotency', () => {
  test('same authenticated mutation and key replays and exposes its authoritative reconciliation receipt', async () => {
    const cookie = await login();
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const key = `idem-security-group-${stamp}`;
    const payload = {
      name: `Idempotency Probe ${stamp}`,
      description: 'Temporary durable retry certification group',
      reason: 'Operation idempotency runtime certification',
      permissions: { dashboard: true },
    };

    const first = await api(cookie, 'POST', '/api/security-groups', payload, key);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.replayed).toBe('false');
    expect(first.body?.id).toBeTruthy();

    const second = await api(cookie, 'POST', '/api/security-groups', payload, key);
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(second.replayed).toBe('true');
    expect(second.body?.id).toBe(first.body.id);

    const changed = await api(cookie, 'POST', '/api/security-groups', { ...payload, description: 'Different payload' }, key);
    expect(changed.status).toBe(409);
    expect(changed.body?.control).toBe('operation_idempotency');

    const receipt = await api(cookie, 'GET', `/api/operation-idempotency/${encodeURIComponent(key)}`);
    expect(receipt.status).toBe(200);
    const completed = receipt.body?.find(row => row.state === 'completed' && row.response_status === 201);
    expect(completed).toBeTruthy();
    expect(completed.reconciliation_state).toBe('completed');
    expect(completed.method).toBe('POST');
    expect(completed.path).toBe('/security-groups');
    expect(completed.response?.id).toBe(first.body.id);

    const cleanupKey = `idem-security-group-cleanup-${stamp}`;
    const cleanupPath = `/api/security-groups/${first.body.id}?reason=Operation%20idempotency%20certification%20cleanup`;
    const cleanup = await api(cookie, 'DELETE', cleanupPath, undefined, cleanupKey);
    expect([200, 204]).toContain(cleanup.status);

    const cleanupReplay = await api(cookie, 'DELETE', cleanupPath, undefined, cleanupKey);
    expect(cleanupReplay.status).toBe(cleanup.status);
    expect(cleanupReplay.replayed).toBe('true');

    const cleanupReceipt = await api(cookie, 'GET', `/api/operation-idempotency/${encodeURIComponent(cleanupKey)}`);
    expect(cleanupReceipt.status).toBe(200);
    const cleanupCompleted = cleanupReceipt.body?.find(row => row.state === 'completed');
    expect(cleanupCompleted?.reconciliation_state).toBe('completed');
    expect(cleanupCompleted?.response_status).toBe(cleanup.status);
  });
});
