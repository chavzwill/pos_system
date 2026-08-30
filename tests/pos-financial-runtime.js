import { test, expect } from '@playwright/test';

const BASE='http://localhost:3001';
async function login(username=process.env.POS_TEST_USER||'admin',password=process.env.POS_TEST_PASSWORD||'123456'){
  const r=await fetch(`${BASE}/api/employees/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
  expect(r.status).toBe(200);return {cookie:(r.headers.get('set-cookie')||'').split(';')[0],body:await r.json()};
}
async function api(cookie,path,options={}){const headers={Cookie:cookie,Accept:'application/json',...(options.headers||{})};if(options.body&&!headers['Content-Type'])headers['Content-Type']='application/json';const r=await fetch(`${BASE}${path}`,{...options,headers});return {status:r.status,body:await r.json().catch(()=>null)};}
const r2=v=>Number(Number(v||0).toFixed(2));

test.describe('POS financial runtime certification',()=>{
  test('cash sale, stock restoration, refund settlement and drawer custody remain coherent',async()=>{
    const admin=await login();
    const branches=await api(admin.cookie,'/api/branches');expect(branches.status).toBe(200);
    const branch=branches.body.find(b=>b.active!==0);test.skip(!branch,'Runtime POS certification requires an active branch');
    const suffix=`${Date.now()}${Math.random().toString(36).slice(2,6)}`;
    let product=null,drawer=null,group=null,employee=null,session=null;
    const username=`posrt_${suffix.slice(-12)}`,password=`Rt!${suffix}Aa1`,pin=String(Date.now()).slice(-6);
    try{
      let x=await api(admin.cookie,'/api/products',{method:'POST',body:JSON.stringify({sku:`RT-${suffix}`,name:`Runtime POS SKU ${suffix}`,price:100,cost:60,tax_rate:0,stock_qty:0,min_stock:0,active:1,branch_id:branch.id,taxable:1})});
      expect(x.status).toBe(201);product=x.body;
      x=await api(admin.cookie,`/api/products/${product.id}/stock`,{method:'PATCH',body:JSON.stringify({branch_id:branch.id,adjustment:2,reason:'Runtime POS financial certification'})});expect(x.status).toBe(200);
      x=await api(admin.cookie,'/api/drawers',{method:'POST',body:JSON.stringify({branch_id:branch.id,name:`Runtime Drawer ${suffix}`})});expect(x.status).toBe(201);drawer=x.body;
      x=await api(admin.cookie,'/api/security-groups',{method:'POST',body:JSON.stringify({name:`Runtime Cashier ${suffix}`,description:'Temporary POS financial runtime certification',reason:'Runtime POS financial certification',permissions:{pos:true,transactions_returns:true,transactions_refund:true,drawers_open:true,drawers_close:true}})});expect(x.status).toBe(201);group=x.body;
      x=await api(admin.cookie,'/api/employees',{method:'POST',body:JSON.stringify({first_name:'Runtime',last_name:'Cashier',username,password,pin,security_group_id:group.id,default_branch_id:branch.id,must_change_password:false})});expect(x.status).toBe(201);employee=x.body;
      const cashier=await login(username,password);
      x=await api(cashier.cookie,'/api/drawers/sessions',{method:'POST',body:JSON.stringify({drawer_id:drawer.id,opening_float:100})});expect([200,201]).toContain(x.status);session=x.body;

      const before=await api(cashier.cookie,`/api/products/${product.id}?branch_id=${branch.id}`);expect(before.status).toBe(200);expect(Number(before.body.branch_stock_qty)).toBe(2);
      const sale=await api(cashier.cookie,'/api/transactions',{method:'POST',body:JSON.stringify({branch_id:branch.id,drawer_session_id:session.id,items:[{product_id:product.id,quantity:1}],payment_method:'cash',amount_tendered:100,notes:'Runtime POS financial certification'})});
      expect(sale.status).toBe(201);expect(sale.body.status).toBe('completed');expect(sale.body.cost_evidence_captured).toBe(true);expect(r2(sale.body.total)).toBe(100);
      const transactionId=sale.body.id,transactionItemId=sale.body.items?.[0]?.id;expect(transactionItemId).toBeTruthy();
      const afterSale=await api(cashier.cookie,`/api/products/${product.id}?branch_id=${branch.id}`);expect(afterSale.status).toBe(200);expect(Number(afterSale.body.branch_stock_qty)).toBe(1);
      const txDetail=await api(cashier.cookie,`/api/transactions/${transactionId}`);expect(txDetail.status).toBe(200);expect(txDetail.body.drawer_session_id).toBe(session.id);expect(txDetail.body.payments?.some(p=>p.payment_method==='cash'&&r2(p.amount)===100)).toBe(true);

      const ret=await api(cashier.cookie,`/api/transactions/${transactionId}/return`,{method:'POST',body:JSON.stringify({resolution:'refund',items:[{transaction_item_id:transactionItemId,quantity:1}],notes:'Runtime full return'})});expect(ret.status).toBe(201);expect(r2(ret.body.allocation.external_refund_total)).toBe(100);
      const afterReturn=await api(cashier.cookie,`/api/products/${product.id}?branch_id=${branch.id}`);expect(afterReturn.status).toBe(200);expect(Number(afterReturn.body.branch_stock_qty)).toBe(2);
      const refund=await api(cashier.cookie,`/api/transactions/returns/${ret.body.id}/settle`,{method:'POST',body:JSON.stringify({drawer_session_id:session.id,tenders:[{method:'cash',amount:100}]})});expect(refund.status).toBe(201);expect(r2(refund.body.total)).toBe(100);expect(refund.body.drawer_session_id).toBe(session.id);

      const evidence=await api(cashier.cookie,`/api/drawers/sessions/${session.id}`);expect(evidence.status).toBe(200);const cash=evidence.body.net_tenders?.find(t=>t.payment_method==='cash');expect(cash).toBeTruthy();expect(r2(cash.gross_tender)).toBe(100);expect(r2(cash.refunds)).toBe(100);expect(r2(cash.net_movement)).toBe(0);expect(r2(evidence.body.cash_net_movement)).toBe(0);
      const close=await api(cashier.cookie,`/api/drawers/sessions/${session.id}/close`,{method:'PATCH',body:JSON.stringify({})});expect(close.status).toBe(200);
      const reconcile=await api(cashier.cookie,`/api/drawers/sessions/${session.id}/reconcile`,{method:'POST',body:JSON.stringify({cash_counted:100,card_counted:0,check_counted:0,gift_card_counted:0,credit_counted:0,direct_deposit_counted:0,notes:'Opening float restored after runtime sale/refund'})});expect(reconcile.status).toBe(200);expect(reconcile.body.status).toBe('reconciled');
    }finally{
      if(employee)await api(admin.cookie,`/api/employees/${employee.id}`,{method:'PUT',body:JSON.stringify({first_name:employee.first_name,last_name:employee.last_name,username,active:0,security_group_id:group?.id||null,default_branch_id:branch.id,must_change_password:false})});
      if(group)await api(admin.cookie,`/api/security-groups/${group.id}?reason=Runtime%20POS%20financial%20cleanup`,{method:'DELETE'});
      if(drawer)await api(admin.cookie,`/api/drawers/${drawer.id}`,{method:'DELETE'});
      if(product)await api(admin.cookie,`/api/products/${product.id}`,{method:'DELETE'});
    }
  });
});
