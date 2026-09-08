'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const sessionAuth = fs.readFileSync(path.join(root, 'lib/sessionAuth.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

function fail(message) {
  console.error(`Local network auth contract failed: ${message}`);
  process.exitCode = 1;
}

if (!sessionAuth.includes("process.env.POS_COOKIE_SECURE || 'auto'")) {
  fail('session cookies must default to transport-aware POS_COOKIE_SECURE=auto');
}
if (!sessionAuth.includes('return Boolean(req?.secure)')) {
  fail('auto cookie security must follow the actual request transport');
}
if (sessionAuth.includes("process.env.NODE_ENV === 'production' ? '; Secure' : ''")) {
  fail('NODE_ENV must not force Secure cookies on plain HTTP LAN terminals');
}
if (!sessionAuth.includes('clearSessionCookie(res, req)')) {
  fail('session cleanup must use the same request-aware cookie policy');
}
if (!server.includes('app.listen(PORT')) {
  fail('native POS server listener is missing');
}
if (!server.includes("if (!process.env.VERCEL)")) {
  fail('native server must remain independently runnable outside Vercel');
}

if (!process.exitCode) {
  console.log('Local network auth contract passed. HTTP LAN login cookies remain usable and the native POS server can run independently of Vercel.');
}
