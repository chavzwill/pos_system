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
const creditNotes=require('./supplier-credit-notes');
const {validateMemoryUpload,evidenceMulterFilter}=require('../lib/uploadSecurity');

const storageDir=path.resolve(__dirname,'../private-evidence/supplier-statements');
const upload=multer({
  storage:multer.memoryStorage(),
  limits:{fileSize:15*1024*1024,files:1,fields:20,parts:21,fieldNameSize:100,fieldSize:512*1024,headerPairs:50},
  fileFilter:evidenceMulterFilter
});
let readyPromise=null;
async function ensureSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await ensureSupplierRecoverablesSchema();
    if(creditNotes.ensureSchema)await creditNotes.ensureSchema();
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS supplier_statements(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
        branch_id INTEGER REFERENCES branches(id),
        period_start TEXT,
        period_end TEXT NOT NULL,
        statement_reference TEXT,
        opening_balance REAL,
        closing_balance REAL NOT NULL,
        currency TEXT,
        notes TEXT,
        original_name TEXT,
        stored_name TEXT,
        mime_type TEXT,
        file_size INTEGER,
        created_by_employee_id INTEGER REFERENCES employees(id),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(supplier_id,period_end,statement_reference)
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS supplier_statement_lines(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        statement_id INTEGER NOT NULL REFERENCES supplier_statements(id) ON DELETE CASCADE,
        line_date TEXT,
        line_type TEXT NOT NULL,
        reference TEXT,
        amount REAL NOT NULL,
        description TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:'CREATE INDEX IF NOT EXISTS idx_supplier_statements_supplier_period ON supplier_statements(supplier_id,period_end)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_supplier_statement_lines_statement ON supplier_statement_lines(statement_id,line_type,reference)'}
    ],'write');
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
function actor(req){return req.employee?.id||req.user?.employee_id||null;}
function safeFileName(ext){return randomUUID().replaceAll('-','')+ext;}
function parseLines(raw){
  if(!raw)return [];
  let lines;try{lines=typeof raw==='string'?JSON.parse(raw):raw;}catch{throw new Error('Statement lines must be valid JSON');}
  if(!Array.isArray(lines))throw new Error('Statement lines must be an array');
  if(lines.length>500)throw new Error('Supplier statement cannot contain more than 500 lines');
  return lines.map((x,i)=>{
    const type=String(x?.line_type||'').trim().toLowerCase();
    if(!['invoice','payment','credit_note','debit_note','adjustment','other'].includes(type))throw new Error(`Unsupported statement line type at row ${i+1}`);
    const amount=money(x?.amount);
    if(!Number.isFinite(amount)||amount===0)throw new Error(`Statement line amount must be non-zero at row ${i+1}`);
    return {
      line_date:x?.line_date||null,line_type:type,reference:String(x?.reference||'').trim()||null,
      amount,description:String(x?.description||'').trim()||null
    };
  });
}
async function internalBalanceAsOf(supplierId,endDate,branchId=null){
  const invArgs=[supplierId,endDate],payArgs=[supplierId,endDate],offArgs=[supplierId,endDate];
  const branchSql=branchId?' AND i.branch_id=?':'';
  const invBranchSql=branchId?' AND branch_id=?':'';
  if(branchId){invArgs.push(branchId);payArgs.push(branchId);offArgs.push(branchId);}
  const {rows:[inv]}=await db.execute({sql:`SELECT COALESCE(SUM(total),0) amount FROM supplier_invoices
    WHERE supplier_id=? AND status!='void' AND date(invoice_date)<=date(?)${invBranchSql}`,args:invArgs});
  const {rows:[pay]}=await db.execute({sql:`SELECT COALESCE(SUM(a.amount),0) amount
    FROM supplier_payment_allocations a JOIN supplier_payments p ON p.id=a.payment_id
    JOIN supplier_invoices i ON i.id=a.supplier_invoice_id
    WHERE i.supplier_id=? AND date(p.payment_date)<=date(?)${branchSql}`,args:payArgs});
  const {rows:[off]}=await db.execute({sql:`SELECT COALESCE(SUM(a.amount),0) amount
    FROM supplier_recoverable_ap_allocations a
    JOIN supplier_recoverable_settlements rs ON rs.id=a.settlement_id
    JOIN supplier_invoices i ON i.id=a.supplier_invoice_id
    WHERE i.supplier_id=? AND date(rs.settlement_date)<=date(?)${branchSql}`,args:offArgs});
  return money(Number(inv?.amount||0)-Number(pay?.amount||0)-Number(off?.amount||0));
}
async function getStatement(id){
  const {rows:[row]}=await db.execute({sql:`SELECT st.*,s.name supplier_name,b.name branch_name
    FROM supplier_statements st JOIN suppliers s ON s.id=st.supplier_id
    LEFT JOIN branches b ON b.id=st.branch_id WHERE st.id=?`,args:[id]});
  if(!row)return null;
  const {rows:lines}=await db.execute({sql:'SELECT * FROM supplier_statement_lines WHERE statement_id=? ORDER BY COALESCE(line_date,\'9999-12-31\'),id',args:[id]});
  return {...row,lines};
}

