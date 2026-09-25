'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const route=read('routes/supplier-credit-notes.js');
const recoverables=read('routes/supplier-recoverables.js');
const confirmation=read('lib/supplier-recoverable-confirmation.js');
const server=read('server.js');
const ui=read('public/index.html');
for(const [name,src] of Object.entries({route,recoverables,confirmation}))new vm.Script(src,{filename:name});
const checks=[
 ['supplier credit-note route is mounted',server.includes("app.use('/api/supplier-credit-notes'")],
 ['credit notes require purchasing or finance authority',route.includes("requireAnyPermission('purchasing','reports_financial','accounts')")],
 ['credit note and application ledgers are durable',route.includes('CREATE TABLE IF NOT EXISTS supplier_credit_notes')&&route.includes('CREATE TABLE IF NOT EXISTS supplier_credit_note_applications')],
 ['credit note number is unique per supplier',route.includes('UNIQUE(supplier_id,credit_note_number)')],
 ['credit note starts unmatched rather than recovered',route.includes("status TEXT NOT NULL DEFAULT 'unmatched'")],
 ['one credit note can cover multiple claims but not duplicate the same claim application',route.includes('UNIQUE(credit_note_id,claim_id)')],
 ['application settlement amount is durable',route.includes('settled_amount REAL NOT NULL DEFAULT 0')],
 ['legacy/cold-start application schema gains settled amount safely',route.includes("PRAGMA table_info(supplier_credit_note_applications)")&&route.includes("ALTER TABLE supplier_credit_note_applications ADD COLUMN settled_amount")],
 ['evidence upload is memory buffered and size limited',route.includes('multer.memoryStorage()')&&route.includes('fileSize:10*1024*1024')],
 ['evidence upload uses signature-aware validation',route.includes("validateMemoryUpload(req.file,{kind:'evidence'})")&&route.includes('evidenceMulterFilter')],
 ['credit-note evidence is stored outside public uploads',route.includes("../private-evidence/supplier-credit-notes")&&!route.includes("folder:'pos-system")],
 ['local evidence files use restrictive mode',route.includes('mode:0o700')&&route.includes('mode:0o600')],
 ['duplicate supplier document numbers fail closed',route.includes('This supplier credit note number is already recorded')],
 ['matching candidates are restricted to same supplier',route.includes('WHERE c.supplier_id=?')],
 ['matching surfaces both unconfirmed and confirmed outstanding balances',route.includes('unconfirmed_amount')&&route.includes('outstanding_amount')],
 ['matching subtracts unmatched credit-note reservations',route.includes('reserved_credit_note_amount')&&route.includes('matchable_amount')],
 ['cross-supplier application is rejected',route.includes('Credit note and recoverable claim must belong to the same supplier')],
 ['credit note cannot be over-applied',route.includes('Application amount exceeds remaining credit note balance')],
 ['claim cannot be over-reserved by credit notes',route.includes('Application amount exceeds unmatched recoverable balance')],
 ['same credit note cannot be applied twice to same claim',route.includes('This credit note is already applied to the selected recoverable claim')],
 ['matched status is distinct from settlement',route.includes("'fully_matched':'partially_matched'")&&ui.includes('Settled to AP')&&ui.includes('Remaining to match')],
 ['credit note confirms only the still-unconfirmed part of a claim',route.includes('const unconfirmed=')&&route.includes('Math.min(amount,unconfirmed)')],
 ['credit-note confirmation uses shared recoverable authority',route.includes('confirmRecoverable(tx,claim')&&route.includes('sourceCreditNoteId:note.id')],
 ['manual confirmation also uses shared authority',recoverables.includes('confirmRecoverable(tx,claim')],
 ['shared authority preserves purchasing and supplier-return accounting rules',confirmation.includes("purchasing_receiving_clearing")&&confirmation.includes("supplier_return_clearing")],
 ['AP settlement requires recognized accounting basis',route.includes('AP settlement requires a recognized recoverable accounting basis')],
 ['AP settlement requires exact supplier invoice',route.includes('Selected invoice must belong to the credit-note supplier')],
 ['AP settlement cannot exceed unmatched application balance',route.includes('Settlement amount exceeds unmatched credit note application balance')],
 ['AP settlement cannot exceed claim outstanding',route.includes('Settlement amount exceeds recoverable outstanding balance')],
 ['AP settlement cannot exceed invoice balance',route.includes('Settlement amount exceeds supplier invoice balance')],
 ['AP settlement creates normal recoverable settlement evidence',route.includes("settlement_type,amount,reference")&&route.includes("'ap_offset',amount,note.credit_note_number")],
 ['AP settlement creates exact invoice allocation',route.includes('INSERT INTO supplier_recoverable_ap_allocations')],
 ['AP settlement updates claim recovery lifecycle',route.includes("claimStatus=newRecovered+0.01>=Number(claim.confirmed_amount||0)?'recovered':'partially_recovered'")],
 ['AP settlement updates application settled amount',route.includes('UPDATE supplier_credit_note_applications SET settled_amount=?')],
 ['evidence download is authenticated through protected router and path-safe',route.includes("router.get('/:id/file'")&&route.includes('full.startsWith(storageDir+path.sep)')],
 ['evidence download sanitizes response filename',route.includes("replace(/[\"\\r\\n]/g,'_')")],
 ['UI exposes Credit Notes from Purchasing',ui.includes("tabBtn('supplier-credit-notes','Credit Notes')")&&ui.includes('renderSupplierCreditNotes')],
 ['UI records source document through multipart FormData',ui.includes('const fd=new FormData()')&&ui.includes("fetch('/api/supplier-credit-notes',{method:'POST',body:fd})")],
 ['UI matches only backend-provided supplier claims',ui.includes("'/supplier-credit-notes/'+id+'/matches")&&ui.includes('Select a valid recoverable claim')],
 ['UI uses backend matchable capacity not raw unconfirmed amount',ui.includes('claim.matchable_amount')],
 ['UI can continue matched credit into AP settlement',ui.includes('_showSupplierCreditNoteApplications')&&ui.includes("'/applications/'+appId+'/settle-ap'")],
 ['UI distinguishes no-open-invoice from document matching',ui.includes('the credit remains matched but unsettled')]
];
let failed=0;
for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Supplier credit notes: ${name}`);if(!ok)failed++;}
if(failed){console.error(`Supplier credit-note contract FAILED (${failed}/${checks.length} failed).`);process.exit(1);}
console.log(`Supplier credit-note contract OK (${checks.length} checks).`);
