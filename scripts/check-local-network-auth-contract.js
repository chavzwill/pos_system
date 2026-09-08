'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const sessionAuth = fs.readFileSync(path.join(root, 'lib/sessionAuth.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const liveProbePath = path.join(root, 'scripts/check-local-network-live.js');
const liveProbe = fs.existsSync(liveProbePath) ? fs.readFileSync(liveProbePath, 'utf8') : '';

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
if (!liveProbe) {
  fail('live LAN certification probe is missing');
} else {
  if (!liveProbe.includes("POS_LAN_BASE_URL")) fail('live LAN probe must target an explicit LAN base URL');
  if (!liveProbe.includes("/pos-runtime.json")) fail('live LAN probe must verify the native runtime manifest');
  if (!liveProbe.includes("/api/employees/login")) fail('live LAN probe must exercise employee login when credentials are supplied');
  if (!liveProbe.includes("pos_session=")) fail('live LAN probe must verify that login returns a session cookie');
  if (!liveProbe.includes("/api/workspace-profile/me")) fail('live LAN probe must verify authenticated session restoration');
  if (!liveProbe.includes("/api/employees/logout")) fail('live LAN probe must verify logout and revocation');
  if (!liveProbe.includes("Secure session cookie")) fail('live LAN probe must guard against Secure cookies on HTTP LAN deployments');
}

if (!process.exitCode) {
  console.log('Local network auth contract passed. HTTP LAN login cookies remain usable, the native POS server can run independently of Vercel, and live LAN login certification is available.');
}
