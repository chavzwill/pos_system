'use strict';
const {test,expect}=require('@playwright/test');
const {db}=require('../database');
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
async function fixture(){
 const admin=await login();expect(admin.status,JSON.stringify(admin.body)).toBe(200);
 const suffix=`${Date.now()}${Math.random().toString(36).slice(2,6)}`;
 const branchId=admin.body.default_branch_id||1;
 const department=await api(admin.cookie,'POST','/api/department-approvals/departments',{code:`P${suffix}`,name:`Purchasing Test ${suffix}`});
 expect(department.status,JSON.stringify(department.body)).toBe(201);
 const member=await api(admin.cookie,'POST',`/api/department-approvals/departments/${department.body.id}/members`,{employee_id:admin.body.id,branch_id:branchId,is_manager:true});
 expect(member.status,JSON.stringify(member.body)).toBe(201);
 const pr=await api(admin.cookie,'POST','/api/purchase-requests',{branch_id:branchId,employee_id:admin.body.id,department:department.body.name,request_type:'sale_items',notes:'Approval adapter certification',items:[{product_name:`Adapter item ${suffix}`,sku:`PAD-${suffix}`,quantity:2,unit_cost:25}]});
 expect(pr.status,JSON.stringify(pr.body)).toBe(201);
 return {admin,suffix,branchId,department:department.body,pr:pr.body};
}
async function submit(fx,cookie=fx.admin.cookie){
 return api(cookie,'PATCH',`/api/purchase-requests/${fx.pr.id}/status`,{status:'submitted',department_id:fx.department.id});
}
async function envelope(prId){
 const {rows}=await db.execute({sql:"SELECT * FROM approval_requests WHERE owning_module='purchase_requests' AND owning_record_id=? AND request_type='purchase_request' ORDER BY id DESC",args:[String(prId)]});
 return rows;
}

