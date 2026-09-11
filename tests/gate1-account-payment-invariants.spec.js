const {test,expect}=require('@playwright/test');
const {db}=require('../database');

const BASE='http://localhost:3001';
async function login(){const r=await fetch(`${BASE}/api/employees/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:process.env.POS_TEST_USER||'admin',password:process.env.POS_TEST_PASSWORD||'123456'})});expect(r.status).toBe(200);return (r.headers.get('set-cookie')||'').split(';')[0];}
async function api(cookie,path,options={}){const headers={Cookie:cookie,Accept:'application/json',...(options.headers||{})};if(options.body&&!headers['Content-Type'])headers['Content-Type']='application/json';const r=await fetch(`${BASE}${path}`,{...options,headers});return {status:r.status,body:await r.json().catch(()=>null)};}

async function creditFixture(cookie,suffix,price=0.13){
  const branches=await api(cookie,'/api/branches');expect(branches.status).toBe(200);const branch=branches.body.find(b=>b.active!==0);test.skip(!branch,'Requires active branch');
  const c=await api(cookie,'/api/customers',{method:'POST',body:JSON.stringify({first_name:'Gate1',last_name:`Pay${suffix}`,customer_type:'credit',credit_limit:1000,credit_terms_days:30})});expect(c.status,JSON.stringify(c.body)).toBe(201);
  const p=await api(cookie,'/api/products',{method:'POST',body:JSON.stringify({sku:`PAY-${suffix}`,name:`Payment invariant ${suffix}`,price,cost:0,tax_rate:0,stock_qty:0,min_stock:0,active:1,branch_id:branch.id,taxable:0})});expect(p.status,JSON.stringify(p.body)).toBe(201);
  const st=await api(cookie,`/api/products/${p.body.id}/stock`,{method:'PATCH',body:JSON.stringify({branch_id:branch.id,adjustment:2,reason:'Gate 1 account payment certification'})});expect(st.status).toBe(200);
  const sale=await api(cookie,'/api/transactions',{method:'POST',headers:{'Idempotency-Key':`acct-sale-${suffix}`},body:JSON.stringify({branch_id:branch.id,customer_id:c.body.id,items:[{product_id:p.body.id,quantity:1}],payment_method:'credit',amount_tendered:0,notes:'Gate 1 account payment certification'})});expect(sale.status,JSON.stringify(sale.body)).toBe(201);
  return {branch,customer:c.body,product:p.body,sale:sale.body};
}

test.describe('Gate 1 account payment invariants',()=>{
  test('sub-cent payment and under-allocation fail without changing receivable',async()=>{
    const cookie=await login(),suffix=`${Date.now()}a`;const fx=await creditFixture(cookie,suffix,0.13);
    let c=await api(cookie,`/api/customers/${fx.customer.id}`);expect(Number(c.body.account_balance)).toBe(0.13);
    const sub=await api(cookie,'/api/accounts/payments',{method:'POST',body:JSON.stringify({customer_id:fx.customer.id,amount:0.005,payment_method:'cash'})});expect(sub.status).toBe(400);expect(sub.body?.code).toBe('ACCOUNT_PAYMENT_AMOUNT_MUST_HAVE_CENT_PRECISION');
    const under=await api(cookie,'/api/accounts/payments',{method:'POST',body:JSON.stringify({customer_id:fx.customer.id,amount:0.10,payment_method:'cash',allocations:[{transaction_id:fx.sale.id,amount:0.05}]})});expect(under.status).toBe(409);expect(String(under.body?.error||'')).toMatch(/ALLOCATIONS_MUST_EQUAL_PAYMENT/);
    c=await api(cookie,`/api/customers/${fx.customer.id}`);expect(Number(c.body.account_balance)).toBe(0.13);
    const {rows}=await db.execute({sql:'SELECT * FROM account_payments WHERE customer_id=?',args:[fx.customer.id]});expect(rows).toHaveLength(0);
  });

  test('two simultaneous full payments cannot both consume one receivable',async()=>{
    const cookie=await login(),suffix=`${Date.now()}b`;const fx=await creditFixture(cookie,suffix,0.13);
    const body=JSON.stringify({customer_id:fx.customer.id,amount:0.13,payment_method:'cash',allocations:[{transaction_id:fx.sale.id,amount:0.13}]});
    const [a,b]=await Promise.all([api(cookie,'/api/accounts/payments',{method:'POST',body}),api(cookie,'/api/accounts/payments',{method:'POST',body})]);
    expect([a.status,b.status].filter(s=>s===201)).toHaveLength(1);expect([a.status,b.status].filter(s=>s!==201)).toHaveLength(1);
    const c=await api(cookie,`/api/customers/${fx.customer.id}`);expect(Number(c.body.account_balance)).toBe(0);
    const {rows:payments}=await db.execute({sql:'SELECT * FROM account_payments WHERE customer_id=?',args:[fx.customer.id]});expect(payments).toHaveLength(1);expect(Number(payments[0].amount)).toBe(0.13);
    const {rows:allocs}=await db.execute({sql:'SELECT * FROM payment_allocations WHERE transaction_id=?',args:[fx.sale.id]});expect(allocs).toHaveLength(1);expect(Number(allocs[0].amount)).toBe(0.13);
  });

  test('database authority rejects sub-cent money and cross-customer allocation',async()=>{
    const cookie=await login(),suffix=`${Date.now()}c`;const first=await creditFixture(cookie,`${suffix}1`,1);const second=await creditFixture(cookie,`${suffix}2`,1);
    // Initialize the payment invariant triggers through the live route without committing money.
    await api(cookie,'/api/accounts/payments',{method:'POST',body:JSON.stringify({customer_id:first.customer.id,amount:0.001})});
    let err=null;try{await db.execute({sql:`INSERT INTO account_payments(payment_number,customer_id,amount,payment_method) VALUES(?,?,0.001,'cash')`,args:[`DB-SUB-${suffix}`,first.customer.id]});}catch(e){err=e;}expect(String(err?.message||err)).toMatch(/ACCOUNT_PAYMENT_AMOUNT_MUST_HAVE_CENT_PRECISION/);
    const inserted=await db.execute({sql:`INSERT INTO account_payments(payment_number,customer_id,amount,payment_method) VALUES(?,?,1,'cash')`,args:[`DB-LINE-${suffix}`,first.customer.id]});
    err=null;try{await db.execute({sql:'INSERT INTO payment_allocations(payment_id,transaction_id,amount) VALUES(?,?,1)',args:[Number(inserted.lastInsertRowid),second.sale.id]});}catch(e){err=e;}expect(String(err?.message||err)).toMatch(/ACCOUNT_PAYMENT_CUSTOMER_LINEAGE_MISMATCH/);
  });
});
