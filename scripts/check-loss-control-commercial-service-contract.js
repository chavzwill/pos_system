'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const service=read('routes/loss-control-commercial-service-leaks.js'),trace=read('routes/inventory-traceability.js'),promo=read('routes/retail-promotion-protection.js'),credit=read('routes/retail-credit-loss-prevention.js'),uom=read('routes/retail-uom-guard.js');
for(const [name,src] of [['commercial/service leakage',service],['promotion protection',promo],['credit protection',credit]])new vm.Script(src,{filename:name});
const checks=[
 ['commercial/service intelligence requires reports permission',service.includes("router.use(requirePermission('reports'))")],
 ['commercial/service intelligence is mounted under loss control',trace.includes("router.use('/loss-control',require('./loss-control-commercial-service-leaks'))")],
 ['promotion concentration is based on authoritative posted promotion evidence',service.includes('retail_promotion_control_events')&&service.includes("promotion_discount_concentration")],
 ['promotion concentration remains an investigation signal',service.includes('not a misconduct finding')],
 ['repair leakage reads actual consumed repair reservations',service.includes('repair_part_reservations')&&service.includes('quantity_consumed')],
 ['repair leakage compares consumed quantity against billable work-order line',service.includes('billed_quantity')&&service.includes('billed_line_total')],
 ['repair leakage identifies both zero-billed consumed parts and excess consumption',service.includes('billed_line_total<=0.01')&&service.includes('excess_consumed_quantity')],
 ['repair exposure uses inventory acquisition-cost evidence rather than retail price',service.includes('COALESCE(p.cost,0) unit_cost')&&service.includes('inventory_cost_exposure')],
 ['repair recommendation supports billing return or authorized writeoff review',service.includes('Bill valid additional usage')&&service.includes('return unused parts')],
 ['commercial/service scanner does not mutate sales or repair invoices',service.includes('No sale, repair invoice, promotion, inventory or disciplinary action was changed automatically')],
 ['promotion checkout revalidates code activity date and usage limit',promo.includes('Promotion code or promotion is inactive')&&promo.includes('Promotion has expired')&&promo.includes('usage limit has been reached')],
 ['promotion checkout recalculates scope using product/category assignments',promo.includes('promotion_items')&&promo.includes('category_id')],
 ['promotion client discount mismatch is blocked',promo.includes('Promotion discount does not match the authoritative promotion value')],
 ['promotion runs before margin protection',uom.indexOf('retail-promotion-protection')<uom.indexOf('retail-margin-protection')],
 ['credit control enforces aged debt threshold',credit.includes('loss_control_credit_override_age_days')&&credit.includes('loss_control_credit_override_aged_balance')],
 ['credit control enforces projected credit limit',credit.includes('projected>limit+0.01')],
 ['credit exception requires independent management approval',credit.includes('Independent management authorization is required')],
 ['credit exception evidence is durable',credit.includes('retail_credit_override_events')&&credit.includes('override_type TEXT NOT NULL')],
 ['credit runs after promotion and tax controls',uom.indexOf('retail-credit-loss-prevention')>uom.indexOf('retail-promotion-protection')&&uom.indexOf('retail-credit-loss-prevention')>uom.indexOf('retail-tax-exemption-protection')],
 ['commercial/service intelligence performs no stock mutation',!service.includes('UPDATE products SET stock_qty')&&!service.includes('UPDATE branch_inventory SET stock_qty')]
];
let failed=0;for(const [name,ok]of checks){console.log(`${ok?'PASS':'FAIL'} Commercial/service loss control: ${name}`);if(!ok)failed++;}if(failed){console.error(`Commercial/service loss-control contract FAILED (${failed}/${checks.length} failed).`);process.exit(1)}console.log(`Commercial/service loss-control contract OK (${checks.length} checks).`);
