'use strict';
const express=require('express');
const multer=require('multer');
const path=require('path');
const fs=require('fs');
const {randomUUID}=require('crypto');
const router=express.Router();
const {db}=require('../database');
const {requireAnyPermission}=require('../lib/permissions');
const {ensureSupplierRecoverablesSchema,money}=require('../lib/supplier-recoverables');
const {confirmRecoverable}=require('../lib/supplier-recoverable-confirmation');
const {validateMemoryUpload,evidenceMulterFilter}=require('../lib/uploadSecurity');

const storageDir=path.resolve(__dirname,'../private-evidence/supplier-credit-notes');
const upload=multer({
  storage:multer.memoryStorage(),
  limits:{fileSize:10*1024*1024,files:1,fields:12,parts:13,fieldNameSize:100,fieldSize:64*1024,headerPairs:50},
  fileFilter:evidenceMulterFilter
});
let readyPromise=null;
async function ensureSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await ensureSupplierRecoverablesSchema();
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS supplier_credit_notes(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
        branch_id INTEGER REFERENCES branches(id),
        credit_note_number TEXT NOT NULL,
        credit_date TEXT NOT NULL,
        amount REAL NOT NULL,
        currency TEXT,
        status TEXT NOT NULL DEFAULT 'unmatched',
        applied_amount REAL NOT NULL DEFAULT 0,
        supplier_reference TEXT,
        notes TEXT,
        original_name TEXT,
        stored_name TEXT,
        mime_type TEXT,
        file_size INTEGER,
        created_by_employee_id INTEGER REFERENCES employees(id),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(supplier_id,credit_note_number)
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS supplier_credit_note_applications(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        credit_note_id INTEGER NOT NULL REFERENCES supplier_credit_notes(id),
        claim_id INTEGER NOT NULL REFERENCES supplier_recoverable_claims(id),
        amount REAL NOT NULL,
        settled_amount REAL NOT NULL DEFAULT 0,
        applied_by_employee_id INTEGER REFERENCES employees(id),
        applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(credit_note_id,claim_id)
      )`},
      {sql:'CREATE INDEX IF NOT EXISTS idx_supplier_credit_notes_supplier_status ON supplier_credit_notes(supplier_id,status,credit_date)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_supplier_credit_note_apps_claim ON supplier_credit_note_applications(claim_id,applied_at)'}
    ],'write');
    const appCols=(await db.execute({sql:'PRAGMA table_info(supplier_credit_note_applications)',args:[]})).rows.map(x=>String(x.name));
    if(!appCols.includes('settled_amount'))await db.execute({sql:'ALTER TABLE supplier_credit_note_applications ADD COLUMN settled_amount REAL NOT NULL DEFAULT 0',args:[]});
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
function actor(req){return req.employee?.id||req.user?.employee_id||null;}
function safeFileName(ext){return randomUUID().replaceAll('-','')+ext;}
function remaining(note){return money(Math.max(0,Number(note.amount||0)-Number(note.applied_amount||0)));}

router.use(requireAnyPermission('purchasing','reports_financial','accounts'));
router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Supplier credit-note initialization failed'});}});

router.get('/',async(req,res)=>{
  try{
    let sql=`SELECT n.*,s.name supplier_name,b.name branch_name,
      ROUND(MAX(0,n.amount-n.applied_amount),2) remaining_amount
      FROM supplier_credit_notes n
      JOIN suppliers s ON s.id=n.supplier_id
      LEFT JOIN branches b ON b.id=n.branch_id WHERE 1=1`;
    const args=[];
    if(req.query.supplier_id){sql+=' AND n.supplier_id=?';args.push(req.query.supplier_id);}
    if(req.query.status){sql+=' AND n.status=?';args.push(req.query.status);}
    sql+=' ORDER BY n.credit_date DESC,n.id DESC LIMIT 500';
    const {rows}=await db.execute({sql,args});res.json(rows);
  }catch(e){res.status(500).json({error:e.message});}
});

router.post('/',upload.single('file'),async(req,res)=>{
  let storedPath=null;
  try{
    const supplierId=Number(req.body?.supplier_id),amount=money(req.body?.amount);
    const number=String(req.body?.credit_note_number||'').trim(),date=String(req.body?.credit_date||'').trim();
    if(!supplierId||!number||!date||!Number.isFinite(amount)||amount<=0)return res.status(400).json({error:'Supplier, credit note number, date and positive amount are required'});
    const {rows:[supplier]}=await db.execute({sql:'SELECT id FROM suppliers WHERE id=?',args:[supplierId]});
    if(!supplier)return res.status(404).json({error:'Supplier not found'});
    let file={original_name:null,stored_name:null,mime_type:null,file_size:null};
    if(req.file){
      const validation=validateMemoryUpload(req.file,{kind:'evidence'});
      if(!validation.ok)return res.status(415).json({error:validation.error});
      fs.mkdirSync(storageDir,{recursive:true,mode:0o700});
      const stored=safeFileName(validation.extension);
      storedPath=path.join(storageDir,stored);
      fs.writeFileSync(storedPath,req.file.buffer,{mode:0o600});
      file={original_name:String(req.file.originalname||'credit-note').slice(0,255),stored_name:stored,mime_type:validation.mime,file_size:req.file.size};
    }
    const r=await db.execute({sql:`INSERT INTO supplier_credit_notes(
      supplier_id,branch_id,credit_note_number,credit_date,amount,currency,supplier_reference,notes,
      original_name,stored_name,mime_type,file_size,created_by_employee_id
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:[
      supplierId,req.body?.branch_id?Number(req.body.branch_id):null,number,date,amount,req.body?.currency||null,
      req.body?.supplier_reference||null,req.body?.notes||null,file.original_name,file.stored_name,file.mime_type,file.file_size,actor(req)
    ]});
    const {rows:[row]}=await db.execute({sql:'SELECT * FROM supplier_credit_notes WHERE id=?',args:[Number(r.lastInsertRowid)]});
    res.status(201).json({...row,remaining_amount:amount});
  }catch(e){
    if(storedPath)try{fs.unlinkSync(storedPath);}catch{}
    if(String(e.message||'').includes('UNIQUE'))return res.status(409).json({error:'This supplier credit note number is already recorded'});
    res.status(400).json({error:e.message});
  }
});

