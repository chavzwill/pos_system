import { test, expect } from '@playwright/test';

const BASE='http://localhost:3001';
async function loginCookie(){const r=await fetch(`${BASE}/api/employees/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'123456'})});expect(r.status).toBe(200);return (r.headers.get('set-cookie')||'').split(';')[0];}
async function api(cookie,method,path,body){const r=await fetch(`${BASE}${path}`,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json().catch(()=>null)};}

test.describe('Procurement intelligence, governance, and outcome integrity',()=>{
  test('recommendation stays human-controlled and reconciles to actual receipt outcome',async()=>{
    const cookie=await loginCookie(),stamp=Date.now();
    const [suppliers,branches]=await Promise.all([api(cookie,'GET','/api/suppliers'),api(cookie,'GET','/api/branches')]);
    expect(suppliers.status).toBe(200);expect(branches.status).toBe(200);
    const supplier=suppliers.body.find(x=>x.active!==0),branch=branches.body.find(x=>x.active!==0);expect(supplier).toBeTruthy();expect(branch).toBeTruthy();
    const createdProduct=await api(cookie,'POST','/api/products',{sku:`PROC-${stamp}`,name:`Procurement Integrity ${stamp}`,price:80,cost:40,tax_rate:0,stock_qty:0,min_stock:0,active:1,branch_id:branch.id});expect(createdProduct.status).toBe(201);const product=createdProduct.body;
    const offerCreated=await api(cookie,'POST','/api/inventory-traceability/composition-supplier-procurement/offers',{supplier_id:supplier.id,product_id:product.id,supplier_sku:`SUP-${stamp}`,purchase_uom:'EA',units_per_purchase_uom:1,unit_cost_per_purchase_uom:40,currency:'JMD',minimum_order_qty:1,order_multiple:1,lead_time_days:2,freight_per_order:20,availability_qty:100});expect(offerCreated.status).toBe(201);const offerId=offerCreated.body.id;
    const offerUpdated=await api(cookie,'PUT',`/api/inventory-traceability/composition-supplier-procurement/offers/${offerId}`,{unit_cost_per_purchase_uom:42,availability_qty:50});expect(offerUpdated.status).toBe(200);expect(Number(offerUpdated.body.unit_cost_per_purchase_uom)).toBe(42);
    const history=await api(cookie,'GET',`/api/inventory-traceability/procurement-governance/offer-history?product_id=${product.id}`);expect(history.status).toBe(200);expect(history.body.filter(x=>Number(x.offer_id)===Number(offerId)).length).toBeGreaterThanOrEqual(2);
    const rec=await api(cookie,'POST','/api/inventory-traceability/composition-supplier-procurement/recommendations',{requirements:[{product_id:product.id,quantity:2}]});expect(rec.status).toBe(200);expect(rec.body.recommendation).toBeTruthy();expect(Number(rec.body.recommendation.total_landed_cost)).toBe(104);
    const review=await api(cookie,'POST','/api/inventory-traceability/procurement-governance/decision-reviews',{requirements:[{product_id:product.id,quantity:2}],recommendation:rec.body.recommendation});expect(review.status).toBe(201);expect(review.body.status).toBe('pending');
    const approved=await api(cookie,'POST',`/api/inventory-traceability/procurement-governance/decision-reviews/${review.body.id}/approve`,{});expect(approved.status).toBe(200);expect(approved.body.purchase_order_created).toBe(false);
    const prePo=await api(cookie,'POST',`/api/inventory-traceability/procurement-governance/decision-reviews/${review.body.id}/pre-po-check`,{});expect(prePo.status).toBe(200);expect(prePo.body.po_creation_allowed).toBe(true);expect(prePo.body.purchase_order_created).toBe(false);
    const poCreated=await api(cookie,'POST','/api/purchase-orders',{supplier_id:supplier.id,branch_id:branch.id,ship_to_branch_id:branch.id,ship_to_name:branch.name,ship_to_address:branch.address||'1 Runtime Test Road',ship_to_city:branch.city||'Kingston',ship_to_state:branch.state||'Kingston',items:[{product_id:product.id,quantity_ordered:2,unit_cost:42}],notes:`Manual PO from sourcing review ${review.body.id}`,expected_date:new Date(Date.now()+86400000).toISOString().slice(0,10)});expect(poCreated.status).toBe(201);const po=poCreated.body;
    const linked=await api(cookie,'POST',`/api/inventory-traceability/procurement-outcomes/decision-reviews/${review.body.id}/link-po`,{po_id:po.id});expect(linked.status).toBe(201);expect(linked.body.purchase_order_created).toBe(false);
    const poApproved=await api(cookie,'PATCH',`/api/purchase-orders/${po.id}/status`,{status:'approved'});expect(poApproved.status).toBe(200);
    const received=await api(cookie,'PATCH',`/api/purchase-orders/${po.id}/receive`,{items:[{item_id:po.items[0].id,quantity_received:2}]});expect(received.status).toBe(200);expect(received.body.status).toBe('received');
    const charge=await api(cookie,'POST',`/api/inventory-traceability/procurement-outcomes/purchase-orders/${po.id}/actual-charges`,{charge_type:'freight',amount:20,currency:'JMD',evidence_reference:`FREIGHT-${stamp}`});expect(charge.status).toBe(201);
    const outcome=await api(cookie,'GET',`/api/inventory-traceability/procurement-outcomes/decision-reviews/${review.body.id}/outcome`);expect(outcome.status).toBe(200);expect(outcome.body.base_currency).toBe('JMD');expect(Number(outcome.body.expected_landed_cost)).toBe(104);expect(Number(outcome.body.actual_merchandise_cost)).toBe(84);expect(Number(outcome.body.actual_additional_charges)).toBe(20);expect(Number(outcome.body.actual_landed_cost)).toBe(104);expect(Number(outcome.body.cost_variance)).toBe(0);expect(outcome.body.complete).toBe(true);
    const snapshot=await api(cookie,'POST',`/api/inventory-traceability/procurement-outcomes/decision-reviews/${review.body.id}/outcome-snapshot`,{});expect(snapshot.status).toBe(201);
    const unavailable=await api(cookie,'PUT',`/api/inventory-traceability/composition-supplier-procurement/offers/${offerId}`,{availability_qty:0});expect(unavailable.status).toBe(200);
    const alerts=await api(cookie,'GET','/api/inventory-traceability/procurement-market/offer-alerts');expect(alerts.status).toBe(200);expect(alerts.body.some(x=>Number(x.id)===Number(offerId)&&x.alert_type==='unavailable')).toBe(true);
  });

  test('foreign-currency sourcing fails closed until normalization is wired into recommendation economics',async()=>{
    const cookie=await loginCookie(),stamp=Date.now();
    const suppliers=await api(cookie,'GET','/api/suppliers');const supplier=suppliers.body.find(x=>x.active!==0);expect(supplier).toBeTruthy();
    const productCreate=await api(cookie,'POST','/api/products',{sku:`FX-${stamp}`,name:`FX Guard ${stamp}`,price:10,cost:5,tax_rate:0,stock_qty:0,min_stock:0,active:1});expect(productCreate.status).toBe(201);const product=productCreate.body;
    const offer=await api(cookie,'POST','/api/inventory-traceability/composition-supplier-procurement/offers',{supplier_id:supplier.id,product_id:product.id,supplier_sku:`FX-SUP-${stamp}`,purchase_uom:'EA',units_per_purchase_uom:1,unit_cost_per_purchase_uom:5,currency:'USD',availability_qty:10});expect(offer.status).toBe(201);
    const rec=await api(cookie,'POST','/api/inventory-traceability/composition-supplier-procurement/recommendations',{requirements:[{product_id:product.id,quantity:1}]});expect(rec.status).toBe(409);expect(rec.body.requires_fx_normalization).toBe(true);expect(rec.body.foreign_currencies).toContain('USD');
  });

  test('quantity price-break changes invalidate sourcing approval and are explained',async()=>{
    const cookie=await loginCookie(),stamp=Date.now();const suppliers=await api(cookie,'GET','/api/suppliers');const supplier=suppliers.body.find(x=>x.active!==0);expect(supplier).toBeTruthy();
    const p=await api(cookie,'POST','/api/products',{sku:`BRK-${stamp}`,name:`Break Guard ${stamp}`,price:50,cost:25,tax_rate:0,stock_qty:0,min_stock:0,active:1});expect(p.status).toBe(201);
    const offer=await api(cookie,'POST','/api/inventory-traceability/composition-supplier-procurement/offers',{supplier_id:supplier.id,product_id:p.body.id,supplier_sku:`BRK-SUP-${stamp}`,unit_cost_per_purchase_uom:25,currency:'JMD',availability_qty:100,price_breaks:[{min_purchase_qty:10,unit_cost_per_purchase_uom:22}]});expect(offer.status).toBe(201);
    const rec=await api(cookie,'POST','/api/inventory-traceability/composition-supplier-procurement/recommendations',{requirements:[{product_id:p.body.id,quantity:10}]});expect(rec.status).toBe(200);
    const review=await api(cookie,'POST','/api/inventory-traceability/procurement-governance/decision-reviews',{requirements:[{product_id:p.body.id,quantity:10}],recommendation:rec.body.recommendation});expect(review.status).toBe(201);
    const changed=await api(cookie,'PUT',`/api/inventory-traceability/composition-supplier-procurement/offers/${offer.body.id}`,{price_breaks:[{min_purchase_qty:10,unit_cost_per_purchase_uom:20}]});expect(changed.status).toBe(200);
    const approval=await api(cookie,'POST',`/api/inventory-traceability/procurement-governance/decision-reviews/${review.body.id}/approve`,{});expect(approval.status).toBe(409);expect(approval.body.requires_recommendation_refresh).toBe(true);
    const diff=await api(cookie,'GET',`/api/inventory-traceability/procurement-market/decision-reviews/${review.body.id}/what-changed`);expect(diff.status).toBe(200);expect(diff.body.changed).toBe(true);expect(diff.body.changes.some(x=>x.type==='price_break_price_changed'&&Number(x.previous)===22&&Number(x.current)===20)).toBe(true);
    const breakHistory=await api(cookie,'GET',`/api/inventory-traceability/composition-supplier-procurement/price-break-history?offer_id=${offer.body.id}`);expect(breakHistory.status).toBe(200);expect(breakHistory.body.length).toBeGreaterThanOrEqual(2);
  });
});
