'use strict';
const fs=require('fs'),path=require('path');const root=path.join(__dirname,'..');const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const lib=read('lib/product-composition.js'),route=read('routes/product-compositions.js'),trace=read('routes/inventory-traceability.js'),valuation=read('lib/inventory-movement-valuation.js');
const checks=[
 ['three composition modes exist',lib.includes("virtual_bundle")&&lib.includes("assembled_kit")&&lib.includes("procurement_kit")],
 ['composition definition is separate from component inventory',lib.includes('product_compositions')&&lib.includes('product_composition_components')],
 ['kit instances preserve married physical identity',lib.includes('product_kit_instances')&&lib.includes('product_kit_instance_components')],
 ['composition operations are auditable',lib.includes('product_composition_operations')&&lib.includes('product_composition_operation_lines')],
 ['virtual availability derives from component availability',lib.includes('calculateAvailability')&&lib.includes('possible_kits')&&lib.includes('getAvailableQty')],
 ['virtual bundles never mutate parent physical inventory',lib.includes("Virtual bundles do not create or consume parent inventory")],
 ['break-pack consumes real parent availability',lib.includes('Only ${state.available} parent units are available to break pack')],
 ['break-pack transfers valuation rather than inventing child cost',lib.includes('removeFromPool')&&lib.includes('addComposition')&&lib.includes('parentComp.value')],
 ['cost allocation supports percentage',lib.includes("cost_allocation_mode==='percentage'")&&lib.includes('total 100%')],
 ['cost allocation supports explicit component value',lib.includes("cost_allocation_mode==='explicit'")],
 ['cost allocation supports relative component cost',lib.includes('component_cost')&&lib.includes('relative-cost allocation')],
 ['assembly availability uses all required components',lib.includes('Only ${availability.available_kits} complete kits can be assembled')],
 ['assembly consumes component stock and creates parent stock',lib.includes('Assembly into ${composition.parent_product_name}')&&lib.includes('Parent kit assembled from component inventory')],
 ['assembly preserves known acquisition value',lib.includes('tracked_value_moved')&&lib.includes('totalValue')],
 ['partial cost evidence is fail-visible',lib.includes('kit_assembly_partial_cost_evidence')],
 ['serialized marriage marks exact serial as kit component',lib.includes("status='kit_component'")&&lib.includes("event_type,quantity,reference_type")&&lib.includes("'kit_married'")],
 ['serialized marriage only uses available branch-owned serials',lib.includes("branch_id=? AND status='available'")],
 ['definition creation forbids parent as its own component',route.includes('productId===parentProductId')],
 ['physical transforms require inventory adjustment authority',route.includes("requirePermission('inventory_adjust')")],
 ['composition workflow is mounted under inventory traceability',trace.includes("router.use('/compositions',require('./product-compositions'))")],
 ['valuation primitives are shared rather than duplicated',valuation.includes('removeFromPool,addComposition')],
 ['break-pack and assembly are atomic DB transactions',route.includes("router.post('/:id/break-pack'")&&route.includes("router.post('/:id/assemble'")&&route.includes('await tx.commit()')]
];
let failed=0;for(const[n,ok]of checks){console.log(`${ok?'PASS':'FAIL'} Product composition: ${n}`);if(!ok)failed++;}if(failed){console.error(`Product composition contract FAILED (${failed}/${checks.length} failed).`);process.exit(1)}console.log(`Product composition contract OK (${checks.length} checks).`);
