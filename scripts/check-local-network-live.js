'use strict';

const http = require('http');
const https = require('https');

const base = String(process.env.POS_LAN_BASE_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
const username = String(process.env.POS_LAN_USERNAME || '').trim();
const password = String(process.env.POS_LAN_PASSWORD || '');
const timeoutMs = Number(process.env.POS_LAN_TIMEOUT_MS || 8000);

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(path, base + '/');
    const transport = target.protocol === 'https:' ? https : http;
    const body = options.body == null ? null : Buffer.from(JSON.stringify(options.body));
    const headers = { Accept: 'application/json,text/html;q=0.9,*/*;q=0.8', ...(options.headers || {}) };
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(body.length);
    }
    const req = transport.request(target, {
      method: options.method || 'GET',
      headers,
      timeout: timeoutMs,
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          text,
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`Request timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function cookieFrom(response) {
  const values = response.headers['set-cookie'];
  if (!Array.isArray(values) || !values.length) return '';
  return values.map(value => String(value).split(';')[0]).join('; ');
}

function json(response) {
  try { return JSON.parse(response.text || '{}'); }
  catch (_) { return {}; }
}

async function main() {
  console.log(`Checking Total Tools POS at ${base}`);

  const shell = await request('/');
  assert(shell.status === 200, `POS shell returned HTTP ${shell.status}`);
  assert(/Total Tools POS|Total Tools Operations|shell-root/i.test(shell.text), 'POS shell did not contain the expected native shell markers');
  console.log('PASS shell: native POS page is reachable');

  const runtime = await request('/pos-runtime.json');
  assert(runtime.status === 200, `Runtime manifest returned HTTP ${runtime.status}`);
  const manifest = json(runtime);
  assert(manifest.runtime === 'native-pos', 'Runtime manifest is not native-pos');
  assert(manifest.frontend === 'pos-owned', 'Runtime manifest frontend is not POS-owned');
  assert(manifest.server === 'pos-owned', 'Runtime manifest server is not POS-owned');
  console.log('PASS runtime: POS-owned frontend/server manifest is active');

  const anonProfile = await request('/api/workspace-profile/me');
  assert([401, 403].includes(anonProfile.status), `Unauthenticated workspace profile unexpectedly returned HTTP ${anonProfile.status}`);
  console.log('PASS auth boundary: anonymous workspace access is rejected');

  if (!username || !password) {
    console.log('SKIP login round-trip: set POS_LAN_USERNAME and POS_LAN_PASSWORD to certify a real employee session');
    console.log('LAN reachability certification passed.');
    return;
  }

  const login = await request('/api/employees/login', {
    method: 'POST',
    body: { username, password },
    headers: { Origin: base },
  });
  const loginData = json(login);
  assert(login.status === 200, `Login returned HTTP ${login.status}: ${loginData.error || login.text || 'unknown error'}`);

  const cookie = cookieFrom(login);
  assert(cookie.includes('pos_session='), 'Login succeeded but did not return a pos_session cookie');
  const setCookie = (login.headers['set-cookie'] || []).join('; ');
  if (base.startsWith('http://')) {
    assert(!/;\s*Secure(?:;|$)/i.test(setCookie), 'HTTP LAN login returned a Secure session cookie; browsers will drop this session on plain HTTP');
  }
  console.log('PASS login: credentials accepted and a browser-usable session cookie was issued');

  if (Number(loginData.must_change_password) === 1) {
    console.log('PASS forced-password state: login correctly requires a password change before normal workspace access');
    console.log('LAN authentication certification passed for a forced-password account.');
    return;
  }

  const profile = await request('/api/workspace-profile/me', { headers: { Cookie: cookie } });
  assert(profile.status === 200, `Authenticated workspace profile returned HTTP ${profile.status}: ${json(profile).error || profile.text || 'unknown error'}`);
  const profileData = json(profile);
  assert(profileData.employee && profileData.employee.id != null, 'Authenticated workspace profile did not return an employee');
  console.log(`PASS session: authenticated profile restored for ${profileData.employee.name || profileData.employee.username || profileData.employee.id}`);

  const logout = await request('/api/employees/logout', {
    method: 'POST',
    body: {},
    headers: { Cookie: cookie, Origin: base },
  });
  assert([200, 204].includes(logout.status), `Logout returned HTTP ${logout.status}`);
  console.log('PASS logout: session closed cleanly');

  const afterLogout = await request('/api/workspace-profile/me', { headers: { Cookie: cookie } });
  assert([401, 403].includes(afterLogout.status), `Revoked session still accessed workspace profile with HTTP ${afterLogout.status}`);
  console.log('PASS revocation: logged-out session cannot reopen the workspace');

  console.log('Full LAN authentication certification passed.');
}

main().catch(error => {
  console.error(`LAN certification failed: ${error.message}`);
  process.exitCode = 1;
});
