import { test, expect } from '@playwright/test';

const BASE='http://localhost:3001';
const ADMIN_USER=process.env.POS_TEST_USER||'admin';
const ADMIN_PASSWORD=process.env.POS_TEST_PASSWORD||'CI-Test-Auth!2026';

async function login(username=ADMIN_USER,password=ADMIN_PASSWORD){
  const r=await fetch(`${BASE}/api/employees/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
  return {status:r.status,body:await r.json().catch(()=>null),cookie:(r.headers.get('set-cookie')||'').split(';')[0]};
}
async function api(cookie,method,path,body){
  const r=await fetch(`${BASE}${path}`,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:r.status,body:await r.json().catch(()=>null)};
}

test.describe('Settings and integration-secret governance',()=>{
  test('broad settings authority cannot inherit integration secrets and audited secret changes stay redacted',async()=>{
    const admin=await login();expect(admin.status).toBe(200);
    const stamp=Date.now();
    const restrictedUser=`settings_${stamp}`;
    const restrictedPassword=`Settings-${stamp}-A9!`;
    const secret=`SMTP-${stamp}-Secret!`;
    const host=`smtp-${stamp}.example.invalid`;
    const originalFooter=`Footer-before-${stamp}`;
    const attemptedFooter=`Footer-should-not-apply-${stamp}`;

    const group=await api(admin.cookie,'POST','/api/security-groups',{
      name:`Settings Managers ${stamp}`,
      description:'Runtime settings boundary certification',
      permissions:{settings:true},
      reason:'Certify settings integration boundary',
    });
    expect(group.status,JSON.stringify(group.body)).toBe(201);

    const employee=await api(admin.cookie,'POST','/api/employees',{
      first_name:'Settings',last_name:'Manager',username:restrictedUser,pin:String(100000+(stamp%899999)).slice(0,6),
      password:restrictedPassword,security_group_id:group.body.id,default_branch_id:admin.body?.default_branch_id||1,
    });
    expect(employee.status,JSON.stringify(employee.body)).toBe(201);

    const seeded=await api(admin.cookie,'PUT','/api/settings',{
      receipt_footer:originalFooter,
      email_smtp_host:host,
      email_smtp_pass:secret,
      reason:'Rotate SMTP settings for runtime certification',
    });
    expect(seeded.status,JSON.stringify(seeded.body)).toBe(200);
    expect(seeded.body.changed_keys).toEqual(expect.arrayContaining(['receipt_footer','email_smtp_host','email_smtp_pass']));

    const adminManage=await api(admin.cookie,'GET','/api/settings/manage');
    expect(adminManage.status).toBe(200);
    expect(adminManage.body.integration_authority).toBe(true);
    expect(adminManage.body.values.email_smtp_host).toBe(host);
    expect(adminManage.body.values.email_smtp_pass).toBe('••••••••');

    const restricted=await login(restrictedUser,restrictedPassword);expect(restricted.status).toBe(200);
    const restrictedManage=await api(restricted.cookie,'GET','/api/settings/manage');
    expect(restrictedManage.status).toBe(200);
    expect(restrictedManage.body.integration_authority).toBe(false);
    expect(restrictedManage.body.values.receipt_footer).toBe(originalFooter);
    expect(restrictedManage.body.values).not.toHaveProperty('email_smtp_host');
    expect(restrictedManage.body.values).not.toHaveProperty('email_smtp_pass');
    expect(restrictedManage.body.secret_keys).toEqual([]);

    const restrictedGeneral=await api(restricted.cookie,'GET','/api/settings');
    expect(restrictedGeneral.status).toBe(200);
    expect(restrictedGeneral.body).not.toHaveProperty('email_smtp_host');
    expect(restrictedGeneral.body).not.toHaveProperty('email_smtp_pass');

    const missingReason=await api(admin.cookie,'PUT','/api/settings',{email_smtp_host:`changed-${host}`});
    expect(missingReason.status).toBe(400);
    expect(missingReason.body.error).toMatch(/reason/i);

    const rejectedMixed=await api(restricted.cookie,'PUT','/api/settings',{
      receipt_footer:attemptedFooter,
      email_smtp_host:`attacker-${host}`,
      reason:'Attempt unauthorized integration mutation',
    });
    expect(rejectedMixed.status).toBe(403);
    expect(rejectedMixed.body.error).toMatch(/integration/i);

    const afterReject=await api(restricted.cookie,'GET','/api/settings/manage');
    expect(afterReject.status).toBe(200);
    expect(afterReject.body.values.receipt_footer).toBe(originalFooter);

    const ordinaryUpdate=await api(restricted.cookie,'PUT','/api/settings',{receipt_footer:`Footer-after-${stamp}`});
    expect(ordinaryUpdate.status).toBe(200);
    expect(ordinaryUpdate.body.changed_keys).toContain('receipt_footer');

    const audit=await api(admin.cookie,'GET','/api/security-groups/audit/recent');
    expect(audit.status).toBe(200);
    const integrationAudit=audit.body.find(x=>x.action==='integration_settings_updated');
    expect(integrationAudit).toBeTruthy();
    const serialized=JSON.stringify(integrationAudit);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(host);
    expect(serialized).toContain('email_smtp_pass');
    expect(serialized).toContain('email_smtp_host');

    const broadSettingsOnly=group.body.permissions||{};
    expect(broadSettingsOnly.settings).toBe(true);
    expect(broadSettingsOnly.settings_integrations).not.toBe(true);
  });
});
