import { test, expect } from '@playwright/test';
import http from 'node:http';

function rawRequest({ method = 'POST', path = '/api/employees/login', headers = {}, chunks = [] } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: 3001,
      method,
      path,
      headers,
    }, res => {
      const body = [];
      res.on('data', chunk => body.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(body).toString('utf8'),
      }));
    });
    req.on('error', reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

test.describe('POS request abuse hardening', () => {
  test('chunked JSON cannot bypass declared request-size enforcement', async () => {
    const response = await rawRequest({
      headers: {
        'Content-Type': 'application/json',
        'Transfer-Encoding': 'chunked',
      },
      chunks: ['{"username":"admin","password":"123456"}'],
    });
    expect(response.status).toBe(411);
    expect(response.body).toMatch(/content-length/i);
  });

  test('declared JSON larger than the two-megabyte ceiling is rejected before parsing', async () => {
    const response = await rawRequest({
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String((2 * 1024 * 1024) + 1),
      },
    });
    expect(response.status).toBe(413);
    expect(response.body).toMatch(/too large/i);
  });

  test('ordinary small JSON requests remain accepted by the request boundary', async () => {
    const payload = Buffer.from(JSON.stringify({ username: 'definitely-not-a-real-security-user', password: 'wrong' }));
    const response = await rawRequest({
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(payload.length),
      },
      chunks: [payload],
    });
    expect(response.status).toBe(401);
  });
});
