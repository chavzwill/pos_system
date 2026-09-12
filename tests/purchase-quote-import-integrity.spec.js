import { test, expect } from '@playwright/test';

const BASE='http://localhost:3001';
async function login(){
  const r=await fetch(`${BASE}/api/employees/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:process.env.POS_TEST_USER||'admin',password:process.env.POS_TEST_PASSWORD||'123456'})});
  expect(r.status).toBe(200);return {cookie:(r.headers.get('set-cookie')||'').split(';')[0],body:await r.json()};
}
async function api(cookie,method,path,body){
  const r=await fetch(`${BASE}${path}`,{method,headers:{Cookie:cookie,Accept:'application/json',...(body!==undefined?{'Content-Type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:r.status,body:await r.json().catch(()=>null)};
}

test('supplier quote requires confirmed matches and can create at most one linked PO',async()=>{
  const admin=await login(),stamp=`QI${Date.now()}`;
  const suppliers=await api(admin.cookie,'GET','/api/suppliers?active=true');
  const branches=await api(admin.cookie,'GET','/api/branches');
  expect(suppliers.status).toBe(200);expect(branches.status).toBe(200);
  const supplier=suppliers.body[0],branch=branches.body.find(x=>x.active!==0);
  expect(supplier).toBeTruthy();expect(branch).toBeTruthy();

  const p1=await api(admin.cookie,'POST','/api/products',{sku:`${stamp}-A`,name:`Exact ${stamp}`,price:20,cost:10,stock_qty:0,min_stock:0,active:1,branch_id:branch.id});
  const p2=await api(admin.cookie,'POST','/api/products',{sku:`${stamp}-B`,name:`Industrial Hammer ${stamp}`,price:40,cost:25,stock_qty:0,min_stock:0,active:1,branch_id:branch.id});
  expect(p1.status).toBe(201);expect(p2.status).toBe(201);
  const staged=await api(admin.cookie,'POST','/api/purchase-orders/quote-imports',{
    supplier_id:supplier.id,source_name:`Quote ${stamp}`,source_type:'text',extracted_text:'',
    lines:[
      {supplier_part_number:p1.body.sku,description:p1.body.name,entered_quantity:2,entered_uom:'EA',entered_unit_price:10},
      {supplier_part_number:`SUP-${stamp}`,description:`Industrial Hammer ${stamp} Extra`,entered_quantity:1,entered_uom:'EA',entered_unit_price:25}
    ]
  });
  expect(staged.status).toBe(201);
  const exact=staged.body.lines.find(x=>x.supplier_part_number===p1.body.sku);
  const possible=staged.body.lines.find(x=>x.supplier_part_number===`SUP-${stamp}`);
  expect(exact.match_status).toBe('matched');
  expect(possible.match_status).toBe('possible_match');

  let template=await api(admin.cookie,'GET',`/api/purchase-orders/quote-imports/${staged.body.id}/po-template`);
  expect(template.status).toBe(409);
  const confirmed=await api(admin.cookie,'POST',`/api/purchase-orders/quote-imports/${staged.body.id}/lines/${possible.id}/confirm-match`,{product_id:p2.body.id});
  expect(confirmed.status).toBe(200);
  template=await api(admin.cookie,'GET',`/api/purchase-orders/quote-imports/${staged.body.id}/po-template`);
  expect(template.status).toBe(200);
  expect(template.body.source_quote_import_id).toBe(staged.body.id);
  const poBody={
    supplier_id:supplier.id,
    branch_id:branch.id,
    ship_to_branch_id:branch.id,
    ship_to_name:branch.name||'CI receiving branch',
    ship_to_address:branch.address||'1 CI Receiving Road',
    ship_to_city:branch.city||'Kingston',
    ship_to_state:branch.state||'Kingston',
    ship_to_country:'Jamaica',
    employee_id:admin.body.id,
    source_quote_import_id:staged.body.id,
    items:template.body.items
  };
  const [a,b]=await Promise.all([
    api(admin.cookie,'POST','/api/purchase-orders',poBody),
    api(admin.cookie,'POST','/api/purchase-orders',poBody)
  ]);
  const successes=[a,b].filter(x=>x.status===201);
  expect(successes,JSON.stringify([a,b])).toHaveLength(1);
  expect([a,b].some(x=>x.status===400||x.status===409)).toBe(true);

  const doc=await api(admin.cookie,'GET',`/api/purchase-orders/quote-imports/${staged.body.id}`);
  expect(doc.status).toBe(200);
  expect(doc.body.status).toBe('converted');
  expect(Number(doc.body.converted_po_id)).toBe(Number(successes[0].body.id));
  template=await api(admin.cookie,'GET',`/api/purchase-orders/quote-imports/${staged.body.id}/po-template`);
  expect(template.status).toBe(409);

  const stock1=await api(admin.cookie,'GET',`/api/products/${p1.body.id}?branch_id=${branch.id}`);
  const stock2=await api(admin.cookie,'GET',`/api/products/${p2.body.id}?branch_id=${branch.id}`);
  expect(Number(stock1.body.branch_stock_qty)).toBe(0);
  expect(Number(stock2.body.branch_stock_qty)).toBe(0);
});
