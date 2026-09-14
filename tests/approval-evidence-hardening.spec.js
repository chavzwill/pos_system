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

async function createApprovalFixture(){
 const admin=await login();
 expect(admin.status,JSON.stringify(admin.body)).toBe(200);
 const suffix=`${Date.now()}${Math.random().toString(36).slice(2,6)}`;
 const branchId=admin.body.default_branch_id||1;
 const department=await api(admin.cookie,'POST','/api/department-approvals/departments',{code:`AE${suffix}`,name:`Approval Evidence ${suffix}`});
 expect(department.status,JSON.stringify(department.body)).toBe(201);
 const member=await api(admin.cookie,'POST',`/api/department-approvals/departments/${department.body.id}/members`,{employee_id:admin.body.id,branch_id:branchId,is_manager:true});
 expect(member.status,JSON.stringify(member.body)).toBe(201);
 const pr=await api(admin.cookie,'POST','/api/purchase-requests',{branch_id:branchId,employee_id:admin.body.id,department:department.body.name,request_type:'sale_items',notes:'Approval evidence immutability certification',items:[{product_name:`Evidence item ${suffix}`,sku:`AE-${suffix}`,quantity:1,unit_cost:15}]});
 expect(pr.status,JSON.stringify(pr.body)).toBe(201);
 const submitted=await api(admin.cookie,'PATCH',`/api/purchase-requests/${pr.body.id}/status`,{status:'submitted',department_id:department.body.id});
 expect(submitted.status,JSON.stringify(submitted.body)).toBe(200);
 const {rows:[approval]}=await db.execute({sql:"SELECT * FROM approval_requests WHERE owning_module='purchase_requests' AND owning_record_id=? AND request_type='purchase_request' ORDER BY id DESC",args:[String(pr.body.id)]});
 expect(approval).toBeTruthy();
 const {rows:[event]}=await db.execute({sql:"SELECT * FROM approval_events WHERE approval_request_id=? AND event_type='submitted' ORDER BY id DESC",args:[approval.id]});
 expect(event).toBeTruthy();
 return {approval,event};
}

test.describe('Approval evidence hardening',()=>{
 test('approval evidence and its parent cannot be rewritten or erased',async()=>{
  const {approval,event}=await createApprovalFixture();
  const originalNotes=event.notes;

  await expect(db.execute({sql:'UPDATE approval_events SET notes=? WHERE id=?',args:['tampered',event.id]})).rejects.toBeTruthy();
  await expect(db.execute({sql:'DELETE FROM approval_events WHERE id=?',args:[event.id]})).rejects.toBeTruthy();
  await expect(db.execute({sql:'DELETE FROM approval_requests WHERE id=?',args:[approval.id]})).rejects.toBeTruthy();

  const {rows:[storedEvent]}=await db.execute({sql:'SELECT * FROM approval_events WHERE id=?',args:[event.id]});
  const {rows:[storedApproval]}=await db.execute({sql:'SELECT * FROM approval_requests WHERE id=?',args:[approval.id]});
  expect(storedEvent).toBeTruthy();
  expect(storedApproval).toBeTruthy();
  expect(storedEvent.notes??null).toBe(originalNotes??null);
  expect(Number(storedEvent.approval_request_id)).toBe(Number(approval.id));
 });
});