router.get('/:id/matches',async(req,res)=>{
  try{
    const {rows:[note]}=await db.execute({sql:'SELECT * FROM supplier_credit_notes WHERE id=?',args:[req.params.id]});
    if(!note)return res.status(404).json({error:'Supplier credit note not found'});
    const {rows}=await db.execute({sql:`SELECT c.*,ROUND(MAX(0,c.identified_amount-c.confirmed_amount),2) unconfirmed_amount,
      ROUND(MAX(0,c.confirmed_amount-c.recovered_amount),2) outstanding_amount,
      ROUND(COALESCE((SELECT SUM(a.amount-a.settled_amount) FROM supplier_credit_note_applications a WHERE a.claim_id=c.id),0),2) reserved_credit_note_amount
      FROM supplier_recoverable_claims c
      WHERE c.supplier_id=? AND c.status NOT IN ('recovered','cancelled')
      ORDER BY CASE WHEN c.source_reference=? THEN 0 ELSE 1 END,
        CASE c.status WHEN 'identified' THEN 0 WHEN 'confirmed' THEN 1 ELSE 2 END,
        c.obligation_date,c.id`,args:[note.supplier_id,note.supplier_reference||'']});
    res.json({credit_note:{...note,remaining_amount:remaining(note)},matches:rows.map(c=>({...c,matchable_amount:money(Math.max(0,Math.max(Number(c.identified_amount||0),Number(c.confirmed_amount||0))-Number(c.recovered_amount||0)-Number(c.reserved_credit_note_amount||0)))}))});
  }catch(e){res.status(500).json({error:e.message});}
});

