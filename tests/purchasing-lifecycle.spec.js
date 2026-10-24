const {test,expect}=require('@playwright/test');
const BASE=process.env.POS_CERT_BASE_URL;
test('partial deliveries and captured invoices reconcile independently through AP and payment',async()=>{
 test.skip(!process.env.POS_ISOLATED_CERTIFICATION,'Use the isolated purchasing certification runner');
 if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(BASE||''))throw new Error('Run scripts/certify-purchasing-lifecycle.cjs; isolated server required');
 const call=async(cookie,method,path,body,key)=>{const r=await fetch(BASE+path,{method,headers:{Cookie:cookie||'','Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},body:body===undefined?undefined:JSON.stringify(body)});return{status:r.status,body:await r.json()}};
 const login=async username=>{const r=await fetch(BASE+'/api/employees/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password:process.env.POS_TEST_PASSWORD})});expect(r.status).toBe(200);return r.headers.get('set-cookie').split(';')[0]};
 const admin=await login('admin'),api=(m,p,b,k)=>call(admin,m,p,b,k),must=(r,status=201)=>{expect(r.status,JSON.stringify(r.body)).toBe(status);return r.body};
 const branch=must(await api('GET','/api/branches'),200).find(x=>x.active!==0),date=new Date().toISOString().slice(0,10);
 const supplier=must(await api('POST','/api/suppliers',{name:'Isolated lifecycle supplier',address:'1 Test Road',city:'Kingston',state:'Kingston'}));
 const product=must(await api('POST','/api/products',{sku:'ISOLATED-LIFECYCLE',name:'Lifecycle stock',price:30,cost:10,stock_qty:0,active:1,branch_id:branch.id}));
 must(await api('POST','/api/employees/reauth-self',{password:process.env.POS_TEST_PASSWORD,purpose:'security_admin'}),200);
 const group=must(await api('POST','/api/security-groups',{name:'Isolated receiver',reason:'Isolated purchasing role verification',permissions:{purchasing_receive:true}}));
 must(await api('POST','/api/employees',{first_name:'Test',last_name:'Receiver',username:'receiver',password:process.env.POS_TEST_PASSWORD,pin:'782951',must_change_password:false,security_group_id:group.id,default_branch_id:branch.id}));
 const receiver=await login('receiver'),receiveApi=(m,p,b,k)=>call(receiver,m,p,b,k);
 const po=must(await api('POST','/api/purchase-orders',{supplier_id:supplier.id,branch_id:branch.id,ship_to_branch_id:branch.id,ship_to_name:branch.name,ship_to_address:'1 Test Road',ship_to_city:'Kingston',ship_to_state:'Kingston',approval_purpose:'Isolated purchasing certification',requested_for:'Test branch',items:[{product_id:product.id,quantity_ordered:5,unit_cost:10}]}));
 const order='/api/purchase-orders/'+po.id,line=po.items[0].id,receipts=[];
 expect((await receiveApi('PATCH',order+'/status',{status:'approved'})).status).toBe(403);
 expect((await api('PATCH',order+'/receive',{items:[{item_id:line,quantity_received:1}]},'unapproved-receive')).status).toBe(400);
 must(await api('PATCH',order+'/status',{status:'approved'}),200);
 for(const [index,qty] of [2,3].entries()){
  const body={items:[{item_id:line,quantity_received:qty,receipt_unit_cost:'12',pricing_reason:'Verified supplier delivery cost'}]},key='lifecycle-delivery-'+index;
  const receipt=must(await api('PATCH',order+'/receive',body,key),200);receipts.push(receipt.receipt_id);
  expect(receipt.status).toBe(index?'received':'partial');
  expect(must(await api('PATCH',order+'/receive',body,key),200).receipt_id).toBe(receipt.receipt_id);
 }
 const stock=async()=>Number(must(await api('GET','/api/products/'+product.id+'?branch_id='+branch.id),200).branch_stock_qty);
 expect(await stock()).toBe(5);
 const productAfter=must(await api('GET','/api/products/'+product.id),200);expect(Number(productAfter.price)).toBe(30);expect(Number(productAfter.cost)).toBe(12);
 expect(Number(must(await api('GET',order),200).items[0].unit_cost)).toBe(10);
 const evidence='/api/purchase-orders/receiving-controls/invoice-receipts/orders/'+po.id;
 const details=must(await api('GET',evidence),200);expect(details.receipt_items).toHaveLength(2);details.receipt_items.sort((a,b)=>Number(a.receipt_item_id)-Number(b.receipt_item_id));
 const invoices=[];
 for(const [index,subtotal] of [24,36].entries()){
  const captured=must(await receiveApi('POST','/api/supplier-ledger/captured-invoices',{purchase_order_id:po.id,invoice_number:'ISOLATED-'+index,invoice_date:date,subtotal,total:subtotal},'lifecycle-capture-'+index));
  expect(must(await api('GET','/api/supplier-ledger/invoices?status=all&supplier_id='+supplier.id),200)).toHaveLength(index);
  const quantities=index?[1,2]:[1,1],lines=details.receipt_items.map((x,i)=>({receipt_item_id:x.receipt_item_id,quantity_invoiced:String(quantities[i]),invoice_unit_cost:'12.00'}));
  must(await receiveApi('POST','/api/supplier-ledger/captured-invoices/'+captured.id+'/allocate',{lines},'lifecycle-allocation-'+index));
  expect((await receiveApi('POST','/api/supplier-ledger/invoices',{captured_invoice_id:captured.id})).status).toBe(403);
  if(index)expect((await api('POST','/api/supplier-ledger/invoices',{captured_invoice_id:captured.id})).status).toBe(400);
  const posted=must(await api('POST','/api/supplier-ledger/invoices',{captured_invoice_id:captured.id,...(index?{match_override_reason:'Verified receipt costs increased from PO cost to twelve per unit'}:{})}));invoices.push(posted.id);
  expect(must(await api('POST','/api/supplier-ledger/invoices',{captured_invoice_id:captured.id}),200).id).toBe(posted.id);
  expect(await stock()).toBe(5);
 }
 const final=must(await api('GET',evidence),200);expect(final.receipt_items.every(x=>Number(x.remaining_qty)===0)).toBe(true);
 const balances=must(await api('GET','/api/supplier-ledger/invoices?status=all&supplier_id='+supplier.id),200);expect(balances).toHaveLength(2);expect(balances.reduce((n,x)=>n+Number(x.balance_due),0)).toBe(60);
 const payment={supplier_id:supplier.id,branch_id:branch.id,payment_date:date,amount:60,payment_method:'bank_transfer',reference:'ISOLATED-PAYMENT',allocations:invoices.map((id,i)=>({invoice_id:id,amount:i?36:24}))};
 expect((await receiveApi('POST','/api/supplier-ledger/payments',payment,'receiver-payment-denied')).status).toBe(403);
 const paid=must(await api('POST','/api/supplier-ledger/payments',payment,'lifecycle-payment'));
 const paymentReplay=must(await api('POST','/api/supplier-ledger/payments',payment,'lifecycle-payment'));expect(paymentReplay.id).toBe(paid.id);expect(paymentReplay.replayed).toBe(true);
 expect(must(await api('GET','/api/supplier-ledger/invoices?status=all&supplier_id='+supplier.id),200).every(x=>Number(x.balance_due)===0)).toBe(true);
 for(let run=0;run<2;run++)must(await api('POST','/api/accounting-source-sync/sync',{}),200);
 const journals=must(await api('GET','/api/accounting-ledger/journals?branch_id='+branch.id+'&limit=500'),200);
 const relevant=journals.filter(x=>(x.source_type==='purchase_receipt'&&receipts.includes(Number(x.source_id)))||(x.source_type==='supplier_invoice'&&invoices.includes(Number(x.source_id))));
 expect(relevant).toHaveLength(4);let inventory=0,clearing=0,ap=0;
 for(const journal of relevant){const detail=must(await api('GET','/api/accounting-ledger/journals/'+journal.id),200);expect(Number(detail.totals.difference)).toBe(0);for(const line of detail.lines){const net=Number(line.debit)-Number(line.credit);if(line.account_code==='1200')inventory+=net;if(line.account_code==='1250')clearing+=net;if(line.account_code==='2000')ap+=net;}}
 expect(inventory).toBe(60);expect(clearing).toBe(0);expect(ap).toBe(-60);
 const paymentJournals=journals.filter(x=>x.source_type==='supplier_payment'&&Number(x.source_id)===Number(paid.id));expect(paymentJournals).toHaveLength(1);
 const paymentJournal=must(await api('GET','/api/accounting-ledger/journals/'+paymentJournals[0].id),200);expect(Number(paymentJournal.totals.difference)).toBe(0);
 expect(Number(paymentJournal.lines.find(x=>x.account_code==='2000').debit)).toBe(60);expect(Number(paymentJournal.lines.find(x=>x.account_code==='1010').credit)).toBe(60);
 expect(ap+Number(paymentJournal.lines.find(x=>x.account_code==='2000').debit)).toBe(0);expect(await stock()).toBe(5);
});
