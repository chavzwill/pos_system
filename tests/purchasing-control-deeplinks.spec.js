const {test,expect}=require('@playwright/test');
const fs=require('fs');
const vm=require('vm');

const invoiceInfo={po:{id:1,po_number:'PO-100'},can_capture:false,can_post:false,captured_invoices:[{id:9,invoice_number:'CAP-9',subtotal:100,allocated_cents:0},{id:10,invoice_number:'CAP-10',subtotal:100,allocated_cents:0}],invoices:[{id:9,invoice_number:'POST-9',subtotal:100},{id:12,invoice_number:'POST-12',subtotal:100}],links:[],captured_links:[],receipt_items:[{receipt_id:11,receipt_item_id:21,receipt_number:'GR-11',product_name:'Hammer',sku:'HAM',remaining_qty:3,quantity_received:3,unit_cost:20}]};
const returnInfo={po:{id:1,po_number:'PO-100'},permissions:{request:true,approve:true,finance:true},receipt_items:[{receipt_item_id:21,receipt_id:11,receipt_number:'GR-11',product_name:'Hammer',sku:'HAM',received_quantity:3,returnable_quantity:3,tracking_mode:'none',eligible:true,base_uom:'ea'}],returns:[5,6].map(id=>({id,return_number:'SR-'+id,status:'dispatched',requested_by_employee_id:2,reason_code:'damaged',resolution:'credit'}))};
const credits=[{id:8,return_id:5,credit_number:'CN-8',status:'posted',total_cents:10000,available_cents:5000},{id:9,return_id:6,credit_number:'CN-9',status:'posted',total_cents:20000,available_cents:15000}];

test('hold readmodel scopes PO and branch and subtracts immutable return consumption when installed',async()=>{
 const {createClient}=require('@libsql/client');
 const db=createClient({url:'file::memory:'});
 try{
  await db.batch([
   'CREATE TABLE purchase_receipt_quality_holds(id INTEGER,receipt_item_id INTEGER,product_id INTEGER,branch_id INTEGER,quantity REAL,status TEXT)',
   'CREATE TABLE purchase_receipt_items(id INTEGER,receipt_id INTEGER,po_item_id INTEGER)',
   'CREATE TABLE purchase_receipts(id INTEGER,po_id INTEGER,receipt_number TEXT)',
   'CREATE TABLE products(id INTEGER,name TEXT,sku TEXT)',
   "INSERT INTO products VALUES(1,'Hammer','HAM')",
   "INSERT INTO purchase_receipts VALUES(11,1,'GR-11'),(12,2,'GR-12')",
   'INSERT INTO purchase_receipt_items VALUES(21,11,31),(22,12,32)',
   "INSERT INTO purchase_receipt_quality_holds VALUES(77,21,1,4,5,'inspection'),(78,22,1,4,7,'inspection'),(79,21,1,9,8,'inspection')"
  ],'write');
  const source=fs.readFileSync('routes/purchase-receiving-review.js','utf8');
  const helper=source.slice(source.indexOf('async function qualityHoldsFor('),source.indexOf("router.get('/orders/:id'"));
  const qualityHoldsFor=vm.runInNewContext(helper+';qualityHoldsFor',{sql:(sql,args=[])=>({sql,args})});
  let holds=await qualityHoldsFor(db,{id:1,branch_id:4});
  expect(holds.map(h=>Number(h.id))).toEqual([77]);
  expect(holds[0]).toMatchObject({receipt_number:'GR-11',original_quantity:5,returned_quantity:0,remaining_quantity:5});
  await db.execute('CREATE TABLE supplier_return_hold_consumptions(hold_id INTEGER,quantity REAL)');
  await db.execute('INSERT INTO supplier_return_hold_consumptions VALUES(77,1.25),(77,0.75),(78,3)');
  holds=await qualityHoldsFor(db,{id:1,branch_id:4});
  expect(holds[0]).toMatchObject({original_quantity:5,returned_quantity:2,remaining_quantity:3});
  const guardSource=source.slice(source.indexOf('function guard('),source.indexOf('async function order('));
  const guard=vm.runInNewContext(guardSource+';guard',{can:(permissions,key)=>!!permissions?.[key],fail:(code,message,status)=>{throw Object.assign(new Error(message),{code,status});}});
  expect(()=>guard({employee:{permissions:{}}},{branch_id:4})).toThrow('assigned matching branch');
  expect(()=>guard({employee:{default_branch_id:9,permissions:{}}},{branch_id:4})).toThrow('assigned matching branch');
  expect(()=>guard({employee:{default_branch_id:4,permissions:{}}},{branch_id:4})).not.toThrow();
  expect(()=>guard({employee:{permissions:{branches:true}}},{branch_id:4})).not.toThrow();
 }finally{db.close();}
});

