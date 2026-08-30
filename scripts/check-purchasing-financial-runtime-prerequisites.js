'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const server=read('server.js');
const receipt=read('routes/purchase-receipt-traceability.js');
const costs=read('lib/inventory-cost-layers.js');
const accounting=read('lib/accounting-purchasing.js');
const posting=read('lib/accounting-posting.js');
const sync=read('routes/accounting-source-sync.js');
const helper=read('tests/purchasing-financial-runtime-helper.js');
const business=read('tests/business-integrity.spec.js');
for(const [name,src] of Object.entries({server,receipt,costs,accounting,posting,sync,helper,business})){
  if(!name.includes('helper')&&!name.includes('business'))new vm.Script(src,{filename:name});
}
const checks=[
 ['traceable receiving is mounted before legacy PO receiving',server.includes("app.use('/api/purchase-orders', require('./routes/purchase-receipt-traceability'))")&&server.indexOf("require('./routes/purchase-receipt-traceability')")<server.indexOf("require('./routes/purchase-orders')")],
 ['receipt initialization explicitly creates inventory valuation layers',receipt.includes("ensureInventoryCostLayers")&&receipt.includes("await ensureInventoryCostLayers()")],
 ['valuation receipt trigger layers immutable receipt lines',costs.includes('trg_inventory_cost_receipt_layer')&&costs.includes('purchase_receipt_item_id')&&costs.includes('tracked_value=ROUND(tracked_value+NEW.line_cost')],
 ['receiving only accepts approved or partial purchase orders',receipt.includes("!['approved','partial'].includes(po.status)")],
 ['receipt requires a receiving branch',receipt.includes('A receiving branch is required before inventory can be received')],
 ['receipt persists immutable quantity and cost evidence',receipt.includes('purchase_receipt_items')&&receipt.includes('quantity_received,unit_cost,line_cost')],
 ['receipt movement is branch-tagged',receipt.includes("'purchase_receive'")&&receipt.includes('po.branch_id')],
 ['accounting posts receipt value to Inventory and purchasing clearing',accounting.includes("code:'1200',debit:recorded")&&accounting.includes("code:'1250',debit:0,credit:recorded")],
 ['supplier invoices are normalized from source evidence before journal posting',posting.includes("if(sourceType==='supplier_invoice')return supplierInvoiceLines")],
 ['supplier merchandise clears only the merchandise subtotal',posting.includes("code:'1250',debit:subtotal")],
 ['recoverable supplier tax posts to input tax recoverable',posting.includes("code:'1400',debit:tax")],
 ['landed-cost components post to allocation clearing',posting.includes("code:'1260',debit:landed")],
 ['nonrecoverable supplier tax posts to purchase-tax expense',posting.includes("code:'5450',debit:tax")],
 ['supplier invoice total credits Accounts Payable',posting.includes("code:'2000',debit:0,credit:total")],
 ['runtime helper proves no AP invoice exists before supplier invoice evidence',helper.includes('noInvoiceYet')&&helper.includes('toHaveLength(0)')],
 ['runtime helper proves receipt stock and preserved catalog cost',helper.includes('branch_stock_qty')&&helper.includes('after.body.cost')&&helper.includes('toBe(60)')],
 ['runtime helper proves receipt journal and supplier invoice journal independently',helper.includes("source_type==='purchase_receipt'")&&helper.includes("source_type==='supplier_invoice'")],
 ['runtime helper proves receipt debit Inventory and credit clearing',helper.includes("journalLine(receiptDetail,'1200')")&&helper.includes("journalLine(receiptDetail,'1250')")],
 ['runtime helper proves supplier invoice debits clearing and credits AP',helper.includes("journalLine(invoiceDetail,'1250')")&&helper.includes("journalLine(invoiceDetail,'2000')")],
 ['business-integrity release suite registers purchasing runtime certification',business.includes('registerPurchasingFinancialRuntimeCertification')]
];
let failed=0;for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Purchasing runtime prerequisite: ${name}`);if(!ok)failed++;}
if(failed){console.error(`Purchasing runtime prerequisite FAILED (${failed}/${checks.length} failed).`);process.exit(1);}
console.log(`Purchasing runtime prerequisite OK (${checks.length} checks). Receipt valuation, merchandise clearing, supplier-tax classification, landed-cost clearing and AP separation are structurally gated.`);
