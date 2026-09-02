import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:3001';

async function login(username = process.env.POS_TEST_USER || 'admin', password = process.env.POS_TEST_PASSWORD || '123456') {
  const r = await fetch(`${BASE}/api/employees/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  expect(r.status).toBe(200);
  return { cookie: (r.headers.get('set-cookie') || '').split(';')[0], body: await r.json() };
}

async function api(cookie, path, options = {}) {
  const headers = { Cookie: cookie, Accept: 'application/json', ...(options.headers || {}) };
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${BASE}${path}`, { ...options, headers });
  return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
}

async function makeEmployee(adminCookie, permissions = { pos: true }, label = 'Restricted') {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const group = await api(adminCookie, '/api/security-groups', {
    method: 'POST',
    body: JSON.stringify({
      name: `Security Runtime ${label} ${suffix}`,
      description: 'Temporary adversarial security fixture',
      reason: 'Security hardening runtime certification',
      permissions,
    }),
  });
  expect(group.status).toBe(201);

  const branches = await api(adminCookie, '/api/branches');
  expect(branches.status).toBe(200);
  const branch = branches.body.find(b => b.active !== 0) || branches.body[0];
  expect(branch).toBeTruthy();

  const username = `sec_${suffix.replace(/[^a-z0-9]/gi, '').slice(-16)}`;
  const password = `Sec!${suffix}Aa9`;
  const replacement = `New!${suffix}Bb8`;
  const pin = String(Date.now()).slice(-6);
  const employee = await api(adminCookie, '/api/employees', {
    method: 'POST',
    body: JSON.stringify({
      first_name: 'Security', last_name: label, username, password, pin,
      security_group_id: group.body.id, default_branch_id: branch.id, must_change_password: false,
    }),
  });
  expect(employee.status).toBe(201);
  return { group: group.body, employee: employee.body, username, password, replacement, pin };
}

async function makeRestrictedEmployee(adminCookie) {
  return makeEmployee(adminCookie, { pos: true }, 'Restricted');
}

