import { test, expect } from '@playwright/test';
import http from 'node:http';
import uploadSecurity from '../lib/uploadSecurity.js';

const { validateMemoryUpload, detectedType } = uploadSecurity;

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

function fakeFile(originalname, mimetype, buffer) {
  return { originalname, mimetype, buffer, size: buffer.length };
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

  test('image validation rejects MIME and extension spoofing', () => {
    const payload = Buffer.from('%PDF-1.7\nnot really a logo');
    const result = validateMemoryUpload(fakeFile('logo.png', 'image/png', payload), { kind: 'image' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unsupported image|does not match/i);
  });

  test('arbitrary ZIP archives renamed as Office evidence fail closed', () => {
    const fakeZip = Buffer.from([0x50,0x4b,0x03,0x04,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]);
    expect(detectedType(fakeZip)).toBe('zip');
    const result = validateMemoryUpload(fakeFile(
      'supplier-quote.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      fakeZip,
    ), { kind: 'evidence' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/office archive|malformed/i);
  });
});
