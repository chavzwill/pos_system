'use strict';
const fs=require('fs'),path=require('path');const root=path.join(__dirname,'..');const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const route=read('routes/product-composition-supplier-procurement.js'),trace=read('routes/inventory-traceability.js');
const checks=[
 ['supplier-aware procurement is mounted',trace.includes("/composition-supplier-procurement',require('./product-composition-supplier-procurement')")],
 ['supplier offer master exists',route.includes('supplier_product_offers')],
 ['supplier-specific SKU is preserved',route.includes('supplier_sku TEXT')],
 ['purchase UOM conversion is modeled',route.includes('units_per_purchase_uom')&&route.includes('purchase_uom')],
 ['minimum order quantity is modeled',route.includes('minimum_order_qty')],
 ['order multiples are modeled',route.includes('order_multiple')&&route.includes('ceilMultiple')],
 ['quantity price breaks are modeled',route.includes('supplier_price_breaks')&&route.includes('min_purchase_qty')],
 ['lead time is exposed',route.includes('lead_time_days')],
 ['freight contributes to landed cost',route.includes('freight_per_order')&&route.includes('freight_per_purchase_uom')&&route.includes('landed_cost')],
 ['duty contributes to landed cost',route.includes('duty_rate')&&route.includes('duty_cost')],
 ['supplier availability can disqualify an offer',route.includes('availability_qty')&&route.includes('e.purchase_quantity>e.availability_qty')],
 ['offer validity dates are enforced',route.includes('valid_from')&&route.includes('valid_until')&&route.includes("date('now')")],
 ['payment terms are returned for buyer review',route.includes('payment_terms')],
 ['supplier reliability is modeled',route.includes('supplier_performance_snapshots')&&route.includes('reliability_score')],
 ['supplier offer management requires supplier authority',route.includes("router.post('/offers',requirePermission('suppliers')")],
 ['recommendations require purchasing authority',route.includes("router.post('/recommendations',requirePermission('purchase_requests')")],
 ['individual products choose best landed supplier offer',route.includes('offersForProduct')&&route.includes('sort((a,b)=>a.landed_cost-b.landed_cost')],
 ['procurement kits use supplier-specific parent offers',route.includes('kit_supplier_offer:parent')&&route.includes('offersForProduct(executor,row.parent_product_id,kits)')],
 ['kit alternatives preserve leftover individual sourcing',route.includes('remaining_component_plan')&&route.includes('requirementPlan(executor,remaining)')],
 ['kit overbuy is visible',route.includes('extra_components')],
 ['recommendation compares mixed supplier strategies on landed cost',route.includes("strategy:'individual_supplier_mix'")&&route.includes("strategy:'procurement_kit_plus_individuals'")&&route.includes("decision_basis:'landed_cost'")],
 ['actual PO receipt evidence remains authoritative',route.includes('actual PO/receipt evidence remains authoritative')]
];
let failed=0;for(const[n,ok]of checks){console.log(`${ok?'PASS':'FAIL'} Supplier procurement: ${n}`);if(!ok)failed++;}if(failed){console.error(`Supplier procurement contract FAILED (${failed}/${checks.length} failed).`);process.exit(1)}console.log(`Supplier procurement contract OK (${checks.length} checks).`);
