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

test.describe('WooCommerce credential governance',()=>{
  test('real woo credential names stay integration-only and masked on every administration read',async()=>{
    const admin=await login();expect(admin.status).toBe(200);
    const stamp=Date.now();
    const consumerKey=`ck_${String(stamp).padEnd(40,'a').slice(0,40)}`;
    const consumerSecret=`cs_${String(stamp).padEnd(40,'b').slice(0,40)}`;
    const wooUrl=`https://woo-${stamp}.example.invalid`;

    const saved=await api(admin.cookie,'PUT','/api/settings',{
      woo_url:wooUrl,
      woo_consumer_key:consumerKey,
      woo_consumer_secret:consumerSecret,
      woo_pos_url:`https://pos-${stamp}.example.invalid`,
      woo_sync_branch_id:String(admin.body?.default_branch_id||1),
      reason:'Configure WooCommerce credentials for security certification',
    });
    expect(saved.status,JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.changed_keys).toEqual(expect.arrayContaining(['woo_url','woo_consumer_key','woo_consumer_secret']));

    const adminSettings=await api(admin.cookie,'GET','/api/settings');
    expect(adminSettings.status).toBe(200);
    expect(adminSettings.body.woo_url).toBe(wooUrl);
    expect(adminSettings.body.woo_consumer_key).toBe('••••••••');
    expect(adminSettings.body.woo_consumer_secret).toBe('••••••••');

    const adminManage=await api(admin.cookie,'GET','/api/settings/manage');
    expect(adminManage.status).toBe(200);
    expect(adminManage.body.values.woo_consumer_key).toBe('••••••••');
    expect(adminManage.body.values.woo_consumer_secret).toBe('••••••••');
    expect(adminManage.body.secret_keys).toEqual(expect.arrayContaining(['woo_consumer_key','woo_consumer_secret']));

    const wcConfig=await api(admin.cookie,'GET','/api/woocommerce/config');
    expect(wcConfig.status).toBe(200);
    expect(wcConfig.body.woo_url).toBe(wooUrl);
    expect(wcConfig.body.woo_consumer_key).toBe('••••••••');
    expect(wcConfig.body.woo_consumer_secret).toBe('••••••••');
    expect(JSON.stringify(wcConfig.body)).not.toContain(consumerKey);
    expect(JSON.stringify(wcConfig.body)).not.toContain(consumerSecret);

    const group=await api(admin.cookie,'POST','/api/security-groups',{
      name:`Woo broad settings ${stamp}`,
      description:'Broad settings without integration authority',
      permissions:{settings:true},
      reason:'Certify WooCommerce secret isolation',
    });
    expect(group.status,JSON.stringify(group.body)).toBe(201);
    const restrictedPassword=`Woo-${stamp}-A9!`;
    const username=`woo_settings_${stamp}`;
    const employee=await api(admin.cookie,'POST','/api/employees',{
      first_name:'Woo',last_name:'Settings',username,
      pin:String(100000+(stamp%899999)).slice(0,6),password:restrictedPassword,
      security_group_id:group.body.id,default_branch_id:admin.body?.default_branch_id||1,
    });
    expect(employee.status,JSON.stringify(employee.body)).toBe(201);
    const restricted=await login(username,restrictedPassword);expect(restricted.status).toBe(200);

    const restrictedSettings=await api(restricted.cookie,'GET','/api/settings');
    expect(restrictedSettings.status).toBe(200);
    expect(restrictedSettings.body).not.toHaveProperty('woo_consumer_key');
    expect(restrictedSettings.body).not.toHaveProperty('woo_consumer_secret');
    expect(restrictedSettings.body).not.toHaveProperty('woo_url');

    const restrictedConfig=await api(restricted.cookie,'GET','/api/woocommerce/config');
    expect(restrictedConfig.status).toBe(403);
    expect(restrictedConfig.body.error).toMatch(/settings_integrations/i);
  });
});
