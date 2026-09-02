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

test.describe('Accounting financial authority isolation',()=>{
  test('ordinary reports authority cannot inspect financial intelligence or create ledger postings',async()=>{
    const admin=await login();expect(admin.status).toBe(200);
    const stamp=Date.now();
    const group=await api(admin.cookie,'POST','/api/security-groups',{
      name:`Read-only Reports ${stamp}`,
      description:'Runtime financial authorization certification',
      permissions:{reports:true},
      reason:'Certify accounting financial authority',
    });
    expect(group.status,JSON.stringify(group.body)).toBe(201);

    const username=`reports_only_${stamp}`;
    const password=`Reports-${stamp}-A9!`;
    const employee=await api(admin.cookie,'POST','/api/employees',{
      first_name:'Reports',last_name:'Reader',username,
      pin:String(100000+(stamp%899999)).slice(0,6),password,
      security_group_id:group.body.id,default_branch_id:admin.body?.default_branch_id||1,
    });
    expect(employee.status,JSON.stringify(employee.body)).toBe(201);
    const restricted=await login(username,password);expect(restricted.status).toBe(200);

    const intelligence=await api(restricted.cookie,'GET','/api/accounting-intelligence/overview');
    expect(intelligence.status).toBe(403);
    expect(intelligence.body.error).toMatch(/reports_financial/i);

    const posting=await api(restricted.cookie,'POST','/api/accounting-source-sync/sync',{});
    expect(posting.status).toBe(403);
    expect(posting.body.error).toMatch(/reports_financial/i);

    const audit=await api(admin.cookie,'GET','/api/security-groups/audit/recent');
    expect(audit.status).toBe(200);
    const denials=audit.body.filter(x=>x.action==='permission_denied'&&Number(x.actor_employee_id)===Number(employee.body.id));
    expect(denials.some(x=>String(x.path||'').includes('/api/accounting-intelligence/overview')&&String(x.new_value||'').includes('reports_financial'))).toBe(true);
    expect(denials.some(x=>String(x.path||'').includes('/api/accounting-source-sync/sync')&&String(x.new_value||'').includes('reports_financial'))).toBe(true);
  });
});
