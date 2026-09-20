'use strict';
const {test,expect}=require('@playwright/test');
const {db}=require('../database');
const {createApprovalRequest,ensureApprovalRoutingSchema}=require('../lib/approval-routing');
const BASE='http://localhost:3001';
const ADMIN_USER=process.env.POS_TEST_USER||'admin';
const ADMIN_PASSWORD=process.env.POS_TEST_PASSWORD||'CI-Test-Auth!2026';

async function login(username=ADMIN_USER,password=ADMIN_PASSWORD){
 const r=await fetch(`${BASE}/api/employees/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
 const cookie=(r.headers.get('set-cookie')||'').split(';')[0],body=await r.json().catch(()=>null);
 if(r.status===200&&username===ADMIN_USER){const verify=await fetch(`${BASE}/api/employees/reauth-self`,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({purpose:'security_admin',password})});expect(verify.status,await verify.text()).toBe(200);}
 return {status:r.status,body,cookie};
}
async function api(cookie,method,path,body,headers={}){
 const r=await fetch(`${BASE}${path}`,{method,headers:{Cookie:cookie,'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
 return {status:r.status,body:await r.json().catch(()=>null)};
}
async function fixture(){
 const admin=await login();expect(admin.status,JSON.stringify(admin.body)).toBe(200);
 const suffix=`${Date.now()}${Math.random().toString(36).slice(2,6)}`;
 const branchId=admin.body.default_branch_id||1;
 const dept=await api(admin.cookie,'POST','/api/department-approvals/departments',{code:`T${suffix}`,name:`Test Department ${suffix}`});
 expect(dept.status,JSON.stringify(dept.body)).toBe(201);
 const member=await api(admin.cookie,'POST',`/api/department-approvals/departments/${dept.body.id}/members`,{employee_id:admin.body.id,branch_id:branchId,is_manager:true});
 expect(member.status,JSON.stringify(member.body)).toBe(201);
 return {admin,suffix,branchId,department:dept.body};
}
test.describe('Approval routing foundation',()=>{
 test('external request replay is idempotent and conflicting replay fails closed',async()=>{
  const fx=await fixture();await ensureApprovalRoutingSchema();
  const input={requestType:'test_request',sourceSystem:'smartcommerce',externalRequestId:`ext-${fx.suffix}`,owningModule:'test',owningRecordId:`R-${fx.suffix}`,departmentId:fx.department.id,branchId:fx.branchId,requesterEmployeeId:fx.admin.body.id,requestedAction:'Review request',requiredPermission:'purchasing_approve',payload:{amount:10}};
  const a=await createApprovalRequest(input),b=await createApprovalRequest(input);
  expect(b.id).toBe(a.id);
  await expect(createApprovalRequest({...input,payload:{amount:11}})).rejects.toThrow(/APPROVAL_EXTERNAL_REQUEST_CONFLICT/);
  const {rows:events}=await db.execute({sql:'SELECT * FROM approval_events WHERE approval_request_id=?',args:[a.id]});
  expect(events).toHaveLength(1);
 });

 test('concurrent identical external requests collapse to one durable approval',async()=>{
  const fx=await fixture();await ensureApprovalRoutingSchema();
  const input={requestType:'test_concurrent_replay',sourceSystem:'smartcommerce',externalRequestId:`ext-race-${fx.suffix}`,owningModule:'test',owningRecordId:`ER-${fx.suffix}`,departmentId:fx.department.id,branchId:fx.branchId,requesterEmployeeId:fx.admin.body.id,requestedAction:'Review concurrent replay',requiredPermission:'purchasing_approve',payload:{amount:25}};
  const [a,b]=await Promise.all([createApprovalRequest(input),createApprovalRequest(input)]);
  expect(Number(a.id)).toBe(Number(b.id));
  const {rows:requests}=await db.execute({sql:'SELECT * FROM approval_requests WHERE source_system=? AND external_request_id=?',args:[input.sourceSystem,input.externalRequestId]});
  expect(requests).toHaveLength(1);
  const {rows:events}=await db.execute({sql:'SELECT * FROM approval_events WHERE approval_request_id=?',args:[a.id]});
  expect(events).toHaveLength(1);
 });

 test('approval evidence cannot be updated, deleted, or erased through parent deletion',async()=>{
  const fx=await fixture();await ensureApprovalRoutingSchema();
  const row=await createApprovalRequest({requestType:'test_immutable_evidence',owningModule:'test',owningRecordId:`I-${fx.suffix}`,departmentId:fx.department.id,branchId:fx.branchId,requesterEmployeeId:fx.admin.body.id,requestedAction:'Preserve approval evidence',requiredPermission:'purchasing_approve',notes:'Original immutable evidence',payload:{v:99}});
  const {rows:[event]}=await db.execute({sql:'SELECT * FROM approval_events WHERE approval_request_id=? ORDER BY id DESC',args:[row.id]});
  expect(event).toBeTruthy();
  await expect(db.execute({sql:'UPDATE approval_events SET notes=? WHERE id=?',args:['tampered',event.id]})).rejects.toBeTruthy();
  await expect(db.execute({sql:'DELETE FROM approval_events WHERE id=?',args:[event.id]})).rejects.toBeTruthy();
  await expect(db.execute({sql:'DELETE FROM approval_requests WHERE id=?',args:[row.id]})).rejects.toBeTruthy();
  const {rows:[storedEvent]}=await db.execute({sql:'SELECT * FROM approval_events WHERE id=?',args:[event.id]});
  const {rows:[storedRequest]}=await db.execute({sql:'SELECT * FROM approval_requests WHERE id=?',args:[row.id]});
  expect(storedEvent).toBeTruthy();
  expect(storedRequest).toBeTruthy();
  expect(storedEvent.notes).toBe('Original immutable evidence');
 });

 test('manager queue is department, branch, and permission scoped',async()=>{
  const fx=await fixture();
  const visible=await createApprovalRequest({requestType:'test_visible',owningModule:'test',owningRecordId:`V-${fx.suffix}`,departmentId:fx.department.id,branchId:fx.branchId,requesterEmployeeId:fx.admin.body.id,requestedAction:'Review visible',requiredPermission:'purchasing_approve',payload:{v:1}});
  const otherBranch=await db.execute({sql:`INSERT INTO branches(branch_code,name,active) VALUES(?,?,1)`,args:[`AB-${fx.suffix}`,`Approval Branch ${fx.suffix}`]});
  await createApprovalRequest({requestType:'test_hidden',owningModule:'test',owningRecordId:`H-${fx.suffix}`,departmentId:fx.department.id,branchId:Number(otherBranch.lastInsertRowid),requesterEmployeeId:fx.admin.body.id,requestedAction:'Review hidden',requiredPermission:'purchasing_approve',payload:{v:2}});
  const q=await api(fx.admin.cookie,'GET','/api/employee-assist/department-approvals');
  expect(q.status,JSON.stringify(q.body)).toBe(200);
  expect(q.body.rows.some(r=>Number(r.id)===Number(visible.id))).toBe(true);
  expect(q.body.rows.some(r=>r.owning_record_id===`H-${fx.suffix}`)).toBe(false);
 });


 test('manager queue follows explicit multi-branch authority instead of the employee default branch',async()=>{
  const fx=await fixture();
  const second=await db.execute({sql:`INSERT INTO branches(branch_code,name,active) VALUES(?,?,1)`,args:[`MB-${fx.suffix}`,`Multi Branch ${fx.suffix}`]});
  const secondBranchId=Number(second.lastInsertRowid);
  await db.execute({sql:`INSERT INTO employee_department_memberships(employee_id,department_id,branch_id,is_manager,active,created_by) VALUES(?,?,?,?,1,?)`,args:[fx.admin.body.id,fx.department.id,secondBranchId,1,fx.admin.body.id]});
  const secondBranchApproval=await createApprovalRequest({requestType:'test_multibranch_visible',owningModule:'test',owningRecordId:`MBV-${fx.suffix}`,departmentId:fx.department.id,branchId:secondBranchId,requesterEmployeeId:fx.admin.body.id,requestedAction:'Review second branch request',requiredPermission:'purchasing_approve',payload:{v:21}});
  const q=await api(fx.admin.cookie,'GET','/api/employee-assist/department-approvals');
  expect(q.status,JSON.stringify(q.body)).toBe(200);
  expect(q.body.rows.some(r=>Number(r.id)===Number(secondBranchApproval.id))).toBe(true);
  const detail=await api(fx.admin.cookie,'GET',`/api/employee-assist/department-approvals/${secondBranchApproval.id}`);
  expect(detail.status,JSON.stringify(detail.body)).toBe(200);
 });

 test('department-wide manager authority spans branches without duplicating approvals',async()=>{
  const fx=await fixture();
  const other=await db.execute({sql:`INSERT INTO branches(branch_code,name,active) VALUES(?,?,1)`,args:[`GB-${fx.suffix}`,`Global Branch ${fx.suffix}`]});
  const otherBranchId=Number(other.lastInsertRowid);
  await db.execute({sql:`INSERT INTO employee_department_memberships(employee_id,department_id,branch_id,is_manager,active,created_by) VALUES(?,?,NULL,1,1,?)`,args:[fx.admin.body.id,fx.department.id,fx.admin.body.id]});
  const approval=await createApprovalRequest({requestType:'test_global_manager_scope',owningModule:'test',owningRecordId:`GMS-${fx.suffix}`,departmentId:fx.department.id,branchId:otherBranchId,requesterEmployeeId:fx.admin.body.id,requestedAction:'Review globally managed branch request',requiredPermission:'purchasing_approve',payload:{v:23}});
  const q=await api(fx.admin.cookie,'GET','/api/employee-assist/department-approvals');
  expect(q.status,JSON.stringify(q.body)).toBe(200);
  expect(q.body.rows.filter(r=>Number(r.id)===Number(approval.id))).toHaveLength(1);
  const detail=await api(fx.admin.cookie,'GET',`/api/employee-assist/department-approvals/${approval.id}`);
  expect(detail.status,JSON.stringify(detail.body)).toBe(200);
 });

 test('branch-specific authority does not leak approvals from an unassigned branch',async()=>{
  const fx=await fixture();
  const other=await db.execute({sql:`INSERT INTO branches(branch_code,name,active) VALUES(?,?,1)`,args:[`WB-${fx.suffix}`,`Wrong Branch ${fx.suffix}`]});
  const hidden=await createApprovalRequest({requestType:'test_wrong_branch_hidden',owningModule:'test',owningRecordId:`WBH-${fx.suffix}`,departmentId:fx.department.id,branchId:Number(other.lastInsertRowid),requesterEmployeeId:fx.admin.body.id,requestedAction:'Review wrong branch request',requiredPermission:'purchasing_approve',payload:{v:22}});
  const q=await api(fx.admin.cookie,'GET','/api/employee-assist/department-approvals');
  expect(q.status,JSON.stringify(q.body)).toBe(200);
  expect(q.body.rows.some(r=>Number(r.id)===Number(hidden.id))).toBe(false);
  const detail=await api(fx.admin.cookie,'GET',`/api/employee-assist/department-approvals/${hidden.id}`);
  expect(detail.status).toBe(404);
  expect(detail.body.code).toBe('APPROVAL_NOT_FOUND');
 });

 test('two managers cannot both win the same approval version',async()=>{
  const fx=await fixture();
  const row=await createApprovalRequest({requestType:'test_race',owningModule:'test',owningRecordId:`C-${fx.suffix}`,departmentId:fx.department.id,branchId:fx.branchId,requesterEmployeeId:fx.admin.body.id,requestedAction:'Review race',requiredPermission:'purchasing_approve',payload:{v:3}});
  const body={version:row.version,notes:'Claim for review'};
  const [a,b]=await Promise.all([
   api(fx.admin.cookie,'POST',`/api/employee-assist/department-approvals/${row.id}/claim`,body),
   api(fx.admin.cookie,'POST',`/api/employee-assist/department-approvals/${row.id}/claim`,body)
  ]);
  expect([a.status,b.status].filter(x=>x===200)).toHaveLength(1);
  expect([a.status,b.status].filter(x=>x===409)).toHaveLength(1);
  const conflict=[a,b].find(x=>x.status===409);
  expect(['APPROVAL_VERSION_CONFLICT','APPROVAL_NOT_PENDING']).toContain(conflict.body.code);
  const {rows:events}=await db.execute({sql:`SELECT * FROM approval_events WHERE approval_request_id=? AND event_type='claim'`,args:[row.id]});
  expect(events).toHaveLength(1);
 });

 test('approve and reject fail closed with safe stable errors until an authoritative module adapter exists',async()=>{
  const fx=await fixture();
  const row=await createApprovalRequest({requestType:'test_no_adapter',owningModule:'test',owningRecordId:`N-${fx.suffix}`,departmentId:fx.department.id,branchId:fx.branchId,requesterEmployeeId:fx.admin.body.id,requestedAction:'Review no adapter',requiredPermission:'purchasing_approve',payload:{v:4}});
  for(const decision of ['approved','rejected']){
   const r=await api(fx.admin.cookie,'POST',`/api/employee-assist/department-approvals/${row.id}/${decision}`,{version:row.version});
   expect(r.status).toBe(409);
   expect(r.body.code).toBe('APPROVAL_HANDLER_UNAVAILABLE');
   expect(r.body.error).toMatch(/original request/i);
   expect(r.body.error).not.toMatch(/SQL|constraint|stack/i);
  }
  const {rows:[stored]}=await db.execute({sql:'SELECT status,version FROM approval_requests WHERE id=?',args:[row.id]});
  expect(stored.status).toBe('submitted');expect(Number(stored.version)).toBe(Number(row.version));
 });

 test('department uniqueness failures return human-safe codes instead of database errors',async()=>{
  const fx=await fixture();
  const duplicate=await api(fx.admin.cookie,'POST','/api/department-approvals/departments',{code:fx.department.code,name:'Duplicate department'});
  expect(duplicate.status).toBe(409);
  expect(duplicate.body.code).toBe('DEPARTMENT_CODE_CONFLICT');
  expect(duplicate.body.error).toMatch(/already in use/i);
  expect(duplicate.body.error).not.toMatch(/UNIQUE|constraint|departments\.code|SQL/i);
 });

 test('API keys cannot operate internal approval workflows',async()=>{
  const fx=await fixture();
  const created=await api(fx.admin.cookie,'POST','/api/api-keys',{name:`Approval key ${fx.suffix}`,scopes:['products:read'],reason:'Certify approval API-key boundary'});
  expect(created.status,JSON.stringify(created.body)).toBe(201);
  const r=await fetch(`${BASE}/api/employee-assist/department-approvals`,{headers:{'X-API-Key':created.body.key}});
  expect(r.status).toBe(403);
  const body=await r.json();expect(body.code).toBe('APPROVAL_API_KEY_FORBIDDEN');
 });

 test('ordinary department manager cannot grant manager authority',async()=>{
  const fx=await fixture();
  const group=await api(fx.admin.cookie,'POST','/api/security-groups',{name:`Approval mgr ${fx.suffix}`,description:'No security assignment authority',permissions:{purchase_requests:true,pr_approve:true,purchasing_approve:true},reason:'Certify department manager boundary'});
  expect(group.status,JSON.stringify(group.body)).toBe(201);
  const password=`Mgr-${fx.suffix}-A9!`;
  const employee=await api(fx.admin.cookie,'POST','/api/employees',{first_name:'Approval',last_name:'Manager',username:`approval_mgr_${fx.suffix}`,pin:String(100000+(Date.now()%899999)).slice(0,6),password,security_group_id:group.body.id,default_branch_id:fx.branchId});
  expect(employee.status,JSON.stringify(employee.body)).toBe(201);
  const manager=await login(`approval_mgr_${fx.suffix}`,password);expect(manager.status).toBe(200);
  const denied=await api(manager.cookie,'POST',`/api/department-approvals/departments/${fx.department.id}/members`,{employee_id:employee.body.id,branch_id:fx.branchId,is_manager:true});
  expect(denied.status).toBe(403);
 });

 test('Guide Me exposes department approval review and protected setup guidance',async({page})=>{
  const admin=await login();expect(admin.status).toBe(200);
  const split=admin.cookie.indexOf('=');
  await page.context().addCookies([{name:admin.cookie.slice(0,split),value:admin.cookie.slice(split+1),url:BASE}]);
  await page.goto(BASE,{waitUntil:'domcontentloaded'});
  const guideAccess=page.locator('#tt-guide-access');
  await expect(guideAccess).toBeVisible({timeout:15000});
  await guideAccess.click();
  await expect(page.getByRole('dialog',{name:'Guide Me'})).toBeVisible({timeout:5000});
  await expect(page.getByRole('button',{name:'Review department approvals'})).toBeVisible({timeout:5000});
  await expect(page.getByRole('button',{name:'Set up approval departments'})).toBeVisible();
  await page.getByRole('button',{name:'Review department approvals'}).click();
  await expect(page.locator('#tt-guided-mode .tt-guide__head p')).toHaveText('Review department approvals');
  await expect(page.locator('[data-approval-guide-panel]')).toContainText('original business record');
  await expect(page.locator('[data-approval-guide-panel]')).toContainText('will never approve or reject anything for you');
 });
});