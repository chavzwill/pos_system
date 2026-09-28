const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

test('opportunity reads use the read-only upstream and preserve the POS response shape', async () => {
  const calls = [];
  const upstream = http.createServer((req, res) => {
    calls.push({ method: req.method, url: req.url });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify([{ id: 42 }]));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  process.env.SPENDOS_INGEST_URL = `http://127.0.0.1:${upstream.address().port}/v1/events`;
  process.env.SPENDOS_TENANT_ID = 'test-tenant';
  const app = express();
  app.use((req, res, next) => {
    if (req.headers['x-test-finance']) req.employee = { id: 1, permissions: { reports_financial: true } };
    next();
  });
  app.use(require('../routes/spendos-management'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/opportunities`;
    assert.equal((await fetch(url)).status, 401);
    assert.equal(calls.length, 0);
    const response = await fetch(url, { headers: { 'x-test-finance': '1' } });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [{ method: 'GET', url: '/v1/savings/opportunities?tenantId=test-tenant' }]);
    assert.deepEqual(await response.json(), { opportunities: [{ id: 42 }] });
  } finally {
    await Promise.all([new Promise(r => server.close(r)), new Promise(r => upstream.close(r))]);
  }
});
