'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');const root=path.join(__dirname,'..');const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const quote=read('routes/quotation-virtual-bundle-guard.js'),quoteUom=read('routes/quotation-uom-guard.js'),workflow=read('routes/quotation-workflow-hardening.js'),proc=read('routes/product-composition-procurement.js'),trace=read('routes/inventory-traceability.js');
new vm.Script(quote,{filename:'quotation-virtual-bundle-guard.js'});new vm.Script(proc,{filename:'product-composition-procurement.js'});
const checks=[
 ['quotation bundle guard runs before quotation UOM normalization',workflow.indexOf("require('./quotation-virtual-bundle-guard')")<workflow.indexOf("require('./quotation-uom-guard')")],
 ['quotation bundle uses active authoritative composition',quote.includes("composition_type='virtual_bundle' AND active=1")],
 ['quotation parent price comes from product master',quote.includes("SELECT id,name,sku,price,tax_rate,active FROM products")&&quote.includes('bundleUnitPrice=Number(parent.price||0)')],
 ['quotation client bundle markers are stripped',quote.includes("if(k.startsWith('_bundle_'))delete out[k]")],
 ['quotation bundle expands into physical component lines',quote.includes('req.body.items=expanded')&&quote.includes('component_product_id')],
 ['quotation preserves commercial bundle economics',quote.includes('bundle_line_total')&&quote.includes('allocated_unit_price')],
 ['quotation UOM preserves only server-authoritative bundle allocation',quoteUom.includes('line._bundle_server_price===true')&&quoteUom.includes("pricing_mode:'virtual_bundle_allocation'")],
 ['quotation bundle rejects mixed tax rates',quote.includes('cannot mix tax rates')],
 ['quotation bundle rejects nested virtual bundles',quote.includes('Nested virtual bundle component')],
 ['quotation stores branch availability snapshot without blocking quote creation',quote.includes('branch_available_kits')&&quote.includes('availability_snapshot')],
 ['quotation bundle evidence links parent to real quotation items',quote.includes('quotation_virtual_bundle_lines')&&quote.includes('quotation_virtual_bundle_components')&&quote.includes('quotation_item_id')],
 ['quotation bundle retrieval exposes component sourcing evidence',quote.includes('quotation_item_sources')&&quote.includes('component.sources=sources')],
 ['quotation bundle routes require quotation permission',quote.includes("requirePermission('quotations')")],
 ['procurement intelligence is mounted under inventory traceability',trace.includes("router.use('/composition-procurement',require('./product-composition-procurement'))")],
 ['procurement recommendations require purchasing permission',proc.includes("requirePermission('purchase_requests')")],
 ['procurement intelligence compares individual cost with procurement kit cost',proc.includes("composition_type='procurement_kit'")&&proc.includes('estimated_total_replenishment_cost')&&proc.includes('standalone.total_cost')],
 ['procurement intelligence evaluates extra components rather than hiding overbuy',proc.includes('extra_components')&&proc.includes('estimated_value')],
 ['procurement intelligence supports quotation shortfalls',proc.includes("router.post('/quote/:quoteId/recommendations'")&&proc.includes('qis.branch_id IS NULL')],
 ['missing component cost evidence prevents certified economic recommendation',proc.includes("strategy:'cost_evidence_required'")&&proc.includes('missing_cost_evidence')],
 ['missing procurement-kit cost excludes the candidate',proc.includes('missing_parent_cost')&&proc.includes('excluded_options')],
 ['planning cost is explicitly non-authoritative for valuation',proc.includes('Purchase-order and receipt evidence remains authoritative for valuation')]
];
let failed=0;for(const[n,ok]of checks){console.log(`${ok?'PASS':'FAIL'} Composition quote/procurement: ${n}`);if(!ok)failed++;}if(failed){console.error(`Composition quote/procurement contract FAILED (${failed}/${checks.length} failed).`);process.exit(1)}console.log(`Composition quote/procurement contract OK (${checks.length} checks).`);