async function cleanup(adminCookie, fixture) {
  if (!fixture) return;
  await api(adminCookie, `/api/employees/${fixture.employee.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      first_name: fixture.employee.first_name,
      last_name: fixture.employee.last_name,
      username: fixture.username,
      active: 0,
      security_group_id: fixture.group.id,
      default_branch_id: fixture.employee.default_branch_id,
      must_change_password: false,
    }),
  });
  await api(adminCookie, `/api/security-groups/${fixture.group.id}?reason=Security%20runtime%20cleanup`, { method: 'DELETE' });
}

test.describe('POS security hardening', () => {
  test('HTTP shell emits security headers and request correlation ID', async () => {
    const r = await fetch(`${BASE}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect(r.headers.get('x-request-id')).toBeTruthy();
    expect(r.headers.get('x-powered-by')).toBeNull();
  });

  test('cross-site cookie mutation is rejected before business logic', async () => {
    const auth = await login();
    const r = await fetch(`${BASE}/api/transactions`, {
      method: 'POST',
      headers: {
        Cookie: auth.cookie,
        'Content-Type': 'application/json',
        Origin: 'https://attacker.invalid',
        'Sec-Fetch-Site': 'cross-site',
      },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toMatch(/cross-site|cross-origin/i);
  });

  test('restricted employee cannot reset another employee password and own reset revokes its session', async () => {
    const admin = await login();
    let fixture = null;
    try {
      fixture = await makeRestrictedEmployee(admin.cookie);
      const restricted = await login(fixture.username, fixture.password);

      const escalation = await api(restricted.cookie, `/api/employees/${admin.body.id}/change-password`, {
        method: 'PUT',
        body: JSON.stringify({ password: 'DoNotApply!123' }),
      });
      expect(escalation.status).toBe(403);

      const missingCurrentPassword = await api(restricted.cookie, `/api/employees/${fixture.employee.id}/change-password`, {
        method: 'PUT',
        body: JSON.stringify({ password: fixture.replacement }),
      });
      expect(missingCurrentPassword.status).toBe(403);
      expect(missingCurrentPassword.body?.error).toMatch(/current password/i);

      const selfChange = await api(restricted.cookie, `/api/employees/${fixture.employee.id}/change-password`, {
        method: 'PUT',
        body: JSON.stringify({ password: fixture.replacement, current_password: fixture.password }),
      });
      expect(selfChange.status).toBe(200);
      expect(selfChange.body?.reauthentication_required).toBe(true);

      const staleSession = await api(restricted.cookie, '/api/workspace-profile/me');
      expect(staleSession.status).toBe(401);

      const oldLogin = await fetch(`${BASE}/api/employees/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: fixture.username, password: fixture.password }),
      });
      expect(oldLogin.status).toBe(401);
      const newLogin = await login(fixture.username, fixture.replacement);
      expect(newLogin.body.id).toBe(fixture.employee.id);
    } finally {
      await cleanup(admin.cookie, fixture);
    }
  });

  test('staff manager cannot promote itself to a security group with stronger authority', async () => {
    const admin = await login();
    let fixture = null;
    try {
      fixture = await makeEmployee(admin.cookie, { pos: true, employees: true }, 'StaffManager');
      const manager = await login(fixture.username, fixture.password);
      const groups = await api(manager.cookie, '/api/security-groups');
      expect(groups.status).toBe(200);
      const adminGroup = groups.body.find(g => /administrator/i.test(g.name));
      expect(adminGroup).toBeTruthy();

      const promote = await api(manager.cookie, `/api/employees/${fixture.employee.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          first_name: fixture.employee.first_name,
          last_name: fixture.employee.last_name,
          username: fixture.username,
          active: 1,
          security_group_id: adminGroup.id,
          default_branch_id: fixture.employee.default_branch_id,
          must_change_password: false,
        }),
      });
      expect(promote.status).toBe(403);
      expect(promote.body?.error).toMatch(/authority|security group/i);

      const changeAdminPassword = await api(manager.cookie, `/api/employees/${admin.body.id}/change-password`, {
        method: 'PUT', body: JSON.stringify({ password: 'ShouldNotApply!123' }),
      });
      expect(changeAdminPassword.status).toBe(403);
    } finally {
      await cleanup(admin.cookie, fixture);
    }
  });

  test('repeated bad login attempts are throttled', async () => {
    const username = `__rate_limit_${Date.now()}__`;
    let last = null;
    for (let i = 0; i < 11; i += 1) {
      last = await fetch(`${BASE}/api/employees/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: `wrong-${i}` }),
      });
    }
    expect(last.status).toBe(429);
    expect(last.headers.get('retry-after')).toBeTruthy();
  });

  test('repeated invalid privileged PIN attempts are throttled', async () => {
    const auth = await login();
    let last = null;
    for (let i = 0; i < 9; i += 1) {
      last = await fetch(`${BASE}/api/employees/validate-pin`, {
        method: 'POST',
        headers: { Cookie: auth.cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: `99${String(i).padStart(4, '0')}`, permission: 'reports_financial' }),
      });
    }
    expect(last.status).toBe(429);
    expect(last.headers.get('retry-after')).toBeTruthy();
  });

  test('invalid integration API-key probing is throttled', async () => {
    let last = null;
    for (let i = 0; i < 21; i += 1) {
      last = await fetch(`${BASE}/api/products`, { headers: { 'X-API-Key': `pos_invalid_security_probe_${String(i).padStart(3, '0')}` } });
    }
    expect(last.status).toBe(429);
    expect(last.headers.get('retry-after')).toBeTruthy();
  });

  test('identity, signature and procurement evidence are not bearer-accessible static files', async () => {
    const protectedPaths = [
      '/uploads/customer-ids/security-probe.png',
      '/uploads/rental-signatures/security-probe.png',
      '/uploads/rental-po-attachments/security-probe.pdf',
      '/uploads/po-attachments/security-probe.pdf',
    ];
    for (const path of protectedPaths) {
      const anonymous = await fetch(`${BASE}${path}`);
      expect(anonymous.status, `${path} must require authentication`).toBe(401);
      expect(anonymous.headers.get('cache-control') || '').toMatch(/no-store/);
    }

    const admin = await login();
    let fixture = null;
    try {
      fixture = await makeRestrictedEmployee(admin.cookie);
      const restricted = await login(fixture.username, fixture.password);
      const denied = await fetch(`${BASE}/uploads/customer-ids/security-probe.png`, {
        headers: { Cookie: restricted.cookie },
      });
      expect(denied.status).toBe(403);

      const authorizedMissing = await fetch(`${BASE}/uploads/customer-ids/security-probe.png`, {
        headers: { Cookie: admin.cookie },
      });
      expect(authorizedMissing.status).toBe(404);
      expect(authorizedMissing.headers.get('cache-control') || '').toMatch(/no-store/);
    } finally {
      await cleanup(admin.cookie, fixture);
    }
  });

  test('sensitive customer writes and identity uploads require explicit authority and real image bytes', async () => {
    const admin = await login();
    let fixture = null;
    let customer = null;
    try {
      fixture = await makeEmployee(admin.cookie, { pos: true, customers: true, customers_edit: true }, 'CustomerEditor');
      customer = await api(admin.cookie, '/api/customers', {
        method: 'POST',
        body: JSON.stringify({ first_name:'Upload', last_name:`Security${Date.now()}`, customer_type:'cash' }),
      });
      expect(customer.status).toBe(201);
      const staff = await login(fixture.username, fixture.password);
      const sensitiveEdit = await api(staff.cookie, `/api/customers/${customer.body.id}`, {
        method:'PUT',
        body:JSON.stringify({
          first_name:'Upload',last_name:'Security',customer_type:'cash',
          rental_id_number:'SHOULD-NOT-WRITE',rental_reference_name:'Should Not Write',
        }),
      });
      expect(sensitiveEdit.status).toBe(403);
      expect(sensitiveEdit.body?.error).toMatch(/customers_sensitive/i);

      const deniedForm=new FormData();
      deniedForm.append('id_scan',new Blob([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])],{type:'image/png'}),'id.png');
      const deniedUpload=await fetch(`${BASE}/api/customers/${customer.body.id}/id-scan`,{method:'POST',headers:{Cookie:staff.cookie},body:deniedForm});
      expect(deniedUpload.status).toBe(403);

      const spoofed=new FormData();
      spoofed.append('id_scan',new Blob([Buffer.from('<script>alert(1)</script>')],{type:'image/png'}),'fake.png');
      const spoofedUpload=await fetch(`${BASE}/api/customers/${customer.body.id}/id-scan`,{method:'POST',headers:{Cookie:admin.cookie},body:spoofed});
      expect(spoofedUpload.status).toBe(415);
    } finally {
      if(customer?.body?.id)await api(admin.cookie,`/api/customers/${customer.body.id}`,{method:'DELETE'});
      await cleanup(admin.cookie,fixture);
    }
  });

  test('ordinary staff and integration keys receive minimized customer identity data', async () => {
    const admin = await login();
    let fixture = null;
    let customer = null;
    let apiKeyId = null;
    try {
      fixture = await makeEmployee(admin.cookie, { pos: true, customers: true }, 'CustomerLookup');
      customer = await api(admin.cookie, '/api/customers', {
        method: 'POST',
        body: JSON.stringify({
          first_name: 'Sensitive', last_name: `Customer${Date.now()}`,
          phone: `876555${String(Date.now()).slice(-4)}`,
          customer_type: 'cash',
          is_rental_customer: true,
          rental_id_type: 'drivers_license',
          rental_id_number: 'SECURITY-ID-12345',
          rental_address_proof_type: 'utility_bill',
          rental_address_proof_details: 'Private address proof reference',
          rental_reference_name: 'Private Reference',
          rental_reference_phone: '8765559999',
          rental_reference_relationship: 'Employer',
        }),
      });
      expect(customer.status).toBe(201);

      const staff = await login(fixture.username, fixture.password);
      const detail = await api(staff.cookie, `/api/customers/${customer.body.id}`);
      expect(detail.status).toBe(200);
      expect(detail.headers.get('x-customer-data-scope')).toBe('minimized');
      expect(detail.body.rental_id_number).toBeUndefined();
      expect(detail.body.rental_id_scan_path).toBeUndefined();
      expect(detail.body.rental_address_proof_details).toBeUndefined();
      expect(detail.body.rental_reference_name).toBeUndefined();
      expect(detail.body.rental_reference_phone).toBeUndefined();

      const adminDetail = await api(admin.cookie, `/api/customers/${customer.body.id}`);
      expect(adminDetail.status).toBe(200);
      expect(adminDetail.body.rental_id_number).toBe('SECURITY-ID-12345');

      const createdKey=await api(admin.cookie,'/api/api-keys',{
        method:'POST',body:JSON.stringify({name:`Security customer read ${Date.now()}`,scopes:['customers:read']})
      });
      expect(createdKey.status).toBe(201);
      const keyList=await api(admin.cookie,'/api/api-keys');
      const keyRow=keyList.body.find(row=>row.key_prefix===createdKey.body.prefix);
      expect(keyRow).toBeTruthy();
      apiKeyId=keyRow.id;
      const integration=await fetch(`${BASE}/api/customers/${customer.body.id}`,{headers:{'X-API-Key':createdKey.body.key}});
      expect(integration.status).toBe(200);
      expect(integration.headers.get('x-customer-data-scope')).toBe('minimized');
      const integrationBody=await integration.json();
      expect(integrationBody.rental_id_number).toBeUndefined();
      expect(integrationBody.rental_reference_phone).toBeUndefined();
    } finally {
      if(apiKeyId)await api(admin.cookie,`/api/api-keys/${apiKeyId}`,{method:'DELETE'});
      if (customer?.body?.id) await api(admin.cookie, `/api/customers/${customer.body.id}`, { method: 'DELETE' });
      await cleanup(admin.cookie, fixture);
    }
  });
});
