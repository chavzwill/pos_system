'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const expanded=read('routes/loss-control-expanded.js'),operational=read('routes/loss-control-operational-leaks.js'),trace=read('routes/inventory-traceability.js'),margin=read('routes/retail-margin-protection.js'),tax=read('routes/retail-tax-exemption-protection.js'),uom=read('routes/retail-uom-guard.js'),invoiceGuard=read('routes/supplier-invoice-loss-prevention.js'),adjustments=read('routes/inventory-adjustment-hardening.js'),server=read('server.js');
for(const [n,s] of [['expanded loss control',expanded],['operational leakage',operational],['supplier invoice loss prevention',invoiceGuard],['tax exemption protection',tax],['inventory adjustment hardening',adjustments]])new vm.Script(s,{filename:n});
const checks=[
 ['expanded loss control requires reports authority',expanded.includes("router.use(requirePermission('reports'))")],
 ['normalized supplier invoice numbers detect punctuation/case duplicates',expanded.includes("normalizeInvoice(v)")&&expanded.includes("supplier_duplicate_invoice")],
 ['duplicate invoices are treated as at-risk until human review',expanded.includes("signal_type:'supplier_duplicate_invoice'")&&expanded.includes('estimated_loss:0')],
 ['supplier invoice overmatch compares invoice against PO evidence',expanded.includes("supplier_invoice_overmatch")&&expanded.includes('remaining_po_value')],
 ['supplier invoice overmatch compares invoice against receipt evidence',expanded.includes('received_value')&&expanded.includes('remaining_received_value')],
 ['unmatched supplier invoices are surfaced before payment risk is ignored',expanded.includes("supplier_invoice_without_po")],
 ['stale transfers quantify unresolved inventory cost',expanded.includes("stale_in_transit_inventory")&&expanded.includes('unresolved_cost')],
 ['stale transfer recommendation requires custody investigation',expanded.includes('Confirm physical custody')],
 ['tax-exempt sales without exemption number are surfaced',expanded.includes("tax_exemption_missing_evidence")&&expanded.includes("tax_exemption_number")],
 ['aged receivables are risk not automatically written off',expanded.includes("aged_receivable_exposure")&&expanded.includes('estimated_loss:0')],
 ['expanded signals explicitly reject fraud conclusions',expanded.includes('do not establish fraud or misconduct')],
 ['expanded scan performs no autonomous financial or disciplinary action',expanded.includes('No supplier payment, transfer, tax, credit, inventory or disciplinary action was performed automatically')],
 ['expanded loss control shares the durable base case ledger',expanded.includes('loss_control_cases')&&expanded.includes('loss_control_case_events')],
 ['expanded loss control is mounted under the existing loss-control namespace',trace.includes("router.use('/loss-control',require('./loss-control-expanded'))")],
 ['operational leakage is reports gated and mounted',operational.includes("router.use(requirePermission('reports'))")&&trace.includes("router.use('/loss-control',require('./loss-control-operational-leaks'))")],
 ['inventory adjustments create durable control events',adjustments.includes('inventory_adjustment_control_events')&&adjustments.includes('stock_movement_id INTEGER NOT NULL UNIQUE')],
 ['high-value negative adjustment requires supervisor approval',adjustments.includes('loss_control_inventory_adjustment_approval_value')&&adjustments.includes('Supervisor approval is required because this negative stock adjustment')],
 ['high-value adjustment defaults to independent approval',adjustments.includes('loss_control_inventory_adjustment_allow_self_approval')&&adjustments.includes('Independent supervisor authorization is required')],
 ['adjustment control values inventory before approval decision',adjustments.includes('estimatedValueChange')&&adjustments.includes('tracked_inventory_pool')],
 ['operational leakage detects employee adjustment concentration',operational.includes("inventory_adjustment_concentration")&&operational.includes('negative_inventory_value')],
 ['operational leakage detects repeated SKU reductions',operational.includes("repeated_product_stock_reduction")],
 ['supplier payment reference reuse is detected without assuming duplicate payment',operational.includes("duplicate_supplier_payment_reference")&&operational.includes('legitimate split/remittance reuse')],
 ['returned rentals with uncollected balance are surfaced',operational.includes("rental_uncollected_balance")&&operational.includes('settlement_transaction_id IS NULL')],
 ['overdue rental asset value is treated as exposure not loss',operational.includes("overdue_rental_asset_exposure")&&operational.includes('not an assumption that the asset is lost')],
 ['continued credit with aged debt is surfaced as risk',operational.includes("continued_credit_with_aged_debt")&&operational.includes('does not assume the new receivable will become bad debt')],
 ['operational scanner performs no autonomous remediation',operational.includes('No inventory, supplier payment, rental, customer-credit or disciplinary action was performed automatically')],
 ['POS margin protection is active after UOM normalization',uom.includes("router.use(require('./retail-margin-protection'))")&&uom.indexOf("guard('transaction')")<uom.indexOf("retail-margin-protection")],
 ['margin protection requires supervisor exception for below-floor sale',margin.includes('Supervisor authorization is required')&&margin.includes('margin_override_reason')],
 ['tax exemption protection is active after UOM normalization',uom.includes("router.use(require('./retail-tax-exemption-protection'))")&&uom.indexOf("guard('transaction')")<uom.indexOf("retail-tax-exemption-protection")],
 ['tax exemption requires customer certificate reason and supervisor',tax.includes('tax exemption/certificate number is required')&&tax.includes('must be attached to a customer record')&&tax.includes('Supervisor authorization is required for a tax-exempt POS sale')],
 ['tax exemption evidence persists transaction authorizer and avoided tax estimate',tax.includes('retail_tax_exemption_events')&&tax.includes('authorizer_employee_id')&&tax.includes('tax_avoided_estimate')],
 ['tax exemption raw PIN is stripped before transaction processing',tax.includes('delete req.body.tax_exemption_override_pin')],
 ['supplier invoice guard is mounted before the supplier ledger',server.indexOf("app.use('/api/supplier-ledger', require('./routes/supplier-invoice-loss-prevention'))")>=0&&server.indexOf("supplier-invoice-loss-prevention")<server.indexOf("app.use('/api/supplier-ledger', require('./routes/supplier-ledger'))")],
 ['supplier invoice guard normalizes duplicate identities',invoiceGuard.includes('normalizeInvoiceNumber')&&invoiceGuard.includes('Potential duplicate supplier invoice')],
 ['supplier invoice guard contains PO and receipt matching logic',invoiceGuard.includes('remainingReceived')&&invoiceGuard.includes('remainingPo')],
 ['supplier invoice guard prevents unmatched invoices from automatic payment allocation',invoiceGuard.includes("c.match_status IN ('matched','approved_exception')")],
 ['supplier invoice guard never creates purchase orders',!invoiceGuard.includes('INSERT INTO purchase_orders')],
 ['operational loss module never mutates inventory',!operational.includes('UPDATE products SET stock_qty')&&!operational.includes('UPDATE branch_inventory SET stock_qty')],
 ['operational loss module never creates supplier payments',!operational.includes('INSERT INTO supplier_payments')],
 ['operational loss module never changes customer credit',!operational.includes('UPDATE customers SET credit')]
];
let failed=0;for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Expanded loss control: ${name}`);if(!ok)failed++;}
if(failed){console.error(`Expanded loss-control contract FAILED (${failed}/${checks.length} failed).`);process.exit(1);}console.log(`Expanded loss-control contract OK (${checks.length} checks).`);