router.post('/:id/applications',async(req,res)=>{
  const tx=await db.transaction('write');let committed=false;
  try{
    const {rows:[note]}=await tx.execute({sql:'SELECT * FROM supplier_credit_notes WHERE id=?',args:[req.params.id]});
    if(!note)throw new Error('Supplier credit note not found');
    const {rows:[claim]}=await tx.execute({sql:'SELECT * FROM supplier_recoverable_claims WHERE id=?',args:[req.body?.claim_id]});
    if(!claim)throw new Error('Recoverable claim not found');
    if(Number(claim.supplier_id)!==Number(note.supplier_id))throw new Error('Credit note and recoverable claim must belong to the same supplier');
    if(['recovered','cancelled'].includes(claim.status))throw new Error('Closed recoverable claim cannot receive a credit note');
    const amount=money(req.body?.amount);
    if(!Number.isFinite(amount)||amount<=0)throw new Error('Application amount must be greater than zero');
    const noteRemaining=remaining(note);
    if(amount>noteRemaining+0.01)throw new Error('Application amount exceeds remaining credit note balance');
    const {rows:[reserved]}=await tx.execute({sql:'SELECT COALESCE(SUM(amount-settled_amount),0) amount FROM supplier_credit_note_applications WHERE claim_id=?',args:[claim.id]});
    const openExposure=money(Math.max(0,Math.max(Number(claim.identified_amount||0),Number(claim.confirmed_amount||0))-Number(claim.recovered_amount||0)));
    const claimCapacity=money(Math.max(0,openExposure-Number(reserved?.amount||0)));
    if(claimCapacity<=0)throw new Error('Recoverable claim has no unmatched balance available for another credit note');
    if(amount>claimCapacity+0.01)throw new Error('Application amount exceeds unmatched recoverable balance');
    const existing=await tx.execute({sql:'SELECT id FROM supplier_credit_note_applications WHERE credit_note_id=? AND claim_id=?',args:[note.id,claim.id]});
    if(existing.rows.length)throw new Error('This credit note is already applied to the selected recoverable claim');

    await tx.execute({sql:'INSERT INTO supplier_credit_note_applications(credit_note_id,claim_id,amount,applied_by_employee_id) VALUES(?,?,?,?)',args:[note.id,claim.id,amount,actor(req)]});
    const newApplied=money(Number(note.applied_amount||0)+amount);
    const noteStatus=newApplied+0.01>=Number(note.amount||0)?'fully_matched':'partially_matched';
    await tx.execute({sql:'UPDATE supplier_credit_notes SET applied_amount=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',args:[newApplied,noteStatus,note.id]});

    const unconfirmed=money(Math.max(0,Number(claim.identified_amount||0)-Number(claim.confirmed_amount||0)));
    let confirmed=claim;
    if(unconfirmed>0){
      const newlyConfirmed=money(Math.min(amount,unconfirmed));
      confirmed=await confirmRecoverable(tx,claim,{
        confirmedAmount:money(Number(claim.confirmed_amount||0)+newlyConfirmed),
        supplierDocumentNumber:note.credit_note_number,
        confirmationNote:`Confirmed from supplier credit note ${note.credit_note_number}`,
        sourceCreditNoteId:note.id
      });
    }

    await tx.commit();committed=true;
    res.status(201).json({credit_note_id:note.id,claim:confirmed,applied_amount:amount,credit_note_remaining:money(Number(note.amount)-newApplied)});
  }catch(e){if(!committed)try{await tx.rollback();}catch{}res.status(400).json({error:e.message});}
});