const holdInfo={id:77,receipt_item_id:21,receipt_id:11,po_item_id:32,receipt_number:'GR-11',product_name:'Held hammer',sku:'HAM',quantity:5,original_quantity:5,returned_quantity:2,remaining_quantity:3,status:'inspection',reason:'Inspect cracked handles'};
async function mount(page,module,saved={},options={}){
 const requests=[];
 await page.route('http://control-target.test/**',route=>{
  const path=new URL(route.request().url()).pathname;requests.push(path);
  if(path==='/api/workspace-profile/me')return route.fulfill({json:{permissions:options.permissions||{}}});
  if(path==='/api/purchase-orders/receiving-controls/review/orders/1')return route.fulfill({json:{po:{id:1,po_number:'PO-100',status:'partial'},discrepancies:[],price_proposals:[],quality_holds:options.holds||[],lines:[21,32,43,54,65,77].map(line_id=>({line_id,product_name:'Review item '+line_id,quantity_ordered:3,quantity_received:1,backorder_qty:2}))}});
  if(path.includes('/invoice-receipts/orders/'))return route.fulfill({json:invoiceInfo});
  if(path==='/api/supplier-returns/orders/1')return route.fulfill({json:returnInfo});
  if(/^\/api\/supplier-returns\/[56]\/replacements$/.test(path))return route.fulfill({json:{replacements:[],candidate_receipts:[]}});
  if(/^\/api\/supplier-returns\/[56]$/.test(path)){const id=Number(path.split('/').at(-1));return route.fulfill({json:{...returnInfo.returns.find(r=>r.id===id),reason_detail:'Evidence for return '+id,items:[{id:id*10,receipt_item_id:21,product_name:'Hammer',quantity:1,source_status:'available'}],events:[]}});}
  if(path==='/api/supplier-ledger/credit-notes')return route.fulfill({json:{credit_notes:credits}});
  if(path==='/api/supplier-ledger/credit-notes/source-invoices')return route.fulfill({json:{invoices:[{id:12,invoice_number:'POST-12',purchase_order_id:1,status:'posted',total:100,balance_due:50}],allocations:[]}});
  if(/^\/api\/supplier-ledger\/credit-notes\/[89]$/.test(path)){const id=Number(path.split('/').at(-1));return route.fulfill({json:{...credits.find(c=>c.id===id),items:[{return_item_id:id===8?50:60,quantity:1,unit_credit_cents:1200,line_cents:1200}],events:[]}});}
  if(path.startsWith('/api/'))return route.fulfill({status:404,json:{error:'Unmocked '+path}});
  return route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>'});
 });
 await page.goto('http://control-target.test/');
 for(const file of ['ui-tokens.css','ui-workspaces.css'])await page.addStyleTag({content:fs.readFileSync('public/'+file,'utf8')});
 await page.evaluate(initial=>{const drafts=structuredClone(initial);window.__TT_WORKSPACE_PROFILE__={employee:{id:1},permissions:{reports_financial:true}};window.TotalToolsWorkProtection={ready:async()=>{},take:key=>drafts[key],put:(key,value)=>drafts[key]=structuredClone(value),checkpoint:async()=>{},watch:()=>{}};},saved);
 await page.addScriptTag({path:'public/'+module});
 return requests;
}

for(const target of [{recordId:9,kind:'captured_invoice',value:'capture-9'},{recordId:9,kind:'posted_invoice',value:'9'},{recordId:12,kind:'posted_invoice',value:'12'}])test('invoice target selects exact '+target.kind+' '+target.recordId,async({page})=>{
 await mount(page,'purchase-invoice-receipt-ui.js');
 await page.evaluate(target=>TotalToolsInvoiceReceiptMatching.open(1,target),target);
 await expect(page.locator('#tt-ir-invoice')).toHaveValue(target.value);
});

test('stale invoice target reports unavailable without selecting another invoice',async({page})=>{
 await mount(page,'purchase-invoice-receipt-ui.js');
 expect(await page.evaluate(()=>TotalToolsInvoiceReceiptMatching.open(1,{recordId:404,kind:'captured_invoice'}))).toBe(false);
 await expect(page.locator('.tt-ir__status')).toContainText('requested invoice is no longer available');
 await expect(page.locator('#tt-ir-invoice')).toHaveCount(0);
});

test('unbilled receipt target ID collision does not select an unrelated posted invoice',async({page})=>{
 await mount(page,'purchase-invoice-receipt-ui.js');
 await page.evaluate(()=>TotalToolsInvoiceReceiptMatching.open(1,{recordId:9,kind:'unbilled_receipt'}));
 await expect(page.getByRole('dialog')).toBeVisible();
 await expect(page.locator('#tt-ir-invoice')).toHaveValue('');
 await expect(page.locator('.tt-ir__status')).not.toContainText('no longer available');
});

