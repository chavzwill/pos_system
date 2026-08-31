import { expect, test } from '@playwright/test';

const BASE='http://localhost:3001';
const r2=v=>Number(Number(v||0).toFixed(2));
async function login(username=process.env.POS_TEST_USER||'admin',password=process.env.POS_TEST_PASSWORD||'123456'){
  const r=await fetch(`${BASE}/api/employees/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
  expect(r.status).toBe(200);return {cookie:(r.headers.get('set-cookie')||'').split(';')[0],body:await r.json()};
}
async function api(cookie,path,options={}){const headers={Cookie:cookie,Accept:'application/json',...(options.headers||{})};if(options.body&&!headers['Content-Type'])headers['Content-Type']='application/json';const r=await fetch(`${BASE}${path}`,{...options,headers});return {status:r.status,body:await r.json().catch(()=>null)};}
function line(detail,code){return detail.body?.lines?.find(x=>String(x.account_code)===String(code));}

export function registerRepairFinancialRuntimeCertification(){
  test('repair intake, cash custody, technician evidence, QC, release and accounting remain coherent',async()=>{
    const admin=await login();
    const branches=await api(admin.cookie,'/api/branches');expect(branches.status).toBe(200);
    const branch=branches.body.find(b=>b.active!==0);test.skip(!branch,'Repair runtime certification requires an active branch');
    const suffix=`${Date.now()}${Math.random().toString(36).slice(2,6)}`;
    const username=`wrt_${suffix.slice(-12)}`,password=`Wr!${suffix}Aa1`,pin=String(Date.now()).slice(-6);
    let customer=null,equipment=null,drawer=null,group=null,employee=null,session=null,wo=null;
    try{
      let x=await api(admin.cookie,'/api/customers',{method:'POST',body:JSON.stringify({first_name:'Runtime',last_name:`Repair ${suffix}`,phone:'8765550201',address:'2 Runtime Repair Road',city:'Kingston',state:'Kingston',customer_type:'cash'})});
      expect(x.status).toBe(201);customer=x.body;
      x=await api(admin.cookie,'/api/repair-operations/equipment',{method:'POST',body:JSON.stringify({customer_id:customer.id,branch_id:branch.id,equipment_type:'Runtime Test Tool',brand:'Runtime',model:'Certification',serial_number:`RTWO-${suffix}`,notes:'Repair runtime certification asset'})});
      expect(x.status).toBe(201);equipment=x.body;

      x=await api(admin.cookie,'/api/drawers',{method:'POST',body:JSON.stringify({branch_id:branch.id,name:`Runtime Repair Drawer ${suffix}`})});expect(x.status).toBe(201);drawer=x.body;
      x=await api(admin.cookie,'/api/security-groups',{method:'POST',body:JSON.stringify({name:`Runtime Repair Operator ${suffix}`,description:'Temporary repair runtime certification',reason:'Repair runtime certification',permissions:{pos:true,work_orders:true,wo_intake:true,wo_assess:true,wo_technician:true,wo_signoff:true,drawers_open:true,drawers_close:true}})});expect(x.status).toBe(201);group=x.body;
      x=await api(admin.cookie,'/api/employees',{method:'POST',body:JSON.stringify({first_name:'Runtime',last_name:'RepairOperator',username,password,pin,security_group_id:group.id,default_branch_id:branch.id,must_change_password:false})});expect(x.status).toBe(201);employee=x.body;
      const operator=await login(username,password);
      x=await api(operator.cookie,'/api/drawers/sessions',{method:'POST',body:JSON.stringify({drawer_id:drawer.id,opening_float:100})});expect([200,201]).toContain(x.status);session=x.body;

      x=await api(operator.cookie,'/api/work-orders',{method:'POST',body:JSON.stringify({customer_id:customer.id,employee_id:employee.id,branch_id:branch.id,description:'Runtime repair certification issue',item_label:'Runtime Test Tool'})});
      expect(x.status).toBe(201);wo=x.body;expect(wo.status).toBe('intake');
      x=await api(operator.cookie,`/api/repair-operations/work-orders/${wo.id}/equipment`,{method:'PUT',body:JSON.stringify({equipment_id:equipment.id,intake_condition:'good',reported_issue:'Runtime certification fault',warranty_claim:false})});expect(x.status).toBe(200);expect(Number(x.body.equipment_id)).toBe(Number(equipment.id));

      const assessment=r2(wo.assessment_fee);
      if(assessment>0){const blocked=await api(operator.cookie,`/api/work-orders/${wo.id}/assessment-paid`,{method:'PATCH',body:JSON.stringify({payment_method:'cash',amount_tendered:assessment,employee_id:employee.id})});expect(blocked.status).toBe(409);expect(blocked.body?.control).toBe('work_order_cash_drawer');}
      x=await api(operator.cookie,`/api/work-orders/${wo.id}/assessment-paid`,{method:'PATCH',body:JSON.stringify({payment_method:'cash',amount_tendered:assessment,employee_id:employee.id,drawer_session_id:session.id})});expect(x.status).toBe(200);expect(x.body.status).toBe('assessed');

      x=await api(operator.cookie,`/api/work-orders/${wo.id}/estimate`,{method:'PATCH',body:JSON.stringify({estimate_labor:200,estimate_consumables:0,estimate_notes:'Runtime verified service estimate',deposit_amount:100,employee_id:employee.id})});expect(x.status).toBe(200);expect(x.body.status).toBe('pending_deposit');
      let blocked=await api(operator.cookie,`/api/work-orders/${wo.id}/deposit-paid`,{method:'PATCH',body:JSON.stringify({payment_method:'cash',amount_tendered:100,employee_id:employee.id})});expect(blocked.status).toBe(409);expect(blocked.body?.control).toBe('work_order_cash_drawer');
      x=await api(operator.cookie,`/api/work-orders/${wo.id}/deposit-paid`,{method:'PATCH',body:JSON.stringify({payment_method:'cash',amount_tendered:100,employee_id:employee.id,drawer_session_id:session.id})});expect(x.status).toBe(200);expect(x.body.status).toBe('in_progress');

      x=await api(operator.cookie,`/api/work-orders/${wo.id}/service-evidence`,{method:'PATCH',body:JSON.stringify({diagnosis:'Runtime diagnostic evidence confirms a controlled test fault.',repair_notes:'Runtime repair evidence confirms corrective service and verification.'})});expect(x.status).toBe(200);expect(x.body.diagnosis).toContain('Runtime diagnostic evidence');
      x=await api(operator.cookie,`/api/work-orders/${wo.id}/tasks`,{method:'POST',body:JSON.stringify({description:'Perform runtime certified corrective service',allotted_minutes:15,technician_id:employee.id})});expect(x.status).toBe(201);const task=x.body;
      x=await api(operator.cookie,`/api/work-orders/tasks/${task.id}`,{method:'PATCH',body:JSON.stringify({technician_id:employee.id,status:'complete'})});expect(x.status).toBe(200);expect(x.body.status).toBe('complete');

      x=await api(operator.cookie,`/api/repair-quality/work-orders/${wo.id}/qc`,{method:'POST',body:JSON.stringify({result:'pass',technician_id:employee.id,checklist:{functional_test:true,safety_check:true},note:'Runtime QC passed'})});expect(x.status).toBe(201);expect(x.body.result).toBe('pass');
      x=await api(operator.cookie,`/api/work-orders/${wo.id}/signoff`,{method:'PATCH',body:JSON.stringify({employee_id:employee.id,comment:'Runtime signoff after QC'})});expect(x.status).toBe(200);expect(x.body.status).toBe('complete');expect(x.body.completion_integrity?.latest_qc_review_id).toBeTruthy();
      x=await api(operator.cookie,`/api/work-orders/${wo.id}/notify`,{method:'PATCH',body:JSON.stringify({notification_method:'phone',employee_id:employee.id})});expect(x.status).toBe(200);expect(x.body.status).toBe('awaiting_pickup');

      blocked=await api(operator.cookie,`/api/work-orders/${wo.id}/final-payment`,{method:'PATCH',body:JSON.stringify({payment_method:'cash',amount_tendered:100,employee_id:employee.id})});expect(blocked.status).toBe(409);expect(blocked.body?.control).toBe('work_order_cash_drawer');
      x=await api(operator.cookie,`/api/work-orders/${wo.id}/final-payment`,{method:'PATCH',body:JSON.stringify({payment_method:'cash',amount_tendered:100,employee_id:employee.id,drawer_session_id:session.id})});expect(x.status).toBe(200);expect(x.body.status).toBe('picked_up');

      const detail=await api(operator.cookie,`/api/work-orders/${wo.id}`);expect(detail.status).toBe(200);expect(detail.body.assessment_transaction_id).toBeTruthy();expect(detail.body.deposit_transaction_id).toBeTruthy();expect(detail.body.final_transaction_id).toBeTruthy();
      const assessmentTxId=detail.body.assessment_transaction_id,depositTxId=detail.body.deposit_transaction_id,finalTxId=detail.body.final_transaction_id;

      const sync=await api(admin.cookie,'/api/accounting-source-sync/sync',{method:'POST',body:JSON.stringify({})});expect(sync.status).toBe(200);
      const journals=await api(admin.cookie,`/api/accounting-ledger/journals?branch_id=${branch.id}&limit=500`);expect(journals.status).toBe(200);
      const assessmentJournal=journals.body.find(j=>j.source_type==='repair_assessment'&&String(j.source_id)===String(assessmentTxId));
      if(assessment>0){expect(assessmentJournal).toBeTruthy();const d=await api(admin.cookie,`/api/accounting-ledger/journals/${assessmentJournal.id}`);expect(r2(line(d,'4100')?.credit)).toBe(assessment);expect(r2(d.body.totals?.difference)).toBe(0);}
      const depositJournal=journals.body.find(j=>j.source_type==='repair_deposit'&&String(j.source_id)===String(depositTxId));expect(depositJournal).toBeTruthy();
      let jd=await api(admin.cookie,`/api/accounting-ledger/journals/${depositJournal.id}`);expect(r2(line(jd,'2200')?.credit)).toBe(100);expect(r2(jd.body.totals?.difference)).toBe(0);
      const serviceJournal=journals.body.find(j=>j.source_type==='repair_service'&&String(j.source_id)===String(wo.id));expect(serviceJournal).toBeTruthy();
      jd=await api(admin.cookie,`/api/accounting-ledger/journals/${serviceJournal.id}`);expect(r2(line(jd,'2200')?.debit)).toBe(100);expect(r2(line(jd,'1100')?.debit)).toBe(100);expect(r2(line(jd,'4100')?.credit)).toBe(200);expect(r2(jd.body.totals?.difference)).toBe(0);
      const finalJournal=journals.body.find(j=>j.source_type==='repair_final_payment'&&String(j.source_id)===String(finalTxId));expect(finalJournal).toBeTruthy();
      jd=await api(admin.cookie,`/api/accounting-ledger/journals/${finalJournal.id}`);expect(r2(line(jd,'1000')?.debit)).toBe(100);expect(r2(line(jd,'1100')?.credit)).toBe(100);expect(r2(jd.body.totals?.difference)).toBe(0);

      const history=await api(operator.cookie,`/api/repair-operations/equipment/${equipment.id}/history`);expect(history.status).toBe(200);expect(history.body.repairs.some(r=>Number(r.id)===Number(wo.id)&&r.status==='picked_up')).toBe(true);
      const drawerEvidence=await api(operator.cookie,`/api/drawers/sessions/${session.id}`);expect(drawerEvidence.status).toBe(200);const cash=drawerEvidence.body.net_tenders?.find(t=>t.payment_method==='cash');expect(cash).toBeTruthy();expect(r2(cash.gross_tender)).toBeGreaterThanOrEqual(r2(assessment+200));
    }finally{
      if(session&&session.status==='open')await api(admin.cookie,`/api/drawers/sessions/${session.id}/close`,{method:'PATCH',body:JSON.stringify({})}).catch(()=>{});
      if(employee)await api(admin.cookie,`/api/employees/${employee.id}`,{method:'PUT',body:JSON.stringify({first_name:employee.first_name,last_name:employee.last_name,username,active:0,security_group_id:group?.id||null,default_branch_id:branch.id,must_change_password:false})}).catch(()=>{});
      if(group)await api(admin.cookie,`/api/security-groups/${group.id}?reason=Repair%20runtime%20cleanup`,{method:'DELETE'}).catch(()=>{});
      if(drawer)await api(admin.cookie,`/api/drawers/${drawer.id}`,{method:'DELETE'}).catch(()=>{});
      if(equipment)await api(admin.cookie,`/api/repair-operations/equipment/${equipment.id}`,{method:'PATCH',body:JSON.stringify({active:0})}).catch(()=>{});
      if(customer)await api(admin.cookie,`/api/customers/${customer.id}`,{method:'DELETE'}).catch(()=>{});
    }
  });
}
