'use strict';
const {test,expect}=require('@playwright/test');
const {db}=require('../database');
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
 const {rows:[employee]}=await db.execute({sql:'SELECT permissions FROM employees WHERE id=?',args:[admin.body.id]});
 const permissions=JSON.parse(employee.permissions||'{}');
 permissions.accounts=true;
 permissions.accounts_credit_approve=true;
 await db.execute({sql:'UPDATE employees SET permissions=? WHERE id=?',args:[JSON.stringify(permissions),admin.body.id]});
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

test.describe('Customer credit governance',()=>{
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

 test('proposal creates one durable approval and replay does not duplicate evidence',async()=>{
  const fx=await fixture();
  const payload={credit_enabled:true,credit_limit:75000,credit_terms_days:30,department_id:fx.department.id,reason:'Trade account approved after review'};
  const first=await api(fx.admin.cookie,'POST',`/api/accounts/customer/${fx.customerId}/credit-change-requests`,payload);
  expect(first.status,JSON.stringify(first.body)).toBe(201);
  const second=await api(fx.admin.cookie,'POST',`/api/accounts/customer/${fx.customerId}/credit-change-requests`,payload);
  expect([200,201]).toContain(second.status);
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

 test('authorized Accounts manager decision atomically applies customer credit and evidence',async()=>{
  const fx=await fixture();
  const proposed=await api(fx.admin.cookie,'POST',`/api/accounts/customer/${fx.customerId}/credit-change-requests`,{credit_enabled:true,credit_limit:90000,credit_terms_days:45,department_id:fx.department.id,reason:'Approved trade terms'});
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
});