router.use(requireAnyPermission('purchasing','reports_financial','accounts'));
router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Supplier statement initialization failed'});}});

router.get('/',async(req,res)=>{
  try{
    const args=[];let sql=`SELECT st.*,s.name supplier_name,b.name branch_name
      FROM supplier_statements st JOIN suppliers s ON s.id=st.supplier_id
      LEFT JOIN branches b ON b.id=st.branch_id WHERE 1=1`;
    if(req.query.supplier_id){sql+=' AND st.supplier_id=?';args.push(req.query.supplier_id);}
    sql+=' ORDER BY st.period_end DESC,st.id DESC LIMIT 300';
    const {rows}=await db.execute({sql,args});res.json(rows);
  }catch(e){res.status(500).json({error:e.message});}
});

router.post('/',upload.single('file'),async(req,res)=>{
  let storedPath=null;
  try{
    const supplierId=Number(req.body?.supplier_id),periodEnd=String(req.body?.period_end||'').trim();
    const closing=money(req.body?.closing_balance),opening=req.body?.opening_balance===''||req.body?.opening_balance===undefined?null:money(req.body.opening_balance);
    if(!supplierId||!periodEnd||!Number.isFinite(closing))return res.status(400).json({error:'Supplier, statement period end and closing balance are required'});
    if(opening!==null&&!Number.isFinite(opening))return res.status(400).json({error:'Opening balance must be numeric'});
    const {rows:[supplier]}=await db.execute({sql:'SELECT id FROM suppliers WHERE id=?',args:[supplierId]});
    if(!supplier)return res.status(404).json({error:'Supplier not found'});
    const lines=parseLines(req.body?.lines);
    let file={original_name:null,stored_name:null,mime_type:null,file_size:null};
    if(req.file){
      const validation=validateMemoryUpload(req.file,{kind:'evidence'});
      if(!validation.ok)return res.status(415).json({error:validation.error});
      fs.mkdirSync(storageDir,{recursive:true,mode:0o700});
      const stored=safeFileName(validation.extension);storedPath=path.join(storageDir,stored);
      fs.writeFileSync(storedPath,req.file.buffer,{mode:0o600});
      file={original_name:String(req.file.originalname||'supplier-statement').slice(0,255),stored_name:stored,mime_type:validation.mime,file_size:req.file.size};
    }
    const tx=await db.transaction('write');let committed=false;
    try{
      const r=await tx.execute({sql:`INSERT INTO supplier_statements(
        supplier_id,branch_id,period_start,period_end,statement_reference,opening_balance,closing_balance,currency,notes,
        original_name,stored_name,mime_type,file_size,created_by_employee_id
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:[
        supplierId,req.body?.branch_id?Number(req.body.branch_id):null,req.body?.period_start||null,periodEnd,
        String(req.body?.statement_reference||'').trim()||null,opening,closing,req.body?.currency||null,req.body?.notes||null,
        file.original_name,file.stored_name,file.mime_type,file.file_size,actor(req)
      ]});
      const id=Number(r.lastInsertRowid);
      for(const x of lines)await tx.execute({sql:`INSERT INTO supplier_statement_lines(statement_id,line_date,line_type,reference,amount,description)
        VALUES(?,?,?,?,?,?)`,args:[id,x.line_date,x.line_type,x.reference,x.amount,x.description]});
      await tx.commit();committed=true;
      res.status(201).json(await getStatement(id));
    }catch(e){if(!committed)try{await tx.rollback();}catch{}throw e;}
  }catch(e){
    if(storedPath)try{fs.unlinkSync(storedPath);}catch{}
    if(String(e.message||'').includes('UNIQUE'))return res.status(409).json({error:'This supplier statement reference is already recorded for the period'});
    res.status(400).json({error:e.message});
  }
});

router.get('/:id/reconciliation',async(req,res)=>{
  try{
    const st=await getStatement(req.params.id);if(!st)return res.status(404).json({error:'Supplier statement not found'});
    const internal=await internalBalanceAsOf(st.supplier_id,st.period_end,st.branch_id||null);
    const variance=money(Number(st.closing_balance||0)-Number(internal||0));
    const creditLines=(st.lines||[]).filter(x=>x.line_type==='credit_note');
    const creditArgs=[st.supplier_id,st.period_end];
    let creditSql=`SELECT id,credit_note_number,credit_date,amount,applied_amount,status
      FROM supplier_credit_notes WHERE supplier_id=? AND date(credit_date)<=date(?)`;
    if(st.period_start){creditSql+=' AND date(credit_date)>=date(?)';creditArgs.push(st.period_start);}
    creditSql+=' ORDER BY credit_date,id';
    const {rows:internalCredits}=await db.execute({sql:creditSql,args:creditArgs});
    const norm=v=>String(v||'').trim().toLowerCase();
    const matchedInternal=new Set();
    const missingInternalCredits=[];
    for(const line of creditLines){
      const byRef=internalCredits.find(c=>line.reference&&norm(c.credit_note_number)===norm(line.reference));
      const byAmount=!line.reference?internalCredits.find(c=>!matchedInternal.has(c.id)&&Math.abs(Math.abs(Number(line.amount))-Number(c.amount))<=0.01):null;
      const match=byRef||byAmount;
      if(match)matchedInternal.add(match.id);
      else missingInternalCredits.push({statement_line_id:line.id,reference:line.reference,amount:line.amount,line_date:line.line_date,description:line.description});
    }
    const internalCreditsMissingFromStatement=internalCredits
      .filter(c=>!matchedInternal.has(c.id))
      .map(c=>({credit_note_id:c.id,credit_note_number:c.credit_note_number,credit_date:c.credit_date,amount:c.amount,status:c.status}));
    const status=Math.abs(variance)<=0.01&&missingInternalCredits.length===0?'reconciled':'needs_review';
    res.json({
      statement_id:st.id,supplier_id:st.supplier_id,supplier_name:st.supplier_name,period_end:st.period_end,
      supplier_statement_closing_balance:money(st.closing_balance),internal_ap_balance_as_of:internal,variance,status,
      missing_internal_credit_notes:missingInternalCredits,
      internal_credit_notes_not_on_statement:internalCreditsMissingFromStatement,
      note:'Reconciliation is diagnostic only. It does not post invoices, payments, credit notes, AP offsets, or journal entries.'
    });
  }catch(e){res.status(500).json({error:e.message});}
});

router.get('/:id/file',async(req,res)=>{
  try{
    const st=await getStatement(req.params.id);if(!st)return res.status(404).json({error:'Supplier statement not found'});
    if(!st.stored_name)return res.status(404).json({error:'No supplier statement evidence file is attached'});
    const full=path.resolve(storageDir,st.stored_name);
    if(!full.startsWith(storageDir+path.sep)||!fs.existsSync(full))return res.status(404).json({error:'Supplier statement evidence file is unavailable'});
    res.setHeader('Content-Type',st.mime_type||'application/octet-stream');
    res.setHeader('Content-Disposition',`attachment; filename="${String(st.original_name||'supplier-statement').replace(/["\r\n]/g,'_')}"`);
    res.sendFile(full);
  }catch(e){res.status(500).json({error:'Unable to read supplier statement evidence'});}
});

router.get('/:id',async(req,res)=>{
  try{const st=await getStatement(req.params.id);if(!st)return res.status(404).json({error:'Supplier statement not found'});res.json(st);}
  catch(e){res.status(500).json({error:e.message});}
});

module.exports=router;
module.exports.ensureSchema=ensureSchema;
module.exports.internalBalanceAsOf=internalBalanceAsOf;