test.describe('Purchasing approval adapter',()=>{
 test('submission creates one durable approval and direct terminal mutation is blocked',async()=>{
  const fx=await fixture();
  const submitted=await submit(fx);
  expect(submitted.status,JSON.stringify(submitted.body)).toBe(200);
  expect(submitted.body.status).toBe('submitted');
  const approvals=await envelope(fx.pr.id);
  expect(approvals).toHaveLength(1);
  expect(Number(approvals[0].department_id)).toBe(Number(fx.department.id));
  expect(approvals[0].required_permission).toBe('purchasing_approve');
  expect(Number(approvals[0].requester_employee_id)).toBe(Number(fx.admin.body.id));

  const bypass=await api(fx.admin.cookie,'PATCH',`/api/purchase-requests/${fx.pr.id}/status`,{status:'approved',approved_by:999999});
  expect(bypass.status).toBe(409);
  expect(bypass.body.code).toBe('PURCHASE_REQUEST_APPROVAL_REQUIRED');
  expect(bypass.body.error).toMatch(/department approval/i);
  expect(bypass.body.error).not.toMatch(/SQL|constraint|stack/i);

  const {rows:[stored]}=await db.execute({sql:'SELECT status,approved_by FROM purchase_requests WHERE id=?',args:[fx.pr.id]});
  expect(stored.status).toBe('submitted');
  expect(stored.approved_by).toBeNull();
 });

 test('replayed and concurrent submissions keep one approval envelope and one submitted event',async()=>{
  const fx=await fixture();
  const [a,b]=await Promise.all([submit(fx),submit(fx)]);
  expect([a.status,b.status].filter(status=>status===200).length).toBeGreaterThanOrEqual(1);
  expect([a.status,b.status].every(status=>[200,409,503].includes(status))).toBe(true);
  const replay=await submit(fx);
  expect(replay.status,JSON.stringify(replay.body)).toBe(200);
  const approvals=await envelope(fx.pr.id);
  expect(approvals).toHaveLength(1);
  const {rows:events}=await db.execute({sql:"SELECT * FROM approval_events WHERE approval_request_id=? AND event_type='submitted'",args:[approvals[0].id]});
  expect(events).toHaveLength(1);
  const {rows:[stored]}=await db.execute({sql:'SELECT status FROM purchase_requests WHERE id=?',args:[fx.pr.id]});
  expect(stored.status).toBe('submitted');
 });

 test('ordinary branch staff cannot submit a purchase request owned by another branch',async()=>{
  const fx=await fixture();
  const otherBranch=await db.execute({sql:'INSERT INTO branches(branch_code,name,active) VALUES(?,?,1)',args:[`PB-${fx.suffix}`,`Purchasing Branch ${fx.suffix}`]});
  const otherBranchId=Number(otherBranch.lastInsertRowid);
  const foreignPr=await api(fx.admin.cookie,'POST','/api/purchase-requests',{branch_id:otherBranchId,employee_id:fx.admin.body.id,department:fx.department.name,request_type:'sale_items',notes:'Cross branch approval certification',items:[{product_name:`Foreign item ${fx.suffix}`,sku:`PBF-${fx.suffix}`,quantity:1,unit_cost:10}]});
  expect(foreignPr.status,JSON.stringify(foreignPr.body)).toBe(201);

  const group=await api(fx.admin.cookie,'POST','/api/security-groups',{name:`Purchasing branch user ${fx.suffix}`,description:'Purchase request access without cross-branch administration',permissions:{purchase_requests:true,purchasing_approve:true},reason:'Certify purchasing approval branch scope'});
  expect(group.status,JSON.stringify(group.body)).toBe(201);
  const password=`PBranch-${fx.suffix}-A9!`;
  const employee=await api(fx.admin.cookie,'POST','/api/employees',{first_name:'Purchasing',last_name:'BranchUser',username:`pbranch_${fx.suffix}`,pin:String(100000+(Date.now()%899999)).slice(0,6),password,security_group_id:group.body.id,default_branch_id:fx.branchId});
  expect(employee.status,JSON.stringify(employee.body)).toBe(201);
  const staff=await login(`pbranch_${fx.suffix}`,password);expect(staff.status).toBe(200);

  const denied=await api(staff.cookie,'PATCH',`/api/purchase-requests/${foreignPr.body.id}/status`,{status:'submitted',department_id:fx.department.id});
  expect(denied.status).toBe(403);
  expect(denied.body.code).toBe('PURCHASE_REQUEST_BRANCH_FORBIDDEN');
  expect(denied.body.error).not.toMatch(/SQL|constraint|stack/i);
  expect(await envelope(foreignPr.body.id)).toHaveLength(0);
  const {rows:[stored]}=await db.execute({sql:'SELECT status FROM purchase_requests WHERE id=?',args:[foreignPr.body.id]});
  expect(stored.status).toBe('draft');
 });

 test('authorized manager approval updates the purchase request and approval evidence atomically',async()=>{
  const fx=await fixture();expect((await submit(fx)).status).toBe(200);
  const [approval]=await envelope(fx.pr.id);expect(approval).toBeTruthy();
  const queue=await api(fx.admin.cookie,'GET','/api/employee-assist/department-approvals');
  const visible=queue.body.rows.find(row=>Number(row.id)===Number(approval.id));
  expect(visible).toBeTruthy();
  expect(visible.can_decide).toBe(true);
  expect(visible.decision_area).toBe('Purchasing');

  const decided=await api(fx.admin.cookie,'POST',`/api/employee-assist/department-approvals/${approval.id}/approved`,{version:Number(approval.version),notes:'Approved for purchase'});
  expect(decided.status,JSON.stringify(decided.body)).toBe(200);
  expect(decided.body.status).toBe('approved');
  expect(decided.body.decision_area).toBe('Purchasing');

  const {rows:[pr]}=await db.execute({sql:'SELECT status,approved_by,approved_at FROM purchase_requests WHERE id=?',args:[fx.pr.id]});
  expect(pr.status).toBe('approved');
  expect(Number(pr.approved_by)).toBe(Number(fx.admin.body.id));
  expect(pr.approved_at).toBeTruthy();
  const {rows:[storedApproval]}=await db.execute({sql:'SELECT status,decided_by,decided_at,version FROM approval_requests WHERE id=?',args:[approval.id]});
  expect(storedApproval.status).toBe('approved');
  expect(Number(storedApproval.decided_by)).toBe(Number(fx.admin.body.id));
  expect(storedApproval.decided_at).toBeTruthy();
  const {rows:events}=await db.execute({sql:"SELECT * FROM approval_events WHERE approval_request_id=? AND event_type='approved'",args:[approval.id]});
  expect(events).toHaveLength(1);
  expect(events[0].authoritative_result).toMatch(/purchase_request/);
 });

 test('concurrent terminal decisions cannot split purchase request and approval state',async()=>{
  const fx=await fixture();expect((await submit(fx)).status).toBe(200);
  const [approval]=await envelope(fx.pr.id);expect(approval).toBeTruthy();
  const body={version:Number(approval.version),notes:'Concurrent certification'};
  const [approve,reject]=await Promise.all([
   api(fx.admin.cookie,'POST',`/api/employee-assist/department-approvals/${approval.id}/approved`,body),
   api(fx.admin.cookie,'POST',`/api/employee-assist/department-approvals/${approval.id}/rejected`,body)
  ]);
  expect([approve.status,reject.status].filter(status=>status===200)).toHaveLength(1);
  expect([approve.status,reject.status].filter(status=>status===409)).toHaveLength(1);
  const {rows:[pr]}=await db.execute({sql:'SELECT status FROM purchase_requests WHERE id=?',args:[fx.pr.id]});
  const {rows:[stored]}=await db.execute({sql:'SELECT status FROM approval_requests WHERE id=?',args:[approval.id]});
  expect(['approved','rejected']).toContain(pr.status);
  expect(stored.status).toBe(pr.status);
  const {rows:terminalEvents}=await db.execute({sql:"SELECT * FROM approval_events WHERE approval_request_id=? AND event_type IN ('approved','rejected')",args:[approval.id]});
  expect(terminalEvents).toHaveLength(1);
 });
});