test('receiving review focuses the PO item line rather than the exception record ID',async({page})=>{
 await page.setViewportSize({width:1000,height:600});
 await mount(page,'purchase-receiving-review-ui.js');
 await page.evaluate(()=>TotalToolsReceivingReview.open(1,{recordId:21,lineId:77}));
 const target=page.locator('[data-review-line="77"]');
 await expect(target).toBeFocused();
 await expect(target).toContainText('Review item 77');
 await expect(target).toBeInViewport();
 await expect(page.locator('[data-review-line="21"]')).not.toBeFocused();
});

test('inspection target focuses exact hold and shows remaining receipt evidence without unauthorized form',async({page})=>{
 await mount(page,'purchase-receiving-review-ui.js',{}, {holds:[holdInfo,{...holdInfo,id:78,product_name:'Other hold'}]});
 await page.evaluate(()=>TotalToolsReceivingReview.open(1,{recordId:77,lineId:32,kind:'inspection_hold'}));
 const hold=page.locator('[data-quality-hold="77"]');
 await expect(hold).toBeFocused();
 await expect(hold).toContainText('Held hammer · GR-11');
 await expect(hold).toContainText('Original 5 · Returned 2 · Remaining 3');
 await expect(hold).toContainText('Status: inspection');
 await expect(hold).toContainText('Purchasing approval permission is required');
 await expect(page.locator('form[data-hold]')).toHaveCount(0);
 await expect(page.locator('[data-review-line="32"]')).not.toBeFocused();
});

test('approver explicitly releases hold once and reloads current evidence',async({page})=>{
 const holds=[{...holdInfo}];
 await mount(page,'purchase-receiving-review-ui.js',{}, {holds,permissions:{purchasing_approve:true}});
 const writes=[];
 await page.route('**/quality-holds/77/release',async route=>{writes.push(route.request().postDataJSON());holds[0].status='available';await route.fulfill({json:{id:77,status:'available',released_quantity:3}});});
 // Return the changed evidence on the confirmation read.
 await page.route('**/review/orders/1',route=>route.fulfill({json:{po:{id:1,po_number:'PO-100',status:'partial'},lines:[],discrepancies:[],quality_holds:holds}}));
 await page.evaluate(()=>TotalToolsReceivingReview.open(1,{recordId:77,kind:'inspection_hold'}));
 const form=page.locator('form[data-hold="77"]');
 await form.locator('[name=reason]').fill('Passed visual inspection');
 await form.getByRole('button',{name:'Record inspection disposition'}).click();
 await expect(page.locator('[data-quality-hold="77"]')).toContainText('Status: available');
 await expect(page.locator('form[data-hold]')).toHaveCount(0);
 expect(writes).toEqual([{disposition:'available',reason:'Passed visual inspection'}]);
});

test('unknown hold release locks retries until explicit status reload and keeps follow-up draft',async({page})=>{
 const requests=await mount(page,'purchase-receiving-review-ui.js',{}, {holds:[holdInfo],permissions:{purchasing_approve:true}});
 let writes=0;
 await page.route('**/quality-holds/77/release',route=>{writes++;return route.abort('failed');});
 await page.evaluate(()=>TotalToolsReceivingReview.open(1,{recordId:77,kind:'inspection_hold'}));
 await page.locator('form[data-backorder="21"] [name=supplier_response]').fill('Keep this supplier follow-up');
 const form=page.locator('form[data-hold="77"]');
 await form.locator('[name=reason]').fill('Review complete');
 await form.getByRole('button',{name:'Record inspection disposition'}).click();
 await expect(page.locator('[data-quality-hold="77"]')).toContainText('Outcome needs confirmation');
 await expect(form.locator('[name=reason]')).toBeDisabled();
 expect(await page.evaluate(()=>TotalToolsReceivingReview.open(2,{recordId:99,kind:'inspection_hold'}))).toBe(false);
 await page.getByRole('button',{name:'Reload current hold status'}).click();
 await expect(page.locator('form[data-hold="77"] [name=reason]')).toBeEnabled();
 await expect(page.locator('form[data-backorder="21"] [name=supplier_response]')).toHaveValue('Keep this supplier follow-up');
 expect(writes).toBe(1);
 expect(requests.filter(path=>path.endsWith('/review/orders/1'))).toHaveLength(2);
});

test('dashboard review target cannot discard unsaved follow-up text',async({page})=>{
 const requests=await mount(page,'purchase-receiving-review-ui.js');
 await page.evaluate(()=>TotalToolsReceivingReview.open(1,{recordId:21}));
 await page.locator('form[data-backorder="21"] [name=supplier_response]').fill('Supplier promised Friday');
 expect(await page.evaluate(()=>TotalToolsReceivingReview.open(2,{recordId:32}))).toBe(false);
 await expect(page.locator('form[data-backorder="21"] [name=supplier_response]')).toHaveValue('Supplier promised Friday');
 await expect(page.locator('#tt-rr-po')).toHaveValue('1');
 expect(requests).not.toContain('/api/purchase-orders/receiving-controls/review/orders/2');
});

