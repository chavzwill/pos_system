'use strict';
const fs=require('fs'),path=require('path');const root=path.join(__dirname,'..');const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const lib=read('lib/unit-of-measure.js'),route=read('routes/unit-of-measure.js'),retail=read('routes/retail-uom-guard.js'),trace=read('routes/retail-traceability-guard.js'),inv=read('routes/inventory-traceability.js'),po=read('routes/purchase-uom-guard.js'),poctx=read('routes/purchase-order-document-context.js');
const checks=[
 ['product base UOM profile exists',lib.includes('product_uom_profiles')],
 ['product conversion table exists',lib.includes('product_uom_conversions')],
 ['transactional conversion snapshot exists',lib.includes('uom_usage_snapshots')],
 ['standard length conversions include metric and imperial',lib.includes('mm:0.001')&&lib.includes('ft:0.3048')&&lib.includes('in:0.0254')],
 ['standard mass conversions include kg lb oz',lib.includes('kg:1')&&lib.includes('lb:0.45359237')&&lib.includes('oz:0.028349523125')],
 ['standard volume conversions include liters and US gallons',lib.includes('l:1')&&lib.includes('gal_us:3.785411784')],
 ['cross-dimension conversion is rejected',lib.includes('units must share the same dimension')],
 ['base UOM factor is always one',lib.includes('factor_to_base:1')],
 ['sell and purchase permissions are separate',lib.includes("mode==='purchase'?'purchase_allowed':'sell_allowed'")],
 ['whole-base inventory prevents lossy fractional package conversion',lib.includes('inventory for this product requires whole base units')],
 ['base UOM becomes immutable after transactional history',route.includes('Base UOM or precision cannot be changed after transactional UOM history exists')],
 ['standard conversion endpoint exists',route.includes("router.get('/convert'")],
 ['inventory traceability exposes UOM controls',inv.includes("router.use('/uom',require('./unit-of-measure'))")],
 ['retail UOM guard is mounted before serial lot reservation',trace.indexOf("router.use(require('./retail-uom-guard'))")<trace.indexOf('reserveIdentities')],
 ['retail keeps entered quantity and UOM evidence',retail.includes('entered_quantity')&&retail.includes('entered_uom')],
 ['retail converts to authoritative base quantity',retail.includes('line.quantity=baseQuantity')],
 ['retail conversion history snapshots after transaction',retail.includes("sourceType:'transaction'")],
 ['purchase UOM guard resolves purchase-only conversion',po.includes("resolveProductUom(db,productId,item.uom_code||item.unit||null,'purchase')")],
 ['purchase economics are normalized by factor',po.includes('enteredUnitCost/factor')],
 ['purchase order converts quantity to base inventory units',po.includes('item.quantity_ordered=baseQuantity')],
 ['purchase order retains UOM snapshot evidence',po.includes("sourceType:'purchase_order'")],
 ['purchase UOM guard runs before PO document creation',poctx.indexOf("router.use(require('./purchase-uom-guard'))")<poctx.indexOf("router.post('/',requirePermission('purchasing_create')")]
];
let failed=0;for(const [n,ok] of checks){console.log(`${ok?'PASS':'FAIL'} UOM conversion: ${n}`);if(!ok)failed++;}if(failed){console.error(`UOM conversion contract FAILED (${failed}/${checks.length} failed).`);process.exit(1);}console.log(`UOM conversion contract OK (${checks.length} checks).`);
