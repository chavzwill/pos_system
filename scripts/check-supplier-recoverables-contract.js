'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const lib=read('lib/supplier-recoverables.js');
const route=read('routes/supplier-recoverables.js');
const po=read('routes/purchase-order-hardening.js');
const ledger=read('routes/supplier-ledger.js');
const sync=read('routes/accounting-source-sync.js');
const posting=read('lib/accounting-posting.js');
const ui=read('public/index.html');
const server=read('server.js');
new vm.Script(lib,{filename:'supplier-recoverables.js'});
new vm.Script(route,{filename:'supplier-recoverables-route.js'});
new vm.Script(ledger,{filename:'supplier-ledger.js'});
new vm.Script(sync,{filename:'accounting-source-sync.js'});
const checks=[
 ['supplier recoverables route is mounted',server.includes("app.use('/api/supplier-recoverables'")],
 ['recoverables require purchasing or finance authority',route.includes("requireAnyPermission('purchasing','reports_financial','accounts')")],
 ['claims and settlement history are durable',lib.includes('supplier_recoverable_claims')&&lib.includes('supplier_recoverable_settlements')],
 ['claim identity is concurrency-safe',lib.includes('randomUUID')&&lib.includes("return 'SRC-'")],
 ['supported recoverable types include credit note shortage return overcharge rebate and reimbursement',route.includes("'credit_note','supplier_return','shorted_goods','overcharge','damaged_goods','rebate','reimbursement','other'")],
 ['identified exposure is distinct from confirmed amount',lib.includes('identified_amount REAL NOT NULL DEFAULT 0')&&lib.includes('confirmed_amount REAL NOT NULL DEFAULT 0')],
 ['identified claim defaults to non-confirmed state',lib.includes("status TEXT NOT NULL DEFAULT 'identified'")],
 ['short close initializes recoverables schema',po.includes('ensureSupplierRecoverablesSchema')],
 ['close-short creates shortage claim inside purchase transaction',po.includes('createShortageClaim(tx,{po,ownerEmployeeId:actor(req),reason})')],
 ['shortage amount derives from missing quantity and PO unit cost',lib.includes('quantity_ordered')&&lib.includes('quantity_received')&&lib.includes('missing_value:money(qty*Number(x.unit_cost||0))')],
 ['shortage claim remains identified instead of automatically confirmed',lib.includes("'shorted_goods','identified'")],
 ['duplicate shortage claim is prevented per purchase order',lib.includes("claim_type='shorted_goods'")&&lib.includes("source_type='purchase_order'")&&lib.includes('UNIQUE(claim_type,source_type,source_id)')],
 ['confirmation requires supplier document or confirmation note',route.includes('Supplier document number or confirmation note is required')],
 ['recovery requires confirmed claim',route.includes('Claim must be confirmed before recovery is recorded')],
 ['recovery cannot exceed confirmed outstanding',route.includes('Recovery amount exceeds confirmed outstanding balance')],
 ['settlements support credit note refund AP offset replacement and other',route.includes("'credit_note','cash_refund','bank_refund','ap_offset','replacement_value','other'")],
 ['settlement requires an auditable reference',route.includes('Recovery reference is required')],
 ['partial recovery remains open and full recovery closes',route.includes("'recovered':'partially_recovered'")],
 ['summary separates identified exposure confirmed outstanding overdue and recovered',route.includes('identified_exposure')&&route.includes('confirmed_outstanding')&&route.includes('overdue_confirmed')&&route.includes('recovered_total')],
 ['aging is based on confirmed outstanding only',route.includes('summary.aging[bucket]')&&route.includes('const identified=')&&route.includes('const confirmed=')],
 ['UI exposes Supplier Recoverables in purchasing navigation',ui.includes("tabBtn('recoverables','Supplier Recoverables')")&&ui.includes('renderSupplierRecoverables')],
 ['UI explicitly separates potential exposure from documented amount owed',ui.includes('Potential claim, not yet confirmed')&&ui.includes('Documented amount owed to us')],
 ['UI exposes aging and claim lifecycle amounts',ui.includes('Confirmed Recoverables Aging')&&ui.includes('Identified')&&ui.includes('Confirmed')&&ui.includes('Recovered')&&ui.includes('Outstanding')],
 ['UI can confirm supplier obligation and record recovery',ui.includes('_confirmSupplierRecoverable')&&ui.includes('_recoverSupplierRecoverable')],
 ['chart of accounts includes Supplier Recoverables asset',posting.includes("['1150','Supplier Recoverables','asset','debit']")],
 ['accounting basis is limited to evidenced shortage or invoice overcharge claims',route.includes("claim.claim_type==='shorted_goods'&&claim.source_type==='purchase_order'")&&route.includes("claim.claim_type==='overcharge'&&claim.source_type==='supplier_invoice'")],
 ['confirmed amount cannot fall below recovered amount',route.includes('Confirmed amount cannot be below amount already recovered')],
 ['AP offset requires recognized accounting basis and exact invoice',route.includes('AP offset requires a recognized supplier recoverable accounting basis')&&route.includes('supplier_invoice_id is required for AP offset')],
 ['AP offset invoice must belong to same supplier',route.includes('AP offset invoice must belong to the same supplier')],
 ['AP offset cannot exceed invoice balance',route.includes('AP offset exceeds supplier invoice balance')],
 ['AP allocation is durable and unique per settlement',lib.includes('supplier_recoverable_ap_allocations')&&lib.includes('settlement_id INTEGER NOT NULL UNIQUE')],
 ['supplier AP ledger includes recoverable offsets in invoice balances',ledger.includes('supplier_recoverable_ap_allocations')&&ledger.includes('UNION ALL SELECT supplier_invoice_id,amount FROM supplier_recoverable_ap_allocations')],
 ['supplier payment safety check also includes prior recoverable offsets',ledger.includes('UNION ALL SELECT amount FROM supplier_recoverable_ap_allocations WHERE supplier_invoice_id=?')],
 ['recoverable recognition posts Dr Supplier Recoverables and Cr purchasing clearing',sync.includes("code:'1150',debit:amount")&&sync.includes("code:'1250',debit:0,credit:amount")],
 ['AP offset journal posts Dr AP and Cr Supplier Recoverables',sync.includes("code:'2000',debit:amount")&&sync.includes("code:'1150',debit:0,credit:amount")&&sync.includes("sourceType:'supplier_recoverable_settlement'")],
 ['cash and bank refunds clear Supplier Recoverables without AP mutation',sync.includes("x.settlement_type==='cash_refund'?'1000':'1010'")],
 ['accounting sync posts supplier recoverables after invoices and payments',sync.indexOf('await syncSupplierRecoverables(req,stats);')>sync.indexOf('await syncSupplierPayments(req,stats);')],
 ['UI AP offset loads open invoices for same supplier',ui.includes("/supplier-ledger/invoices?supplier_id=")&&ui.includes('Select a valid open supplier invoice')],
 ['UI sends selected supplier invoice with AP offset',ui.includes("supplier_invoice_id});this.alert(settlement_type==='ap_offset'")]
];
let failed=0;
for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Supplier recoverables: ${name}`);if(!ok)failed++;}
if(failed){console.error(`Supplier recoverables contract FAILED (${failed}/${checks.length} failed).`);process.exit(1);}
console.log(`Supplier recoverables contract OK (${checks.length} checks).`);
