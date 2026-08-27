'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const expanded=read('routes/loss-control-expanded.js'),trace=read('routes/inventory-traceability.js'),margin=read('routes/retail-margin-protection.js'),uom=read('routes/retail-uom-guard.js'),invoiceGuard=read('routes/supplier-invoice-loss-prevention.js');
for(const [n,s] of [['expanded loss control',expanded],['supplier invoice loss prevention',invoiceGuard]])new vm.Script(s,{filename:n});
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
 ['POS margin protection is active after UOM normalization',uom.includes("router.use(require('./retail-margin-protection'))")&&uom.indexOf("guard('transaction')")<uom.indexOf("retail-margin-protection")],
 ['margin protection requires supervisor exception for below-floor sale',margin.includes('Supervisor authorization is required')&&margin.includes('margin_override_reason')],
 ['supplier invoice guard normalizes duplicate identities',invoiceGuard.includes('normalizeInvoiceNumber')&&invoiceGuard.includes('Potential duplicate supplier invoice')],
 ['supplier invoice guard contains PO and receipt matching logic',invoiceGuard.includes('remainingReceived')&&invoiceGuard.includes('remainingPo')],
 ['supplier invoice guard prevents unmatched invoices from automatic payment allocation',invoiceGuard.includes("c.match_status IN ('matched','approved_exception')")],
 ['supplier invoice guard never creates purchase orders',!invoiceGuard.includes('INSERT INTO purchase_orders')]
];
let failed=0;for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Expanded loss control: ${name}`);if(!ok)failed++;}
if(failed){console.error(`Expanded loss-control contract FAILED (${failed}/${checks.length} failed).`);process.exit(1);}console.log(`Expanded loss-control contract OK (${checks.length} checks).`);