test('invoice target cannot overwrite a dirty open entry',async({page})=>{
 await mount(page,'purchase-invoice-receipt-ui.js');
 await page.evaluate(()=>TotalToolsInvoiceReceiptMatching.open(1,{recordId:9,kind:'captured_invoice'}));
 await page.locator('[name=qty][data-item="21"]').fill('2');
 expect(await page.evaluate(()=>TotalToolsInvoiceReceiptMatching.open(1,{recordId:12,kind:'posted_invoice'}))).toBe(false);
 await expect(page.locator('#tt-ir-invoice')).toHaveValue('capture-9');
 await expect(page.locator('[name=qty][data-item="21"]')).toHaveValue('2');
 await expect(page.locator('.tt-ir__status')).toContainText('Finish or recover');
});

test('saved invoice draft takes precedence over a new exact-record target',async({page})=>{
 await mount(page,'purchase-invoice-receipt-ui.js',{'invoice-1':{selectedInvoice:'capture-10',fields:[{form:'tt-ir-match',name:'qty',item:'21',value:'2'}],unknown:false}});
 await page.evaluate(()=>TotalToolsInvoiceReceiptMatching.open(1,{recordId:12,kind:'posted_invoice'}));
 await expect(page.locator('#tt-ir-invoice')).toHaveValue('capture-10');
 await expect(page.locator('[name=qty][data-item="21"]')).toHaveValue('2');
 await expect(page.locator('.tt-ir__status')).toContainText('saved invoice entry was restored first');
});

test('return target loads exact return and credit evidence and focuses requested credit',async({page})=>{
 const requests=await mount(page,'supplier-returns-ui.js');
 await page.evaluate(()=>TotalToolsSupplierReturns.open(1,{recordId:6,creditId:9}));
 await expect(page.locator('.tt-sr__review')).toContainText('Review SR-6');
 await expect(page.locator('.tt-sr__review')).toContainText('Evidence for return 6');
 await expect(page.locator('[data-credit-id="9"]')).toBeFocused();
 await expect(page.locator('[data-credit-id="8"]')).toHaveCount(0);
 await page.locator('[data-credit-id="9"] summary').click();
 await expect(page.locator('[data-credit-id="9"]')).toContainText('Return line #60');
 expect(requests).toContain('/api/supplier-returns/6');
 expect(requests).toContain('/api/supplier-ledger/credit-notes/9');
 expect(requests).not.toContain('/api/supplier-returns/5');
});

test('saved return draft and pending recovery take precedence over target',async({page})=>{
 const requests=await mount(page,'supplier-returns-ui.js',{'supplier-return-1':{reviewId:5,drafts:{request:{receipt_id:'11',reason_detail:'Protected return draft',qty_21:'2'}},pending:{path:'/api/supplier-returns',body:{reason_detail:'Protected return draft'},form:'request',key:'stable-key',confirmed:false}}});
 await page.evaluate(()=>TotalToolsSupplierReturns.open(1,{recordId:6,creditId:9}));
 await expect(page.locator('.tt-sr__review')).toContainText('Review SR-5');
 await expect(page.locator('[name=reason_detail]')).toHaveValue('Protected return draft');
 await expect(page.locator('[name=qty_21]')).toHaveValue('2');
 await expect(page.locator('[name=qty_21]')).toBeDisabled();
 await expect(page.getByRole('button',{name:'Recover pending action / reload confirmation'})).toBeVisible();
 await expect(page.locator('[data-status]')).toContainText('previous action needs recovery');
 expect(requests).not.toContain('/api/supplier-returns/6');
 expect(requests).not.toContain('/api/supplier-ledger/credit-notes/9');
});

test('return target cannot replace an already open draft',async({page})=>{
 const requests=await mount(page,'supplier-returns-ui.js');
 await page.evaluate(()=>TotalToolsSupplierReturns.open(1,{recordId:5}));
 await page.locator('.tt-sr__section>summary').first().click();
 await page.locator('[name=reason_detail]').fill('Continue this return');
 expect(await page.evaluate(()=>TotalToolsSupplierReturns.open(1,{recordId:6,creditId:9}))).toBe(false);
 await expect(page.locator('.tt-sr__review')).toContainText('Review SR-5');
 await expect(page.locator('[name=reason_detail]')).toHaveValue('Continue this return');
 await expect(page.locator('[data-status]')).toContainText('Close or finish');
 expect(requests).not.toContain('/api/supplier-returns/6');
});
