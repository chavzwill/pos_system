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
async function employeeFor(admin,stamp,label,permissions){
  const group=await api(admin.cookie,'POST','/api/security-groups',{
    name:`${label} ${stamp}`,description:'Runtime email authorization certification',permissions,
    reason:'Certify outbound document authorization',
  });
  expect(group.status,JSON.stringify(group.body)).toBe(201);
  const username=`${label.toLowerCase()}_${stamp}`;
  const password=`Email-${stamp}-${label}-A9!`;
  const employee=await api(admin.cookie,'POST','/api/employees',{
    first_name:'Email',last_name:label,username,pin:String(100000+((stamp+label.length)%899999)).slice(0,6),
    password,security_group_id:group.body.id,default_branch_id:admin.body?.default_branch_id||1,
  });
  expect(employee.status,JSON.stringify(employee.body)).toBe(201);
  const session=await login(username,password);expect(session.status).toBe(200);
  return {employee,session};
}

test.describe('Outbound document and SMTP authorization',()=>{
  test('authentication alone cannot disclose or transmit business documents',async()=>{
    const admin=await login();expect(admin.status).toBe(200);
    const stamp=Date.now();
    const basic=await employeeFor(admin,stamp,'Basic',{dashboard:true});
    const probes=[
      ['POST','/api/email/send-receipt/999999',{to:'nobody@example.invalid'},'transactions'],
      ['POST','/api/email/send-void-receipt/999999',{to:'nobody@example.invalid'},'transactions'],
      ['POST','/api/email/send-return-receipt/999999',{to:'nobody@example.invalid'},'transactions_returns'],
      ['POST','/api/email/send-cancellation-receipt/999999',{to:'nobody@example.invalid'},'rentals'],
      ['POST','/api/email/send-quote/999999',{to:'nobody@example.invalid'},'quotations'],
      ['POST','/api/email/send-grn/999999',{to:'nobody@example.invalid'},'purchasing_receive'],
      ['GET','/api/email/statement-preview/999999',undefined,'accounts'],
      ['POST','/api/email/send-statement/999999',{to:'nobody@example.invalid'},'accounts'],
      ['POST','/api/email/send-work-order-ready/999999',{to:'nobody@example.invalid'},'work_orders'],
    ];
    for(const [method,path,body,permission] of probes){
      const r=await api(basic.session.cookie,method,path,body);
      expect(r.status,`${method} ${path}: ${JSON.stringify(r.body)}`).toBe(403);
      expect(r.body.error).toContain(permission);
    }

    const broadSettings=await employeeFor(admin,stamp+1,'Settings',{settings:true});
    const smtp=await api(broadSettings.session.cookie,'POST','/api/email/test',{host:'smtp.example.invalid',port:587});
    expect(smtp.status).toBe(403);
    expect(smtp.body.error).toMatch(/settings_integrations/i);

    const audit=await api(admin.cookie,'GET','/api/security-groups/audit/recent');
    expect(audit.status).toBe(200);
    const basicDenials=audit.body.filter(x=>x.action==='permission_denied'&&Number(x.actor_employee_id)===Number(basic.employee.body.id));
    expect(basicDenials.length).toBeGreaterThanOrEqual(probes.length);
    const smtpDenial=audit.body.find(x=>x.action==='permission_denied'&&Number(x.actor_employee_id)===Number(broadSettings.employee.body.id)&&String(x.path||'').includes('/api/email/test'));
    expect(smtpDenial).toBeTruthy();
    expect(String(smtpDenial.new_value||'')).toContain('settings_integrations');
  });
});
