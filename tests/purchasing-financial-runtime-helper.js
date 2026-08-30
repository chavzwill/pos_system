import { expect, test } from '@playwright/test';

const BASE='http://localhost:3001';
const r2=v=>Number(Number(v||0).toFixed(2));
async function login(username=process.env.POS_TEST_USER||'admin',password=process.env.POS_TEST_PASSWORD||'123456'){
  const r=await fetch(`${BASE}/api/employees/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
  expect(r.status).toBe(200);return {cookie:(r.headers.get('set-cookie')||'').split(';')[0],body:await r.json()};
}
async function api(cookie,path,options={}){
  const headers={Cookie:cookie,Accept:'application/json',...(options.headers||{})};
  if(options.body&&!headers['Content-Type'])headers['Content-Type']='application/json';
  const r=await fetch(`${BASE}${path}`,{...options,headers});
  return {status:r.status,body:await r.json().catch(()=>null)};
}
function journalLine(detail,code){return detail.body?.lines?.find(x=>String(x.account_code)===String(code));}
function expectNoFixtureError(sync,prefix,id){
  const errors=sync.body?.stats?.errors||[];
  expect(errors.some(e=>String(e).startsWith(`${prefix}:${id}:`)),errors.join('\n')).toBe(false);
}

export function registerPurchasingFinancialRuntimeCertification(){
  test('PO approval, receipt valuation and supplier AP remain evidence-separated',async()=>{
    const admin=await login();
    const branches=await api(admin.cookie,'/api/branches');expect(branches.status).toBe(200);
    const branch=branches.body.find(b=>b.active!==0);test.skip(!branch,'Purchasing runtime certification requires an active branch');
    const suffix=`${Date.now()}${Math.random().toString(36).slice(2,6)}`;
    let supplier=null,product=null,po=null,invoice=null;
    try{
      let x=await api(admin.cookie,'/api/suppliers',{method:'POST',body:JSON.stringify({name:`Runtime Supplier ${suffix}`,contact_name:'Runtime Certification',address:'1 Runtime Test Road',city:'Kingston',state:'Kingston',payment_terms:'Net 30'})});
      expect(x.status).toBe(201);supplier=x.body;

      x=await api(admin.cookie,'/api/products',{method:'POST',body:JSON.stringify({sku:`RTP-${suffix}`,name:`Runtime Purchased SKU ${suffix}`,price:100,cost:0,tax_rate:0,stock_qty:0,min_stock:0,active:1,branch_id:branch.id,taxable:1})});
      expect(x.status).toBe(201);product=x.body;

      x=await api(admin.cookie,'/api/purchase-orders',{method:'POST',body:JSON.stringify({supplier_id:supplier.id,branch_id:branch.id,employee_id:admin.body.id,notes:'Runtime purchasing financial certification',items:[{product_id:product.id,quantity_ordered:3,unit_cost:60}]})});
      expect(x.status).toBe(201);po=x.body;expect(po.items?.length).toBe(1);expect(r2(po.total)).toBe(180);

      x=await api(admin.cookie,`/api/purchase-orders/${po.id}/status`,{method:'PATCH',body:JSON.stringify({status:'approved'})});
      expect(x.status).toBe(200);expect(x.body.status).toBe('approved');

      const before=await api(admin.cookie,`/api/products/${product.id}?branch_id=${branch.id}`);expect(before.status).toBe(200);expect(Number(before.body.branch_stock_qty||0)).toBe(0);

      x=await api(admin.cookie,`/api/purchase-orders/${po.id}/receive`,{method:'PATCH',body:JSON.stringify({items:[{item_id:po.items[0].id,quantity_received:3}]})});
      expect(x.status).toBe(200);expect(x.body.status).toBe('received');expect(x.body.receipt_id).toBeTruthy();expect(x.body.receipt_number).toMatch(/^RCV-/);
      const receiptId=x.body.receipt_id;

      const after=await api(admin.cookie,`/api/products/${product.id}?branch_id=${branch.id}`);expect(after.status).toBe(200);expect(Number(after.body.branch_stock_qty)).toBe(3);expect(r2(after.body.cost)).toBe(60);

      const noInvoiceYet=await api(admin.cookie,`/api/supplier-ledger/invoices?supplier_id=${supplier.id}&status=open`);expect(noInvoiceYet.status).toBe(200);expect(noInvoiceYet.body).toHaveLength(0);

      let sync=await api(admin.cookie,'/api/accounting-source-sync/sync',{method:'POST',body:JSON.stringify({})});
      expect(sync.status).toBe(200);expectNoFixtureError(sync,'purchase_receipt',receiptId);
      const journals=await api(admin.cookie,`/api/accounting-ledger/journals?branch_id=${branch.id}&limit=500`);expect(journals.status).toBe(200);
      const receiptJournal=journals.body.find(j=>j.source_type==='purchase_receipt'&&String(j.source_id)===String(receiptId));expect(receiptJournal).toBeTruthy();expect(receiptJournal.status).toBe('posted');
      const receiptDetail=await api(admin.cookie,`/api/accounting-ledger/journals/${receiptJournal.id}`);expect(receiptDetail.status).toBe(200);
      const inventory=journalLine(receiptDetail,'1200'),clearingCredit=journalLine(receiptDetail,'1250');
      expect(r2(inventory?.debit)).toBe(180);expect(r2(inventory?.credit)).toBe(0);expect(r2(clearingCredit?.credit)).toBe(180);expect(r2(receiptDetail.body.totals?.difference)).toBe(0);

      const today=new Date().toISOString().slice(0,10);
      x=await api(admin.cookie,'/api/supplier-ledger/invoices',{method:'POST',body:JSON.stringify({supplier_id:supplier.id,purchase_order_id:po.id,branch_id:branch.id,invoice_number:`RTINV-${suffix}`,invoice_date:today,subtotal:180,tax_amount:0,freight_amount:0,duty_amount:0,other_landed_cost_amount:0,total:180,notes:'Runtime purchasing financial certification'})});
      expect(x.status).toBe(201);invoice=x.body;

      const openAp=await api(admin.cookie,`/api/supplier-ledger/invoices?supplier_id=${supplier.id}&status=open`);expect(openAp.status).toBe(200);
      const openInvoice=openAp.body.find(i=>i.id===invoice.id);expect(openInvoice).toBeTruthy();expect(r2(openInvoice.balance_due)).toBe(180);

      sync=await api(admin.cookie,'/api/accounting-source-sync/sync',{method:'POST',body:JSON.stringify({})});expect(sync.status).toBe(200);expectNoFixtureError(sync,'supplier_invoice',invoice.id);
      const journals2=await api(admin.cookie,`/api/accounting-ledger/journals?branch_id=${branch.id}&limit=500`);expect(journals2.status).toBe(200);
      const invoiceJournal=journals2.body.find(j=>j.source_type==='supplier_invoice'&&String(j.source_id)===String(invoice.id));expect(invoiceJournal).toBeTruthy();expect(invoiceJournal.status).toBe('posted');
      const invoiceDetail=await api(admin.cookie,`/api/accounting-ledger/journals/${invoiceJournal.id}`);expect(invoiceDetail.status).toBe(200);
      const clearingDebit=journalLine(invoiceDetail,'1250'),ap=journalLine(invoiceDetail,'2000');
      expect(r2(clearingDebit?.debit)).toBe(180);expect(r2(ap?.credit)).toBe(180);expect(r2(invoiceDetail.body.totals?.difference)).toBe(0);
    }finally{
      // Keep PO/receipt/invoice evidence in the test database, but retire the
      // temporary catalog and supplier master records used by certification.
      if(product)await api(admin.cookie,`/api/products/${product.id}`,{method:'DELETE'}).catch(()=>{});
      if(supplier)await api(admin.cookie,`/api/suppliers/${supplier.id}`,{method:'DELETE'}).catch(()=>{});
    }
  });
}
