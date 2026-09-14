'use strict';
const {test,expect}=require('@playwright/test');
const {db}=require('../database');
const {can}=require('../lib/permissions');
const BASE='http://localhost:3001';
const ADMIN_USER=process.env.POS_TEST_USER||'admin';
const ADMIN_PASSWORD=process.env.POS_TEST_PASSWORD||'CI-Test-Auth!2026';

async function login(){
 const r=await fetch(`${BASE}/api/employees/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:ADMIN_USER,password:ADMIN_PASSWORD})});
 return {status:r.status,body:await r.json().catch(()=>null),cookie:(r.headers.get('set-cookie')||'').split(';')[0]};
}
async function api(cookie,method,path,body){
 const r=await fetch(`${BASE}${path}`,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 return {status:r.status,body:await r.json().catch(()=>null)};
}
async function grantCreditAuthority(admin){
 const {rows:[employee]}=await db.execute({sql:'SELECT security_group_id FROM employees WHERE id=?',args:[admin.body.id]});
 const {rows:[group]}=await db.execute({sql:'SELECT permissions FROM security_groups WHERE id=?',args:[employee.security_group_id]});
 const permissions=JSON.parse(group.permissions||'{}');
 permissions.accounts=true;
 permissions.accounts_credit_approve=true;
 await db.execute({sql:'UPDATE security_groups SET permissions=? WHERE id=?',args:[JSON.stringify(permissions),employee.security_group_id]});
 return login();
}
async function fixture(){
 let admin=await login();expect(admin.status,JSON.stringify(admin.body)).toBe(200);
 admin=await grantCreditAuthority(admin);expect(admin.status).toBe(200);
 const suffix=`${Date.now()}${Math.random().toString(36).slice(2,6)}`;
 const branchId=admin.body.default_branch_id||1;
 const department=await api(admin.cookie,'POST','/api/department-approvals/departments',{code:`A${suffix}`,name:`Accounts Test ${suffix}`});
 expect(department.status,JSON.stringify(department.body)).toBe(201);
 expect((await api(admin.cookie,'POST',`/api/department-approvals/departments/${department.body.id}/members`,{employee_id:admin.body.id,branch_id:branchId,is_manager:true})).status).toBe(201);
 const result=await db.execute({sql:`INSERT INTO customers(customer_number,first_name,last_name,customer_type,credit_terms_days,credit_limit,credit_enabled,account_balance,active) VALUES(?,?,?,?,?,?,?,?,?)`,args:[`CG-${suffix}`,'Credit','Governance','cash',30,0,0,0,1]});
 return {admin,suffix,branchId,department:department.body,customerId:Number(result.lastInsertRowid)};
}
async function envelope(customerId){
 const {rows}=await db.execute({sql:"SELECT * FROM approval_requests WHERE owning_module='customer_credit' AND owning_record_id=? AND request_type='customer_credit_change' ORDER BY id DESC",args:[String(customerId)]});
 return rows;
}

const proposal=(fx,overrides={})=>({credit_enabled:true,credit_limit:75000,credit_terms_days:30,department_id:fx.department.id,reason:'Trade account approved after review',...overrides});

test.describe('Customer credit governance',()=>{
 test('credit approval authority is explicit-only and does not inherit from broad Accounts access',async()=>{
  expect(can({accounts:true},'accounts_credit_approve')).toBe(false);
  expect(can({accounts:true,accounts_credit_approve:true},'accounts_credit_approve')).toBe(true);
 });

 test('direct credit changes through Accounts and Customers are blocked',async()=>{
  const fx=await fixture();
  const direct=await api(fx.admin.cookie,'PATCH',`/api/accounts/customer/${fx.customerId}`,{credit_enabled:true,credit_limit:50000});
  expect(direct.status).toBe(409);
  expect(direct.body.code).toBe('CREDIT_CHANGE_APPROVAL_REQUIRED');
  const customerEdit=await api(fx.admin.cookie,'PUT',`/api/customers/${fx.customerId}`,{first_name:'Credit',last_name:'Governance',customer_type:'credit',credit_terms_days:30,credit_limit:50000,active:1});
  expect(customerEdit.status).toBe(409);
  expect(customerEdit.body.code).toBe('CREDIT_CHANGE_APPROVAL_REQUIRED');
  const createCredit=await api(fx.admin.cookie,'POST','/api/customers',{first_name:'Direct',last_name:`Credit ${fx.suffix}`,customer_type:'credit',credit_limit:50000});
  expect(createCredit.status).toBe(409);
  expect(createCredit.body.code).toBe('CREDIT_CHANGE_APPROVAL_REQUIRED');
 });

 test('concurrent identical proposals collapse to one durable approval and one submitted event',async()=>{
  const fx=await fixture();
  const body=proposal(fx);
  const [first,second]=await Promise.all([
   api(fx.admin.cookie,'POST',`/api/accounts/customer/${fx.customerId}/credit-change-requests`,body),
   api(fx.admin.cookie,'POST',`/api/accounts/customer/${fx.customerId}/credit-change-requests`,body)
  ]);
  expect([first.status,second.status].every(status=>status===200||status===201),JSON.stringify([first,second])).toBe(true);
  const approvals=await envelope(fx.customerId);
  expect(approvals).toHaveLength(1);
  expect(approvals[0].required_permission).toBe('accounts_credit_approve');
  const {rows:events}=await db.execute({sql:"SELECT * FROM approval_events WHERE approval_request_id=? AND event_type='submitted'",args:[approvals[0].id]});
  expect(events).toHaveLength(1);
  const {rows:[customer]}=await db.execute({sql:'SELECT credit_enabled,credit_limit,customer_type FROM customers WHERE id=?',args:[fx.customerId]});
  expect(Number(customer.credit_enabled)).toBe(0);
  expect(Number(customer.credit_limit)).toBe(0);
  expect(customer.customer_type).toBe('cash');
 });

 test('authorized Accounts manager approval atomically applies customer credit and evidence',async()=>{
  const fx=await fixture();
  const proposed=await api(fx.admin.cookie,'POST',`/api/accounts/customer/${fx.customerId}/credit-change-requests`,proposal(fx,{credit_limit:90000,credit_terms_days:45,reason:'Approved trade terms'}));
  expect(proposed.status,JSON.stringify(proposed.body)).toBe(201);
  const [approval]=await envelope(fx.customerId);expect(approval).toBeTruthy();
  const decided=await api(fx.admin.cookie,'POST',`/api/employee-assist/department-approvals/${approval.id}/approved`,{version:Number(approval.version),notes:'Credit review complete'});
  expect(decided.status,JSON.stringify(decided.body)).toBe(200);
  expect(decided.body.decision_area).toBe('Accounts');
  const {rows:[customer]}=await db.execute({sql:'SELECT credit_enabled,credit_limit,credit_terms_days,customer_type FROM customers WHERE id=?',args:[fx.customerId]});
  expect(Number(customer.credit_enabled)).toBe(1);
  expect(Number(customer.credit_limit)).toBe(90000);
  expect(Number(customer.credit_terms_days)).toBe(45);
  expect(customer.customer_type).toBe('credit');
  const {rows:[stored]}=await db.execute({sql:'SELECT status,decided_by,decided_at FROM approval_requests WHERE id=?',args:[approval.id]});
  expect(stored.status).toBe('approved');
  expect(Number(stored.decided_by)).toBe(Number(fx.admin.body.id));
  expect(stored.decided_at).toBeTruthy();
  const {rows:terminal}=await db.execute({sql:"SELECT * FROM approval_events WHERE approval_request_id=? AND event_type='approved'",args:[approval.id]});
  expect(terminal).toHaveLength(1);
  expect(terminal[0].authoritative_result).toMatch(/customer_credit/);
 });

 test('rejection leaves customer credit unchanged while recording the decision',async()=>{
  const fx=await fixture();
  expect((await api(fx.admin.cookie,'POST',`/api/accounts/customer/${fx.customerId}/credit-change-requests`,proposal(fx,{credit_limit:60000}))).status).toBe(201);
  const [approval]=await envelope(fx.customerId);
  const rejected=await api(fx.admin.cookie,'POST',`/api/employee-assist/department-approvals/${approval.id}/rejected`,{version:Number(approval.version),notes:'Insufficient account history'});
  expect(rejected.status,JSON.stringify(rejected.body)).toBe(200);
  const {rows:[customer]}=await db.execute({sql:'SELECT credit_enabled,credit_limit,customer_type FROM customers WHERE id=?',args:[fx.customerId]});
  expect(Number(customer.credit_enabled)).toBe(0);expect(Number(customer.credit_limit)).toBe(0);expect(customer.customer_type).toBe('cash');
  const {rows:[stored]}=await db.execute({sql:'SELECT status FROM approval_requests WHERE id=?',args:[approval.id]});
  expect(stored.status).toBe('rejected');
 });

 test('concurrent approve and reject cannot split customer credit from approval state',async()=>{
  const fx=await fixture();
  expect((await api(fx.admin.cookie,'POST',`/api/accounts/customer/${fx.customerId}/credit-change-requests`,proposal(fx,{credit_limit:110000}))).status).toBe(201);
  const [approval]=await envelope(fx.customerId);const body={version:Number(approval.version),notes:'Concurrent credit decision'};
  const [approve,reject]=await Promise.all([
   api(fx.admin.cookie,'POST',`/api/employee-assist/department-approvals/${approval.id}/approved`,body),
   api(fx.admin.cookie,'POST',`/api/employee-assist/department-approvals/${approval.id}/rejected`,body)
  ]);
  expect([approve.status,reject.status].filter(x=>x===200)).toHaveLength(1);
  expect([approve.status,reject.status].filter(x=>x===409)).toHaveLength(1);
  const {rows:[stored]}=await db.execute({sql:'SELECT status FROM approval_requests WHERE id=?',args:[approval.id]});
  const {rows:[customer]}=await db.execute({sql:'SELECT credit_enabled,credit_limit,customer_type FROM customers WHERE id=?',args:[fx.customerId]});
  if(stored.status==='approved'){expect(Number(customer.credit_enabled)).toBe(1);expect(Number(customer.credit_limit)).toBe(110000);expect(customer.customer_type).toBe('credit');}
  else{expect(stored.status).toBe('rejected');expect(Number(customer.credit_enabled)).toBe(0);expect(Number(customer.credit_limit)).toBe(0);expect(customer.customer_type).toBe('cash');}
  const {rows:terminal}=await db.execute({sql:"SELECT * FROM approval_events WHERE approval_request_id=? AND event_type IN ('approved','rejected')",args:[approval.id]});
  expect(terminal).toHaveLength(1);
 });
});
