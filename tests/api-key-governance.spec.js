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
async function keyRequest(raw,path='/api/products'){
  const r=await fetch(`${BASE}${path}`,{headers:{'X-API-Key':raw}});
  return {status:r.status,body:await r.json().catch(()=>null)};
}

test.describe('API key credential lifecycle governance',()=>{
  test('creation, rotation and terminal revocation are explicit, audited, and invalidate old credentials',async()=>{
    const admin=await login();expect(admin.status).toBe(200);
    const stamp=Date.now();

    const missingReason=await api(admin.cookie,'POST','/api/api-keys',{name:`No reason ${stamp}`,scopes:['products:read']});
    expect(missingReason.status).toBe(400);
    expect(missingReason.body.error).toMatch(/reason/i);

    const group=await api(admin.cookie,'POST','/api/security-groups',{
      name:`Broad settings only ${stamp}`,
      description:'Runtime API credential boundary certification',
      permissions:{settings:true},
      reason:'Certify API key explicit authority',
    });
    expect(group.status,JSON.stringify(group.body)).toBe(201);
    const restrictedPassword=`ApiKey-${stamp}-A9!`;
    const employee=await api(admin.cookie,'POST','/api/employees',{
      first_name:'Broad',last_name:'Settings',username:`api_settings_${stamp}`,
      pin:String(100000+(stamp%899999)).slice(0,6),password:restrictedPassword,
      security_group_id:group.body.id,default_branch_id:admin.body?.default_branch_id||1,
    });
    expect(employee.status,JSON.stringify(employee.body)).toBe(201);
    const restricted=await login(`api_settings_${stamp}`,restrictedPassword);expect(restricted.status).toBe(200);
    const denied=await api(restricted.cookie,'GET','/api/api-keys');
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatch(/settings_integrations/i);

    const created=await api(admin.cookie,'POST','/api/api-keys',{
      name:`Governed key ${stamp}`,scopes:['products:read'],reason:'Create governed runtime API credential',
    });
    expect(created.status,JSON.stringify(created.body)).toBe(201);
    expect(created.body.key).toMatch(/^pos_[a-f0-9]{40}$/);
    const id=created.body.id,oldRaw=created.body.key,oldPrefix=created.body.prefix;

    const oldWorks=await keyRequest(oldRaw);
    expect(oldWorks.status).toBe(200);

    const badBoolean=await api(admin.cookie,'PATCH',`/api/api-keys/${id}`,{is_active:'false',reason:'Reject string boolean coercion attempt'});
    expect(badBoolean.status).toBe(400);
    expect(badBoolean.body.error).toMatch(/boolean/i);
    expect((await keyRequest(oldRaw)).status).toBe(200);

    const rotated=await api(admin.cookie,'POST',`/api/api-keys/${id}/rotate`,{reason:'Rotate runtime credential after certification'});
    expect(rotated.status,JSON.stringify(rotated.body)).toBe(200);
    expect(rotated.body.key).toMatch(/^pos_[a-f0-9]{40}$/);
    expect(rotated.body.key).not.toBe(oldRaw);
    expect(rotated.body.prefix).not.toBe(oldPrefix);
    const newRaw=rotated.body.key;

    const oldRejected=await keyRequest(oldRaw);
    expect(oldRejected.status).toBe(401);
    const newWorks=await keyRequest(newRaw);
    expect(newWorks.status).toBe(200);

    const revoked=await api(admin.cookie,'PATCH',`/api/api-keys/${id}`,{is_active:false,reason:'Revoke runtime credential after rotation test'});
    expect(revoked.status,JSON.stringify(revoked.body)).toBe(200);
    expect(revoked.body.changed).toBe(true);
    const revokedRejected=await keyRequest(newRaw);
    expect(revokedRejected.status).toBe(401);

    const reactivate=await api(admin.cookie,'PATCH',`/api/api-keys/${id}`,{is_active:true,reason:'Attempt to reactivate revoked credential'});
    expect(reactivate.status).toBe(409);
    expect(reactivate.body.error).toMatch(/reactivation|new credential/i);
    expect((await keyRequest(newRaw)).status).toBe(401);

    const rotateRevoked=await api(admin.cookie,'POST',`/api/api-keys/${id}/rotate`,{reason:'Attempt rotation after terminal revocation'});
    expect(rotateRevoked.status).toBe(409);
    expect(rotateRevoked.body.error).toMatch(/revoked|new credential/i);
    expect((await keyRequest(newRaw)).status).toBe(401);

    const secondRevoke=await api(admin.cookie,'DELETE',`/api/api-keys/${id}`,{reason:'Confirm idempotent terminal revocation'});
    expect(secondRevoke.status).toBe(200);
    expect(secondRevoke.body.changed).toBe(false);

    const audit=await api(admin.cookie,'GET','/api/security-groups/audit/recent');
    expect(audit.status).toBe(200);
    const events=audit.body.filter(x=>Number(x.target_id)===Number(id)&&['api_key_created','api_key_rotated','api_key_revoked','api_key_reactivated'].includes(x.action));
    expect(events.map(x=>x.action)).toEqual(expect.arrayContaining(['api_key_created','api_key_rotated','api_key_revoked']));
    expect(events.some(x=>x.action==='api_key_reactivated')).toBe(false);
    const evidence=JSON.stringify(events);
    expect(evidence).not.toContain(oldRaw);
    expect(evidence).not.toContain(newRaw);
    expect(evidence).toContain(oldPrefix);
    expect(evidence).toContain(rotated.body.prefix);
  });
});