router.post('/:id/applications/:applicationId/settle-ap',async(req,res)=>{
  const tx=await db.transaction('write');let committed=false;
  try{
    const {rows:[note]}=await tx.execute({sql:'SELECT * FROM supplier_credit_notes WHERE id=?',args:[req.params.id]});
    const {rows:[app]}=await tx.execute({sql:'SELECT * FROM supplier_credit_note_applications WHERE id=? AND credit_note_id=?',args:[req.params.applicationId,req.params.id]});
    if(!note||!app)throw new Error('Credit note application not found');
    const {rows:[claim]}=await tx.execute({sql:'SELECT * FROM supplier_recoverable_claims WHERE id=?',args:[app.claim_id]});
    if(!claim)throw new Error('Recoverable claim not found');
    const {rows:[basis]}=await tx.execute({sql:'SELECT * FROM supplier_recoverable_accounting_basis WHERE claim_id=?',args:[claim.id]});
    if(!basis)throw new Error('AP settlement requires a recognized recoverable accounting basis');
    const invoiceId=Number(req.body?.supplier_invoice_id);
    if(!invoiceId)throw new Error('supplier_invoice_id is required');
    const {rows:[inv]}=await tx.execute({sql:"SELECT * FROM supplier_invoices WHERE id=? AND status!='void'",args:[invoiceId]});
    if(!inv||Number(inv.supplier_id)!==Number(note.supplier_id))throw new Error('Selected invoice must belong to the credit-note supplier');
    const amount=money(req.body?.amount??(Number(app.amount||0)-Number(app.settled_amount||0)));
    if(!Number.isFinite(amount)||amount<=0)throw new Error('Settlement amount must be greater than zero');
    const applicationRemaining=money(Number(app.amount||0)-Number(app.settled_amount||0));
    if(amount>applicationRemaining+0.01)throw new Error('Settlement amount exceeds unmatched credit note application balance');
    const claimOutstanding=money(Number(claim.confirmed_amount||0)-Number(claim.recovered_amount||0));
    if(amount>claimOutstanding+0.01)throw new Error('Settlement amount exceeds recoverable outstanding balance');
    const {rows:[paid]}=await tx.execute({sql:'SELECT COALESCE(SUM(amount),0) amount FROM supplier_payment_allocations WHERE supplier_invoice_id=?',args:[invoiceId]});
    const {rows:[offset]}=await tx.execute({sql:'SELECT COALESCE(SUM(amount),0) amount FROM supplier_recoverable_ap_allocations WHERE supplier_invoice_id=?',args:[invoiceId]});
    const invoiceBalance=money(Number(inv.total||0)-Number(paid?.amount||0)-Number(offset?.amount||0));
    if(amount>invoiceBalance+0.01)throw new Error('Settlement amount exceeds supplier invoice balance');

    const settlement=await tx.execute({sql:`INSERT INTO supplier_recoverable_settlements(
      claim_id,settlement_type,amount,reference,settlement_date,evidence_json,recorded_by_employee_id
    ) VALUES(?,?,?,?,?,?,?)`,args:[claim.id,'ap_offset',amount,note.credit_note_number,new Date().toISOString(),JSON.stringify({supplierCreditNoteId:note.id,creditNoteApplicationId:app.id}),actor(req)]});
    const settlementId=Number(settlement.lastInsertRowid);
    await tx.execute({sql:'INSERT INTO supplier_recoverable_ap_allocations(settlement_id,claim_id,supplier_invoice_id,amount) VALUES(?,?,?,?)',args:[settlementId,claim.id,invoiceId,amount]});
    const newRecovered=money(Number(claim.recovered_amount||0)+amount);
    const claimStatus=newRecovered+0.01>=Number(claim.confirmed_amount||0)?'recovered':'partially_recovered';
    await tx.execute({sql:`UPDATE supplier_recoverable_claims SET recovered_amount=?,status=?,updated_at=CURRENT_TIMESTAMP,
      recovered_at=CASE WHEN ?='recovered' THEN CURRENT_TIMESTAMP ELSE NULL END WHERE id=?`,args:[newRecovered,claimStatus,claimStatus,claim.id]});
    const newSettled=money(Number(app.settled_amount||0)+amount);
    await tx.execute({sql:'UPDATE supplier_credit_note_applications SET settled_amount=? WHERE id=?',args:[newSettled,app.id]});

    await tx.commit();committed=true;
    res.status(201).json({credit_note_id:note.id,application_id:app.id,claim_id:claim.id,supplier_invoice_id:invoiceId,settled_amount:amount});
  }catch(e){if(!committed)try{await tx.rollback();}catch{}res.status(400).json({error:e.message});}
});

router.get('/:id/file',async(req,res)=>{
  try{
    const {rows:[note]}=await db.execute({sql:'SELECT * FROM supplier_credit_notes WHERE id=?',args:[req.params.id]});
    if(!note)return res.status(404).json({error:'Supplier credit note not found'});
    if(!note.stored_name)return res.status(404).json({error:'No credit-note file is attached'});
    const full=path.resolve(storageDir,note.stored_name);
    if(!full.startsWith(storageDir+path.sep)||!fs.existsSync(full))return res.status(404).json({error:'Credit-note evidence file is unavailable'});
    res.setHeader('Content-Type',note.mime_type||'application/octet-stream');
    res.setHeader('Content-Disposition',`attachment; filename="${String(note.original_name||'credit-note').replace(/["\r\n]/g,'_')}"`);
    res.sendFile(full);
  }catch(e){res.status(500).json({error:'Unable to read supplier credit-note evidence'});}
});

router.get('/:id',async(req,res)=>{
  try{
    const {rows:[note]}=await db.execute({sql:`SELECT n.*,s.name supplier_name,b.name branch_name,
      ROUND(MAX(0,n.amount-n.applied_amount),2) remaining_amount
      FROM supplier_credit_notes n JOIN suppliers s ON s.id=n.supplier_id
      LEFT JOIN branches b ON b.id=n.branch_id WHERE n.id=?`,args:[req.params.id]});
    if(!note)return res.status(404).json({error:'Supplier credit note not found'});
    const {rows:applications}=await db.execute({sql:`SELECT a.*,c.claim_number,c.claim_type,c.source_reference,
      ROUND(MAX(0,a.amount-a.settled_amount),2) unsettled_amount
      FROM supplier_credit_note_applications a
      JOIN supplier_recoverable_claims c ON c.id=a.claim_id
      WHERE a.credit_note_id=? ORDER BY a.id`,args:[note.id]});
    res.json({...note,applications});
  }catch(e){res.status(500).json({error:e.message});}
});

module.exports=router;
module.exports.ensureSchema=ensureSchema;
