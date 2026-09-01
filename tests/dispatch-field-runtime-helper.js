import { expect, test } from '@playwright/test';

const BASE='http://localhost:3001';
async function login(){const r=await fetch(`${BASE}/api/employees/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:process.env.POS_TEST_USER||'admin',password:process.env.POS_TEST_PASSWORD||'123456'})});expect(r.status).toBe(200);return {cookie:(r.headers.get('set-cookie')||'').split(';')[0],body:await r.json()};}
async function api(cookie,path,options={}){const headers={Cookie:cookie,Accept:'application/json',...(options.headers||{})};if(options.body&&!headers['Content-Type'])headers['Content-Type']='application/json';const r=await fetch(`${BASE}${path}`,{...options,headers});return {status:r.status,body:await r.json().catch(()=>null)};}

export function registerDispatchFieldRuntimeCertification(){
 test('dispatch field execution enforces driver, custody, proof and controlled completion',async()=>{
  const admin=await login();
  const branches=await api(admin.cookie,'/api/branches');expect(branches.status).toBe(200);const branch=branches.body.find(b=>b.active!==0);test.skip(!branch,'Dispatch runtime certification requires an active branch');
  const suffix=`${Date.now()}${Math.random().toString(36).slice(2,6)}`;
  const pinA=String(Date.now()).slice(-6),pinB=String(Date.now()+17).slice(-6);
  let nonDriver=null,driver=null,vehicle=null,job=null;
  try{
   let x=await api(admin.cookie,'/api/employees',{method:'POST',body:JSON.stringify({first_name:'Runtime',last_name:'NotDriver',username:`nd_${suffix}`,pin:pinA,password:`Nd!${suffix}Aa1`,default_branch_id:branch.id,is_driver:false,must_change_password:false})});expect(x.status).toBe(201);nonDriver=x.body;
   x=await api(admin.cookie,'/api/employees',{method:'POST',body:JSON.stringify({first_name:'Runtime',last_name:'Driver',username:`drv_${suffix}`,pin:pinB,password:`Dr!${suffix}Aa1`,default_branch_id:branch.id,is_driver:true,must_change_password:false})});expect(x.status).toBe(201);driver=x.body;expect(Number(driver.is_driver)).toBe(1);
   x=await api(admin.cookie,'/api/logistics-intelligence/vehicles',{method:'POST',body:JSON.stringify({vehicle_number:`RTV-${suffix}`,registration_number:`RT-${suffix.slice(-6)}`,description:`Runtime dispatch vehicle ${suffix}`,vehicle_type:'test',capacity_kg:1000,current_branch_id:branch.id,status:'available'})});expect(x.status).toBe(201);vehicle=x.body;
   x=await api(admin.cookie,'/api/logistics-intelligence/jobs',{method:'POST',body:JSON.stringify({source_type:'runtime_certification',branch_id:branch.id,origin_label:'Runtime Origin',destination_label:'Runtime Destination',job_type:'runtime_delivery',priority:'normal',notes:'Dispatch field runtime certification'})});expect(x.status).toBe(201);job=x.body;expect(job.status).toBe('unassigned');

   let blocked=await api(admin.cookie,`/api/logistics-intelligence/jobs/${job.id}/status`,{method:'POST',body:JSON.stringify({status:'completed'})});expect(blocked.status).toBe(409);expect(blocked.body?.control).toBe('dispatch_field_execution_required');
   blocked=await api(admin.cookie,`/api/logistics-intelligence/jobs/${job.id}/assign`,{method:'POST',body:JSON.stringify({driver_employee_id:nonDriver.id,vehicle_id:vehicle.id})});expect(blocked.status).toBe(409);expect(blocked.body?.control).toBe('dispatch_driver_eligibility');

   x=await api(admin.cookie,`/api/logistics-intelligence/jobs/${job.id}/assign`,{method:'POST',body:JSON.stringify({driver_employee_id:driver.id,vehicle_id:vehicle.id})});expect(x.status).toBe(200);expect(x.body.stage).toBe('assigned');expect(Number(x.body.driver_employee_id)).toBe(Number(driver.id));

   blocked=await api(admin.cookie,`/api/logistics-intelligence/jobs/${job.id}/complete`,{method:'POST',body:JSON.stringify({})});expect(blocked.status).toBe(409);
   x=await api(admin.cookie,`/api/logistics-intelligence/jobs/${job.id}/stage/depart_origin`,{method:'POST',body:JSON.stringify({notes:'Departing runtime origin'})});expect(x.status).toBe(200);expect(x.body.stage).toBe('en_route_to_origin');
   x=await api(admin.cookie,`/api/logistics-intelligence/jobs/${job.id}/stage/arrive_origin`,{method:'POST',body:JSON.stringify({notes:'At runtime origin'})});expect(x.status).toBe(200);expect(x.body.stage).toBe('at_origin');
   x=await api(admin.cookie,`/api/logistics-intelligence/jobs/${job.id}/stage/pickup`,{method:'POST',body:JSON.stringify({released_by:'Runtime Supplier',evidence_reference:`PICK-${suffix}`,notes:'Runtime custody accepted'})});expect(x.status).toBe(200);expect(x.body.stage).toBe('in_transit');
   x=await api(admin.cookie,`/api/logistics-intelligence/jobs/${job.id}/stage/arrive_destination`,{method:'POST',body:JSON.stringify({notes:'Arrived runtime destination'})});expect(x.status).toBe(200);expect(x.body.stage).toBe('at_destination');

   blocked=await api(admin.cookie,`/api/logistics-intelligence/jobs/${job.id}/complete`,{method:'POST',body:JSON.stringify({})});expect(blocked.status).toBe(409);expect(String(blocked.body?.error||'').toLowerCase()).toContain('proof');
   x=await api(admin.cookie,`/api/logistics-intelligence/jobs/${job.id}/proof`,{method:'POST',body:JSON.stringify({proof_type:'delivery',recipient_name:'Runtime Recipient',signature_name:'Runtime Recipient',evidence_reference:`DEL-${suffix}`,notes:'Runtime delivery accepted',latitude:18.0179,longitude:-76.8099})});expect(x.status).toBe(201);expect(x.body.proof_type).toBe('delivery');
   x=await api(admin.cookie,`/api/logistics-intelligence/jobs/${job.id}/complete`,{method:'POST',body:JSON.stringify({recipient_name:'Runtime Recipient',evidence_reference:`DEL-${suffix}`,notes:'Runtime dispatch completed'})});expect(x.status).toBe(200);expect(x.body.job.status).toBe('completed');expect(x.body.execution.stage).toBe('completed');

   const evidence=await api(admin.cookie,`/api/logistics-intelligence/jobs/${job.id}/execution`);expect(evidence.status).toBe(200);expect(evidence.body.proofs.some(p=>p.proof_type==='delivery')).toBe(true);expect(evidence.body.custody.some(c=>c.event_type==='pickup_custody')).toBe(true);expect(evidence.body.custody.some(c=>c.event_type==='custody_released')).toBe(true);
   const vehicles=await api(admin.cookie,'/api/logistics-intelligence/vehicles');expect(vehicles.status).toBe(200);const finalVehicle=vehicles.body.find(v=>String(v.id)===String(vehicle.id));expect(finalVehicle).toBeTruthy();expect(finalVehicle.status).toBe('available');
  }finally{
   if(vehicle)await api(admin.cookie,`/api/logistics-intelligence/vehicles/${vehicle.id}`,{method:'PATCH',body:JSON.stringify({active:0,status:'out_of_service',notes:'Retired runtime certification fixture'})}).catch(()=>{});
   if(nonDriver)await api(admin.cookie,`/api/employees/${nonDriver.id}`,{method:'PUT',body:JSON.stringify({first_name:nonDriver.first_name,last_name:nonDriver.last_name,username:nonDriver.username,active:0,default_branch_id:branch.id,is_driver:false,must_change_password:false})}).catch(()=>{});
   if(driver)await api(admin.cookie,`/api/employees/${driver.id}`,{method:'PUT',body:JSON.stringify({first_name:driver.first_name,last_name:driver.last_name,username:driver.username,active:0,default_branch_id:branch.id,is_driver:true,must_change_password:false})}).catch(()=>{});
  }
 });
}
