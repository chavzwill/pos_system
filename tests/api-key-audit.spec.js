import { test, expect } from '@playwright/test';
import './pos-financial-runtime.js';
import './security-hardening-runtime.js';

const BASE = 'http://localhost:3001';

async function login(username = process.env.POS_TEST_USER || 'admin', password = process.env.POS_TEST_PASSWORD || '123456') {
  const response = await fetch(`${BASE}/api/employees/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  expect(response.status).toBe(200);
  return (response.headers.get('set-cookie') || '').split(';')[0];
}

async function sessionApi(cookie, path, options = {}) {
  const headers = { Cookie: cookie, Accept: 'application/json', ...(options.headers || {}) };
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${BASE}${path}`, { ...options, headers });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function keyApi(key, path, options = {}) {
  const headers = { 'X-API-Key': key, Accept: 'application/json', ...(options.headers || {}) };
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${BASE}${path}`, { ...options, headers });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function recentAudit(cookie) {
  const result = await sessionApi(cookie, '/api/security-groups/audit/recent');
  expect(result.status).toBe(200);
  return result.body;
}

function parsedNewValue(row) {
  try { return JSON.parse(row?.new_value || '{}'); } catch (_) { return {}; }
}

test.describe('Known API key denial audit trail', () => {
  test('audits known-key policy denials without persisting random invalid-key probes', async () => {
    const adminCookie = await login();
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const name = `Runtime API denial ${suffix}`;

    let keyId = null;
    let rawKey = null;
    try {
      const created = await sessionApi(adminCookie, '/api/api-keys', {
        method: 'POST',
        body: JSON.stringify({ name, scopes: ['products:read'] }),
      });
      expect(created.status).toBe(201);
      rawKey = created.body?.key;
      expect(rawKey).toMatch(/^pos_/);

      const keys = await sessionApi(adminCookie, '/api/api-keys');
      expect(keys.status).toBe(200);
      const keyRow = keys.body.find(row => row.name === name && row.key_prefix === created.body.prefix);
      expect(keyRow).toBeTruthy();
      keyId = Number(keyRow.id);

      const employeeEndpoint = await keyApi(rawKey, '/api/workspace-profile/me');
      expect(employeeEndpoint.status).toBe(403);
      expect(employeeEndpoint.body?.error).toMatch(/not permitted/i);

      let audit = await recentAudit(adminCookie);
      const endpointDenial = audit.find(row => row.action === 'api_key_denied'
        && Number(row.target_id) === keyId
        && row.path === '/api/workspace-profile/me'
        && row.control === 'api_key_endpoint_policy');
      expect(endpointDenial).toBeTruthy();
      expect(endpointDenial.method).toBe('GET');
      expect(parsedNewValue(endpointDenial).required_scope).toBeNull();
      expect(parsedNewValue(endpointDenial).api_key_name).toBe(name);
      expect(String(endpointDenial.old_value || '')).not.toContain(rawKey);
      expect(String(endpointDenial.new_value || '')).not.toContain(rawKey);
      expect(String(endpointDenial.reason || '')).not.toContain(rawKey);

      const scopeDenied = await keyApi(rawKey, '/api/products', {
        method: 'POST',
        body: JSON.stringify({ name: `Denied product ${suffix}` }),
      });
      expect(scopeDenied.status).toBe(403);
      expect(scopeDenied.body?.error).toMatch(/products:write/i);

      audit = await recentAudit(adminCookie);
      const scopeDenial = audit.find(row => row.action === 'api_key_denied'
        && Number(row.target_id) === keyId
        && row.path === '/api/products'
        && row.control === 'api_key_scope');
      expect(scopeDenial).toBeTruthy();
      expect(scopeDenial.method).toBe('POST');
      expect(parsedNewValue(scopeDenial).required_scope).toBe('products:write');
      expect(String(scopeDenial.new_value || '')).not.toContain(rawKey);

      const beforeRandom = audit.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0);
      const randomProbe = `pos_${'f'.repeat(40)}`;
      expect(randomProbe).not.toBe(rawKey);
      const invalid = await keyApi(randomProbe, '/api/workspace-profile/me');
      // Unknown credentials are always rejected. A shared invalid-key abuse bucket
      // may already be exhausted by an earlier adversarial test in the same server
      // process, in which case 429 is the correct fail-closed response.
      expect([401, 429]).toContain(invalid.status);

      const afterRandomRows = await recentAudit(adminCookie);
      const newApiKeyAuditRows = afterRandomRows.filter(row => Number(row.id) > beforeRandom && row.action === 'api_key_denied');
      expect(newApiKeyAuditRows).toHaveLength(0);
    } finally {
      if (keyId) {
        const revoked = await sessionApi(adminCookie, `/api/api-keys/${keyId}`, { method: 'DELETE' });
        expect(revoked.status).toBe(200);
      }
    }
  });
});
