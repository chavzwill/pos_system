'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const route=read('routes/supplier-statements.js');
const server=read('server.js');
const ui=read('public/index.html');
new vm.Script(route,{filename:'supplier-statements.js'});
const checks=[
 ['supplier statements route is mounted',server.includes("app.use('/api/supplier-statements'")],
 ['statements require purchasing or finance authority',route.includes("requireAnyPermission('purchasing','reports_financial','accounts')")],
 ['statement header and lines are durable',route.includes('CREATE TABLE IF NOT EXISTS supplier_statements')&&route.includes('CREATE TABLE IF NOT EXISTS supplier_statement_lines')],
 ['statement records are immutable after creation in application code',!route.includes('UPDATE supplier_statements')&&!route.includes('DELETE FROM supplier_statements')&&!route.includes('UPDATE supplier_statement_lines')&&!route.includes('DELETE FROM supplier_statement_lines')],
 ['statement line types are explicitly bounded',route.includes("['invoice','payment','credit_note','debit_note','adjustment','other']")],
 ['statement line volume is bounded',route.includes('cannot contain more than 500 lines')],
 ['statement lines require non-zero numeric amount',route.includes('Statement line amount must be non-zero')],
 ['statement evidence upload is memory buffered and size limited',route.includes('multer.memoryStorage()')&&route.includes('fileSize:15*1024*1024')],
 ['statement evidence uses signature-aware validation',route.includes("validateMemoryUpload(req.file,{kind:'evidence'})")&&route.includes('evidenceMulterFilter')],
 ['statement evidence is stored outside public uploads with restrictive permissions',route.includes("../private-evidence/supplier-statements")&&route.includes('mode:0o700')&&route.includes('mode:0o600')],
 ['statement evidence download is path safe',route.includes("router.get('/:id/file'")&&route.includes('full.startsWith(storageDir+path.sep)')],
 ['historical AP includes only invoices posted by statement end date',route.includes("date(invoice_date)<=date(?)")],
 ['historical AP subtracts supplier payments by payment date',route.includes("date(p.payment_date)<=date(?)")],
 ['historical AP subtracts recoverable offsets by settlement date',route.includes('supplier_recoverable_settlements rs')&&route.includes("date(rs.settlement_date)<=date(?)")],
 ['branch-specific statements compare branch-specific AP',route.includes("const branchSql=branchId?' AND i.branch_id=?':''")&&route.includes("const invBranchSql=branchId?' AND branch_id=?':''")],
 ['reconciliation passes statement branch into AP as-of calculation',route.includes('internalBalanceAsOf(st.supplier_id,st.period_end,st.branch_id||null)')],
 ['supplier statement closing balance is compared to internal AP',route.includes('supplier_statement_closing_balance')&&route.includes('internal_ap_balance_as_of')&&route.includes('variance')],
 ['statement credit-note lines are cross-checked to internal credit notes',route.includes("line_type==='credit_note'")&&route.includes('supplier_credit_notes')],
 ['credit-note cross-check respects statement period start when present',route.includes("if(st.period_start){creditSql+=' AND date(credit_date)>=date(?)'")],
 ['missing internal credit notes are surfaced',route.includes('missing_internal_credit_notes')],
 ['internal credits absent from statement are surfaced',route.includes('internal_credit_notes_not_on_statement')],
 ['reconciliation is diagnostic only and does not mutate accounting',route.includes('Reconciliation is diagnostic only')&&!route.includes('INSERT INTO supplier_invoices')&&!route.includes('INSERT INTO supplier_payments')&&!route.includes('INSERT INTO supplier_recoverable_ap_allocations')],
 ['UI exposes Statements from Purchasing',ui.includes("tabBtn('supplier-statements','Statements')")&&ui.includes('renderSupplierStatements')],
 ['UI accepts simple human-readable statement line format',ui.includes('Format: type | date | reference | amount | description')],
 ['UI records statement through multipart FormData',ui.includes("fetch('/api/supplier-statements',{method:'POST',body:fd})")],
 ['UI exposes statement reconciliation',ui.includes('_reconcileSupplierStatement')&&ui.includes('Internal AP as of')],
 ['UI explicitly says reconciliation does not change AP',ui.includes('does not change AP')&&ui.includes('coordination cases only')]
];
let failed=0;
for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Supplier statements: ${name}`);if(!ok)failed++;}
if(failed){console.error(`Supplier statements contract FAILED (${failed}/${checks.length} failed).`);process.exit(1);}
console.log(`Supplier statements contract OK (${checks.length} checks).`);
