import { expect, test } from '@playwright/test';

const BASE='http://localhost:3001';
const r2=v=>Number(Number(v||0).toFixed(2));
const SIG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
async function login(username=process.env.POS_TEST_USER||'admin',password=process.env.POS_TEST_PASSWORD||'123456'){
  const r=await fetch(`${BASE}/api/employees/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
  expect(r.status).toBe(200);return {cookie:(r.headers.get('set-cookie')||'').split(';')[0],body:await r.json()};
}
async function api(cookie,path,options={}){const headers={Cookie:cookie,Accept:'application/json',...(options.headers||{})};if(options.body&&!headers['Content-Type'])headers['Content-Type']='application/json';const r=await fetch(`${BASE}${path}`,{...options,headers});return {status:r.status,body:await r.json().catch(()=>null)};}
function line(detail,code){return detail.body?.lines?.find(x=>String(x.account_code)===String(code));}

export function registerRentalFinancialRuntimeCertification(){
  test('cash rental checkout, issue, return, refund payable and payout remain coherent',async()=>{
    const admin=await login();
    const branches=await api(admin.cookie,'/api/branches');expect(branches.status).toBe(200);
    const branch=branches.body.find(b=>b.active!==0);test.skip(!branch,'Rental runtime certification requires an active branch');
    const suffix=`${Date.now()}${Math.random().toString(36).slice(2,6)}`;
    const username=`rrt_${suffix.slice(-12)}`,password=`Rt!${suffix}Aa1`,pin=String(Date.now()).slice(-6);
    let product=null,customer=null,drawer=null,group=null,employee=null,session=null,agreement=null;
    try{
      let x=await api(admin.cookie,'/api/products',{method:'POST',body:JSON.stringify({sku:`RTR-${suffix}`,name:`Runtime Rental ${suffix}`,price:0,cost:250,tax_rate:0,stock_qty:1,min_stock:0,active:1,branch_id:branch.id,is_rental:1,rental_classification:'tool',rental_rate:50,rental_weekly_rate:0,rental_monthly_rate:0,rental_hourly_rate:0,replacement_value:250,taxable:1})});
      expect(x.status).toBe(201);product=x.body;

      x=await api(admin.cookie,'/api/customers',{method:'POST',body:JSON.stringify({first_name:'Runtime',last_name:`Rental ${suffix}`,phone:'8765550101',address:'1 Runtime Rental Road',city:'Kingston',state:'Kingston',customer_type:'cash',is_rental_customer:true,rental_id_type:'drivers_license',rental_id_number:`RT-${suffix}`,rental_address_proof_type:'utility_bill',rental_address_proof_details:'Runtime certification',rental_reference_name:'Runtime Reference',rental_reference_phone:'8765550102',rental_reference_relationship:'Reference'})});
      expect(x.status).toBe(201);customer=x.body;
      const form=new FormData();form.append('id_scan',new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64')],{type:'image/png'}),'runtime-id.png');
      let upload=await fetch(`${BASE}/api/customers/${customer.id}/id-scan`,{method:'POST',headers:{Cookie:admin.cookie},body:form});expect(upload.status).toBe(200);

      x=await api(admin.cookie,'/api/drawers',{method:'POST',body:JSON.stringify({branch_id:branch.id,name:`Runtime Rental Drawer ${suffix}`})});expect(x.status).toBe(201);drawer=x.body;
      x=await api(admin.cookie,'/api/security-groups',{method:'POST',body:JSON.stringify({name:`Runtime Rental Cashier ${suffix}`,description:'Temporary rental runtime certification',reason:'Rental runtime certification',permissions:{pos:true,rentals:true,rentals_checkout:true,rentals_issue:true,rentals_returns:true,transactions_refund:true,drawers_open:true,drawers_close:true}})});expect(x.status).toBe(201);group=x.body;
      x=await api(admin.cookie,'/api/employees',{method:'POST',body:JSON.stringify({first_name:'Runtime',last_name:'RentalCashier',username,password,pin,security_group_id:group.id,default_branch_id:branch.id,must_change_password:false})});expect(x.status).toBe(201);employee=x.body;
      const cashier=await login(username,password);
      x=await api(cashier.cookie,'/api/drawers/sessions',{method:'POST',body:JSON.stringify({drawer_id:drawer.id,opening_float:100})});expect([200,201]).toContain(x.status);session=x.body;

      const today=new Date().toISOString().slice(0,10);
      x=await api(cashier.cookie,'/api/rentals/agreements',{method:'POST',body:JSON.stringify({customer_id:customer.id,employee_id:employee.id,branch_id:branch.id,due_date:today,items:[{product_id:product.id,quantity:1,condition_out:'good'}],customer_pickup:true,notes:'Runtime rental financial certification'})});
      expect(x.status).toBe(201);agreement=x.body;expect(agreement.status).toBe('pending');

      const noDrawer=await api(cashier.cookie,`/api/rentals/agreements/${agreement.id}/checkout`,{method:'PATCH',body:JSON.stringify({payment_method:'cash',amount_tendered:100,employee_id:employee.id})});
      expect(noDrawer.status).toBe(409);expect(noDrawer.body?.control).toBe('rental_checkout_cash_drawer');

      x=await api(cashier.cookie,`/api/rentals/agreements/${agreement.id}/checkout`,{method:'PATCH',body:JSON.stringify({payment_method:'cash',amount_tendered:100,employee_id:employee.id,drawer_session_id:session.id})});
      expect(x.status).toBe(200);expect(x.body.status).toBe('awaiting_issue');expect(x.body.checkout_transaction_id).toBeTruthy();expect(r2(x.body.deposit_total)).toBeGreaterThan(0);
      const checkoutTxId=x.body.checkout_transaction_id,deposit=r2(x.body.deposit_total);

      let sync=await api(admin.cookie,'/api/accounting-source-sync/sync',{method:'POST',body:JSON.stringify({})});expect(sync.status).toBe(200);
      let journals=await api(admin.cookie,`/api/accounting-ledger/journals?branch_id=${branch.id}&limit=500`);expect(journals.status).toBe(200);
      const checkoutJournal=journals.body.find(j=>j.source_type==='rental_checkout'&&String(j.source_id)===String(checkoutTxId));expect(checkoutJournal).toBeTruthy();
      let detail=await api(admin.cookie,`/api/accounting-ledger/journals/${checkoutJournal.id}`);expect(detail.status).toBe(200);expect(r2(line(detail,'2200')?.credit)).toBe(deposit);expect(r2(detail.body.totals?.difference)).toBe(0);

      x=await api(cashier.cookie,`/api/rentals/agreements/${agreement.id}/issue`,{method:'PATCH',body:JSON.stringify({employee_id:employee.id,security_employee_id:employee.id,customer_signature:SIG,security_signature:SIG})});expect(x.status).toBe(200);expect(x.body.status).toBe('active');expect(x.body.issued_at).toBeTruthy();

      const item=x.body.items[0];
      x=await api(cashier.cookie,`/api/rentals/agreements/${agreement.id}/return`,{method:'PATCH',body:JSON.stringify({items:[{item_id:item.id,quantity_returned:1,condition_in:'good',damage_fee:0}],return_security_employee_id:employee.id,return_driver_employee_id:employee.id,security_signature:SIG})});
      expect(x.status).toBe(200);expect(x.body.status).toBe('returned');expect(x.body.settlement_transaction_id).toBeTruthy();
      const settlementTxId=x.body.settlement_transaction_id;
      const settlementTx=await api(cashier.cookie,`/api/transactions/${settlementTxId}`);expect(settlementTx.status).toBe(200);expect(Number(settlementTx.body.total)).toBeLessThan(0);
      const refundDue=r2(-settlementTx.body.total);expect(refundDue).toBeGreaterThan(0);

      sync=await api(admin.cookie,'/api/accounting-source-sync/sync',{method:'POST',body:JSON.stringify({})});expect(sync.status).toBe(200);
      journals=await api(admin.cookie,`/api/accounting-ledger/journals?branch_id=${branch.id}&limit=500`);expect(journals.status).toBe(200);
      const settleJournal=journals.body.find(j=>j.source_type==='rental_settlement'&&String(j.source_id)===String(settlementTxId));expect(settleJournal).toBeTruthy();
      detail=await api(admin.cookie,`/api/accounting-ledger/journals/${settleJournal.id}`);expect(detail.status).toBe(200);expect(r2(line(detail,'2200')?.debit)).toBe(deposit);expect(r2(line(detail,'2400')?.credit)).toBe(refundDue);expect(r2(detail.body.totals?.difference)).toBe(0);

      const payout=await api(cashier.cookie,`/api/rentals/agreements/${agreement.id}/refund-settle`,{method:'POST',body:JSON.stringify({payment_method:'cash',drawer_session_id:session.id})});expect(payout.status).toBe(201);expect(r2(payout.body.amount)).toBe(refundDue);
      journals=await api(admin.cookie,`/api/accounting-ledger/journals?branch_id=${branch.id}&limit=500`);const payoutJournal=journals.body.find(j=>j.source_type==='rental_refund_settlement'&&String(j.source_id)===String(payout.body.id));expect(payoutJournal).toBeTruthy();
      detail=await api(admin.cookie,`/api/accounting-ledger/journals/${payoutJournal.id}`);expect(r2(line(detail,'2400')?.debit)).toBe(refundDue);expect(r2(line(detail,'1000')?.credit)).toBe(refundDue);expect(r2(detail.body.totals?.difference)).toBe(0);

      const drawerEvidence=await api(cashier.cookie,`/api/drawers/sessions/${session.id}`);expect(drawerEvidence.status).toBe(200);expect(r2(drawerEvidence.body.cash_refunds)).toBeGreaterThanOrEqual(refundDue);
      const cash=drawerEvidence.body.net_tenders?.find(t=>t.payment_method==='cash');expect(cash).toBeTruthy();expect(r2(cash.refunds)).toBeGreaterThanOrEqual(refundDue);
    }finally{
      if(session&&session.status==='open')await api(admin.cookie,`/api/drawers/sessions/${session.id}/close`,{method:'PATCH',body:JSON.stringify({})}).catch(()=>{});
      if(employee)await api(admin.cookie,`/api/employees/${employee.id}`,{method:'PUT',body:JSON.stringify({first_name:employee.first_name,last_name:employee.last_name,username,active:0,security_group_id:group?.id||null,default_branch_id:branch.id,must_change_password:false})}).catch(()=>{});
      if(group)await api(admin.cookie,`/api/security-groups/${group.id}?reason=Rental%20runtime%20cleanup`,{method:'DELETE'}).catch(()=>{});
      if(drawer)await api(admin.cookie,`/api/drawers/${drawer.id}`,{method:'DELETE'}).catch(()=>{});
      if(customer){await api(admin.cookie,`/api/customers/${customer.id}/id-scan`,{method:'DELETE'}).catch(()=>{});await api(admin.cookie,`/api/customers/${customer.id}`,{method:'DELETE'}).catch(()=>{});}
      if(product)await api(admin.cookie,`/api/products/${product.id}`,{method:'DELETE'}).catch(()=>{});
    }
  });
}
