import { test, expect } from '@playwright/test';
import { TEST_BASE_URL as BASE, assertSafeMutationTarget } from './test-base-url.js';

const USER=process.env.POS_TEST_USER;
const PASSWORD=process.env.POS_TEST_PASSWORD;

async function login(){
  if(!USER||!PASSWORD) throw new Error('POS_TEST_USER and POS_TEST_PASSWORD are required for ledger certification');
  const r=await fetch(`${BASE}/api/employees/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:USER,password:PASSWORD})});
  expect(r.status).toBe(200);
  return {cookie:(r.headers.get('set-cookie')||'').split(';')[0],body:await r.json()};
}
async function api(cookie,path,options={}){
  const headers={Cookie:cookie,Accept:'application/json',...(options.headers||{})};
  if(options.body&&!headers['Content-Type'])headers['Content-Type']='application/json';
  const r=await fetch(`${BASE}${path}`,{...options,headers});
  return {status:r.status,body:await r.json().catch(()=>null)};
}
const money=v=>Number(Number(v||0).toFixed(2));
function row(tb,code){return tb.rows.find(x=>String(x.code)===String(code));}

test.describe('Accounting ledger reconciliation integrity',()=>{
  test.beforeAll(()=>assertSafeMutationTarget());

  test('trial balance contains posted in-period evidence only and reversals restore balances',async()=>{
    const auth=await login();
    const accounts=await api(auth.cookie,'/api/accounting-ledger/accounts');
    expect(accounts.status).toBe(200);
    const cash=accounts.body.find(x=>x.code==='1000');
    const sales=accounts.body.find(x=>x.code==='4000');
    expect(cash).toBeTruthy();expect(sales).toBeTruthy();

    const today=new Date().toISOString().slice(0,10);
    const baseline=await api(auth.cookie,`/api/accounting-ledger/trial-balance/report?end=${today}`);
    expect(baseline.status).toBe(200);
    expect(money(baseline.body.totals.difference)).toBe(0);
    const baseCash=money(row(baseline.body,'1000')?.debit||0);
    const baseSales=money(row(baseline.body,'4000')?.credit||0);

    const amount=17.31;
    const draft=await api(auth.cookie,'/api/accounting-ledger/journals',{
      method:'POST',body:JSON.stringify({entry_date:today,description:'Runtime draft exclusion certification',lines:[
        {ledger_account_id:cash.id,debit:amount,credit:0,description:'Certification debit'},
        {ledger_account_id:sales.id,debit:0,credit:amount,description:'Certification credit'},
      ]})
    });
    expect(draft.status).toBe(201);

    const afterDraft=await api(auth.cookie,`/api/accounting-ledger/trial-balance/report?end=${today}`);
    expect(afterDraft.status).toBe(200);
    expect(money(row(afterDraft.body,'1000')?.debit||0)).toBe(baseCash);
    expect(money(row(afterDraft.body,'4000')?.credit||0)).toBe(baseSales);
    expect(money(afterDraft.body.totals.difference)).toBe(0);

    const posted=await api(auth.cookie,`/api/accounting-ledger/journals/${draft.body.id}/post`,{method:'POST',body:'{}'});
    expect(posted.status).toBe(200);
    const afterPost=await api(auth.cookie,`/api/accounting-ledger/trial-balance/report?end=${today}`);
    expect(afterPost.status).toBe(200);
    expect(money(row(afterPost.body,'1000')?.debit||0)).toBe(money(baseCash+amount));
    expect(money(row(afterPost.body,'4000')?.credit||0)).toBe(money(baseSales+amount));
    expect(money(afterPost.body.totals.difference)).toBe(0);

    const reversed=await api(auth.cookie,`/api/accounting-ledger/journals/${draft.body.id}/reverse`,{method:'POST',body:JSON.stringify({entry_date:today})});
    expect(reversed.status).toBe(201);
    const afterReverse=await api(auth.cookie,`/api/accounting-ledger/trial-balance/report?end=${today}`);
    expect(afterReverse.status).toBe(200);
    expect(money(row(afterReverse.body,'1000')?.debit||0)-money(row(afterReverse.body,'1000')?.credit||0)).toBe(money(baseCash-money(row(baseline.body,'1000')?.credit||0));
    expect(money(row(afterReverse.body,'4000')?.credit||0)-money(row(afterReverse.body,'4000')?.debit||0)).toBe(money(baseSales-money(row(baseline.body,'4000')?.debit||0));
    expect(money(afterReverse.body.totals.difference)).toBe(0);

    const future='2099-12-31';
    const futureDraft=await api(auth.cookie,'/api/accounting-ledger/journals',{
      method:'POST',body:JSON.stringify({entry_date:future,description:'Runtime future-period exclusion certification',lines:[
        {ledger_account_id:cash.id,debit:23.47,credit:0},
        {ledger_account_id:sales.id,debit:0,credit:23.47},
      ]})
    });
    expect(futureDraft.status).toBe(201);
    expect((await api(auth.cookie,`/api/accounting-ledger/journals/${futureDraft.body.id}/post`,{method:'POST',body:'{}'})).status).toBe(200);
    const currentPeriod=await api(auth.cookie,`/api/accounting-ledger/trial-balance/report?end=${today}`);
    expect(currentPeriod.status).toBe(200);
    expect(money(currentPeriod.body.totals.difference)).toBe(0);
    expect(money(row(currentPeriod.body,'1000')?.debit||0)-money(row(currentPeriod.body,'1000')?.credit||0)).toBe(money(row(afterReverse.body,'1000')?.debit||0)-money(row(afterReverse.body,'1000')?.credit||0));
    expect((await api(auth.cookie,`/api/accounting-ledger/journals/${futureDraft.body.id}/reverse`,{method:'POST',body:JSON.stringify({entry_date:future})})).status).toBe(201);
  });
});
