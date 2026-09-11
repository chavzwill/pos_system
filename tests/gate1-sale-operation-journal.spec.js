import { test, expect } from '@playwright/test';

const BASE='http://localhost:3001';
const body=JSON.stringify({branch_id:1,items:[{product_id:1,quantity:1}],payment_method:'cash',amount_tendered:100});

async function loadJournal(page){
  await page.goto(BASE,{waitUntil:'domcontentloaded'});
  await page.addScriptTag({url:`${BASE}/pos-sale-operation-journal.js`});
}

test.describe('Gate 1 browser sale operation journal',()=>{
  test('ambiguous transport retry and refresh reuse the same sale operation identity',async({page})=>{
    const keys=[];let calls=0;
    await page.route('**/api/transactions',async route=>{
      calls+=1;keys.push(route.request().headers()['idempotency-key']||null);
      if(calls===1)return route.abort('timedout');
      return route.fulfill({status:201,contentType:'application/json',body:JSON.stringify({id:901,transaction_number:'TXN-JOURNAL'})});
    });
    await loadJournal(page);
    await page.evaluate(async body=>{try{await fetch('/api/transactions',{method:'POST',headers:{'Content-Type':'application/json'},body})}catch(e){}},body);
    const pending=await page.evaluate(()=>window.TotalToolsSaleOperationJournal.peek());
    expect(pending?.key).toBeTruthy();
    expect(keys[0]).toBe(pending.key);

    await page.reload({waitUntil:'domcontentloaded'});
    await page.addScriptTag({url:`${BASE}/pos-sale-operation-journal.js`});
    const response=await page.evaluate(async body=>{const r=await fetch('/api/transactions',{method:'POST',headers:{'Content-Type':'application/json'},body});return {status:r.status,body:await r.json()};},body);
    expect(response.status).toBe(201);
    expect(keys[1]).toBe(keys[0]);
    expect(await page.evaluate(()=>window.TotalToolsSaleOperationJournal.peek())).toBeNull();
  });

  test('simultaneous identical browser submissions share one operation key and changed payload gets a new key',async({page})=>{
    const keys=[];
    await page.route('**/api/transactions',async route=>{
      keys.push(route.request().headers()['idempotency-key']||null);
      await new Promise(r=>setTimeout(r,25));
      return route.fulfill({status:201,contentType:'application/json',body:JSON.stringify({id:902,transaction_number:'TXN-CONCURRENT'})});
    });
    await loadJournal(page);
    await page.evaluate(async body=>{await Promise.all([fetch('/api/transactions',{method:'POST',headers:{'Content-Type':'application/json'},body}),fetch('/api/transactions',{method:'POST',headers:{'Content-Type':'application/json'},body})]);},body);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);

    const changed=JSON.stringify({branch_id:1,items:[{product_id:1,quantity:2}],payment_method:'cash',amount_tendered:200});
    await page.evaluate(async body=>{await fetch('/api/transactions',{method:'POST',headers:{'Content-Type':'application/json'},body});},changed);
    expect(keys[2]).toBeTruthy();
    expect(keys[2]).not.toBe(keys[0]);
  });
});
