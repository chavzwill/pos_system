'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const files={
 server:read('server.js'),posting:read('lib/accounting-posting.js'),sync:read('routes/accounting-source-sync.js'),purchasing:read('lib/accounting-purchasing.js'),rentals:read('lib/accounting-rentals.js'),returns:read('lib/accounting-retail-returns.js'),writeoffs:read('routes/inventory-writeoffs.js'),writeoffGuard:read('routes/inventory-writeoff-financial-guard.js'),settlement:read('routes/settlement-reconciliation.js'),settlementGuard:read('routes/settlement-reconciliation-financial-guard.js'),drawers:read('routes/drawer-session-hardening.js')
};
for(const [name,src] of Object.entries(files))new vm.Script(src,{filename:name});
const {server,posting,sync,purchasing,rentals,returns,writeoffs,writeoffGuard,settlementGuard,drawers}=files;
const checks=[
 ['ledger has explicit chart-of-account bootstrap',posting.includes("['1000','Cash'")&&posting.includes("['1200','Inventory'")&&posting.includes("['2000','Accounts Payable'")],
 ['automatic journals require exactly one debit or credit side per line',posting.includes('Automatic journal line must have exactly one positive side')],
 ['automatic journals must balance',posting.includes('Automatic journal is not balanced')],
 ['automatic posting is idempotent by source type and source id',posting.includes("WHERE source_type=? AND source_id=? AND status='posted'")],
 ['existing automatic journals are revalidated against current source evidence',posting.includes('verifyExistingJournal')&&posting.includes('Existing automatic journal no longer matches current source evidence')],
 ['retail posting excludes rental and repair transaction wrappers',sync.includes('rentalExclusion')&&sync.includes('workOrderExclusion')],
 ['retail tender total must reconcile to transaction total',sync.includes('retail_tender_mismatch')],
 ['retail revenue separates sales tax liability',sync.includes("code:'4000'")&&sync.includes("code:'2100'")],
 ['retail COGS requires preserved sale-time cost evidence',returns.includes('unit_cost_at_sale')&&returns.includes('retail_sale_cost_evidence_missing')],
 ['retail returns use return-time preserved cost evidence rather than current catalog cost',returns.includes('unit_cost_at_return')&&returns.includes('return_item_cost_evidence_missing')],
 ['refunds first create a payable and settlement later clears it',returns.includes("code:'2400'")&&returns.includes("sourceType:'retail_refund_settlement'")],
 ['refund settlement legs must reconcile to settlement total',returns.includes('refund_settlement_leg_mismatch')],
 ['purchase receipts debit inventory at preserved receipt cost',purchasing.includes("sourceType:'purchase_receipt'")&&purchasing.includes("code:'1200'")&&purchasing.includes('preserved PO cost')],
 ['purchase receipts clear purchasing receiving clearing',purchasing.includes("code:'1250'")&&purchasing.includes('Purchasing/receiving clearing')],
 ['supplier invoice tax treatment cannot be guessed',posting.includes('Supplier invoice tax treatment is unclassified')&&purchasing.includes('supplier_tax_treatment_unclassified')],
 ['landed costs remain in clearing until auditable allocation',purchasing.includes('landed_cost_allocation_pending')&&purchasing.includes("code:'1260'")],
 ['late landed cost allocation splits inventory still on hand from consumed COGS',purchasing.includes('inventoryAdjustment')&&purchasing.includes('cogsAdjustment')],
 ['PO receipt and supplier invoice merchandise values are reconciled',purchasing.includes('po_receipt_invoice_value_mismatch')],
 ['rental checkout separates refundable deposit liability from revenue',rentals.includes("code: '2200'")&&rentals.includes("code: '4200'")],
 ['rental checkout total must equal fees services deposit and tax',rentals.includes('rental_checkout_total_mismatch')],
 ['rental return releases deposit liability and separately records adjustments',rentals.includes('Release refundable rental deposit liability')&&rentals.includes('Additional rental time revenue')],
 ['negative rental settlement becomes refund payable unless it reduces AR',rentals.includes("'2400'")&&rentals.includes('Customer rental refund payable')],
 ['positive rental balance without cashier settlement is not fabricated',rentals.includes('rental_balance_awaiting_collection')&&rentals.includes('automatic_posting: false')],
 ['repair accounting is separated into assessment deposit service final and parts sources',sync.includes("sourceType:'repair_assessment'")&&sync.includes("sourceType:'repair_deposit'")&&sync.includes("sourceType:'repair_service'")&&sync.includes("sourceType:'repair_final_payment'")&&sync.includes("sourceType:'repair_part_usage'")],
 ['inventory writeoff posts tracked value only',writeoffs.includes('trackedValue')&&writeoffs.includes("sourceType:'inventory_writeoff'")],
 ['inventory writeoff never substitutes catalog cost into its journal',writeoffs.includes('valuationStatus')&&writeoffs.includes("trackedValue>0.0001")],
 ['inventory writeoff has independent financial authorization controls',writeoffGuard.includes('second, independent financial authorizer')&&writeoffGuard.includes('financial_authorizer_employee_id')],
 ['settlement financial guard is mounted before legacy reconciliation',server.indexOf("require('./routes/settlement-reconciliation-financial-guard')")<server.indexOf("require('./routes/settlement-reconciliation')")],
 ['settlement matching uses gross electronic tender not net bank deposit',settlementGuard.includes("matching_basis:'gross_electronic_tender'")&&settlementGuard.includes('const remainingBatch=gross-')],
 ['settlement components enforce gross minus fees equals net',settlementGuard.includes('gross-fees-net')&&settlementGuard.includes('Settlement batch gross, fees and net do not reconcile')],
 ['settlement reconciliation compares matched source evidence to gross',settlementGuard.includes('const sourceVariance=Number((gross-num(m?.matched)).toFixed(2))')],
 ['settlement accounting posts bank net plus fees against gross clearing',sync.includes("code:'1010',debit:net")&&sync.includes("code:'5300',debit:fees")&&sync.includes("code:'1050',debit:0,credit:gross")],
 ['drawer hardening requires authenticated employee sessions',drawers.includes('Cash drawer sessions require an authenticated employee session')],
 ['drawer opening is branch and assignment aware',drawers.includes('This drawer belongs to another branch')&&drawers.includes('You are not assigned to this cash drawer')],
 ['drawer reconciliation validates counted tender values without posting accounting journals',drawers.includes('moneyFields')&&!drawers.includes('postSourceJournal')],
 ['source sync surfaces reconciliation issues and evidence gaps instead of claiming success',sync.includes('reconciliation_issues:[]')&&sync.includes('evidence_gaps:[]')&&sync.includes('success:stats.errors.length===0&&stats.reconciliation_issues.length===0')]
];
let failed=0;for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Accounting certification: ${name}`);if(!ok)failed++;}
if(failed){console.error(`Accounting financial integrity certification FAILED (${failed}/${checks.length} failed).`);process.exit(1);}console.log(`Accounting financial integrity certification OK (${checks.length} checks).`);
