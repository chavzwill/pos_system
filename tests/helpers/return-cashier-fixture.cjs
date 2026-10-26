'use strict';
const assert=require('node:assert/strict');
async function makeCashier(api,adminCookie,branchId,suffix){
  if(process.env.NODE_ENV==='production'||process.env.TURSO_DATABASE_URL)
    throw Error('This test requires an isolated local database');
  const rootPassword=process.env.POS_TEST_PASSWORD;
  assert.ok(rootPassword);
  const step=await api(adminCookie,'/api/employees/reauth-self',{method:'POST',body:JSON.stringify({purpose:'security_admin',password:rootPassword})});
  assert.equal(step.status,200,JSON.stringify(step.body));
  const group=await api(adminCookie,'/api/security-groups',{method:'POST',body:JSON.stringify({
    name:'Test Cashier '+suffix,description:'Isolated return test',
    reason:'Independent return authorization regression',
    permissions:{pos:true,transactions:true,transactions_returns:true},
  })});
  assert.equal(group.status,201,JSON.stringify(group.body));
  const username='test_r_'+suffix.slice(-12),password='Test!'+suffix+'Ax3';
  const member=await api(adminCookie,'/api/employees',{method:'POST',body:JSON.stringify({
    first_name:'Test',last_name:'Cashier',username,password,pin:'642908',
    security_group_id:group.body.id,default_branch_id:branchId,must_change_password:false,
  })});
  assert.equal(member.status,201,JSON.stringify(member.body));
  const r=await fetch('http://localhost:3001/api/employees/login',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
  assert.equal(r.status,200);
  const cookie=(r.headers.get('set-cookie')||'').split(';')[0];
  assert.ok(cookie);
  return {cookie};
}
module.exports={makeCashier};