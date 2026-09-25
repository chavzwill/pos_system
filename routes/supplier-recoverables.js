'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requireAnyPermission}=require('../lib/permissions');
const {ensureSupplierRecoverablesSchema,money,nextClaimNumber}=require('../lib/supplier-recoverables');

router.use(requireAnyPermission('purchasing','reports_financial','accounts'));
router.use(async(req,res,next)=>{try{await ensureSupplierRecoverablesSchema();next();}catch(e){res.status(500).json({error:'Supplier recoverables initialization failed'});}});

function actor(req){return req.employee?.id||req.user?.employee_id||null;}
function agingBucket(dueDate,obligationDate){
  const base=dueDate||obligationDate;
  if(!base)return 'undated';
  const days=Math.floor((Date.now()-new Date(base).getTime())/86400000);
  if(days<=0)return 'current';
  if(days<=30)return '1_30';
  if(days<=60)return '31_60';
  if(days<=90)return '61_90';
  return '90_plus';
}

router.get('/',async(req,res)=>{
  try{
    let sql=`SELECT c.*,s.name supplier_name,b.name branch_name,
      ROUND(MAX(0,c.confirmed_amount-c.recovered_amount),2) outstanding_amount
      FROM supplier_recoverable_claims c
      LEFT JOIN suppliers s ON s.id=c.supplier_id
      LEFT JOIN branches b ON b.id=c.branch_id WHERE 1=1`;
    const args=[];
    if(req.query.status){sql+=' AND c.status=?';args.push(req.query.status);}
    if(req.query.supplier_id){sql+=' AND c.supplier_id=?';args.push(req.query.supplier_id);}
    if(req.query.claim_type){sql+=' AND c.claim_type=?';args.push(req.query.claim_type);}
    sql+=' ORDER BY CASE c.status WHEN \'confirmed\' THEN 0 WHEN \'partially_recovered\' THEN 1 WHEN \'identified\' THEN 2 ELSE 3 END, COALESCE(c.due_date,c.obligation_date),c.id DESC LIMIT 500';
    const {rows}=await db.execute({sql,args});
    res.json(rows.map(x=>({...x,aging_bucket:agingBucket(x.due_date,x.obligation_date)})));
  }catch(e){res.status(500).json({error:e.message});}
});

router.get('/summary',async(req,res)=>{
  try{
    const {rows}=await db.execute({sql:`SELECT * FROM supplier_recoverable_claims
      WHERE status NOT IN ('cancelled')`,args:[]});
    const summary={identified_exposure:0,confirmed_outstanding:0,recovered_total:0,claim_count:rows.length,overdue_confirmed:0,aging:{current:0,'1_30':0,'31_60':0,'61_90':0,'90_plus':0,undated:0}};
    for(const x of rows){
      const identified=Number(x.identified_amount||0),confirmed=Number(x.confirmed_amount||0),recovered=Number(x.recovered_amount||0),out=Math.max(0,confirmed-recovered);
      if(x.status==='identified')summary.identified_exposure+=identified;
      summary.confirmed_outstanding+=out;summary.recovered_total+=recovered;
      const bucket=agingBucket(x.due_date,x.obligation_date);
      summary.aging[bucket]=(summary.aging[bucket]||0)+out;
      if(out>0&&x.due_date&&new Date(x.due_date)<new Date())summary.overdue_confirmed+=out;
    }
    for(const k of ['identified_exposure','confirmed_outstanding','recovered_total','overdue_confirmed'])summary[k]=money(summary[k]);
    for(const k of Object.keys(summary.aging))summary.aging[k]=money(summary.aging[k]);
    res.json(summary);
  }catch(e){res.status(500).json({error:e.message});}
});

router.post('/',async(req,res)=>{
  try{
    const type=String(req.body?.claim_type||'').trim();
    if(!['credit_note','supplier_return','shorted_goods','overcharge','damaged_goods','rebate','reimbursement','other'].includes(type))return res.status(400).json({error:'Unsupported recoverable claim type'});
    const supplierId=Number(req.body?.supplier_id),identified=money(req.body?.identified_amount);
    if(!supplierId)return res.status(400).json({error:'Supplier is required'});
    if(!Number.isFinite(identified)||identified<=0)return res.status(400).json({error:'Identified amount must be greater than zero'});
    const {rows:[supplier]}=await db.execute({sql:'SELECT id,name FROM suppliers WHERE id=?',args:[supplierId]});
    if(!supplier)return res.status(404).json({error:'Supplier not found'});
    const number=await nextClaimNumber();
    const status=req.body?.confirmed===true?'confirmed':'identified';
    const confirmed=status==='confirmed'?money(req.body?.confirmed_amount??identified):0;
    if(status==='confirmed'&&(!Number.isFinite(confirmed)||confirmed<=0))return res.status(400).json({error:'Confirmed amount must be greater than zero'});
    const r=await db.execute({sql:`INSERT INTO supplier_recoverable_claims(
      claim_number,supplier_id,branch_id,claim_type,status,source_type,source_id,source_reference,currency,
      identified_amount,confirmed_amount,obligation_date,due_date,supplier_document_number,owner_employee_id,notes,evidence_json,confirmed_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CASE WHEN ?='confirmed' THEN CURRENT_TIMESTAMP ELSE NULL END)`,args:[
      number,supplierId,req.body?.branch_id||null,type,status,req.body?.source_type||null,req.body?.source_id?String(req.body.source_id):null,
      req.body?.source_reference||null,req.body?.currency||null,identified,confirmed,req.body?.obligation_date||new Date().toISOString(),
      req.body?.due_date||null,req.body?.supplier_document_number||null,req.body?.owner_employee_id||actor(req),req.body?.notes||null,
      JSON.stringify(req.body?.evidence||{}),status
    ]});
    const {rows:[row]}=await db.execute({sql:'SELECT * FROM supplier_recoverable_claims WHERE id=?',args:[Number(r.lastInsertRowid)]});
    res.status(201).json(row);
  }catch(e){res.status(400).json({error:e.message});}
});

router.post('/:id/confirm',async(req,res)=>{
  try{
    const {rows:[claim]}=await db.execute({sql:'SELECT * FROM supplier_recoverable_claims WHERE id=?',args:[req.params.id]});
    if(!claim)return res.status(404).json({error:'Recoverable claim not found'});
    if(['recovered','cancelled'].includes(claim.status))return res.status(409).json({error:'Closed recoverable claim cannot be confirmed'});
    const amount=money(req.body?.confirmed_amount??claim.identified_amount);
    if(!Number.isFinite(amount)||amount<=0)return res.status(400).json({error:'Confirmed amount must be greater than zero'});
    if(amount+0.01<Number(claim.recovered_amount||0))return res.status(409).json({error:'Confirmed amount cannot be below amount already recovered'});
    const doc=String(req.body?.supplier_document_number||claim.supplier_document_number||'').trim();
    const note=String(req.body?.confirmation_note||'').trim();
    if(!doc&&!note)return res.status(400).json({error:'Supplier document number or confirmation note is required'});
    const tx=await db.transaction('write');let committed=false;
    try{
      await tx.execute({sql:`UPDATE supplier_recoverable_claims SET status=CASE WHEN recovered_amount>0 THEN 'partially_recovered' ELSE 'confirmed' END,
        confirmed_amount=?,due_date=COALESCE(?,due_date),supplier_document_number=COALESCE(?,supplier_document_number),
        notes=CASE WHEN ?!='' THEN COALESCE(notes||char(10),'')||? ELSE notes END,confirmed_at=COALESCE(confirmed_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP
        WHERE id=?`,args:[amount,req.body?.due_date||null,doc||null,note,note,req.params.id]});
      const purchasingBasis=(claim.claim_type==='shorted_goods'&&claim.source_type==='purchase_order')||(claim.claim_type==='overcharge'&&claim.source_type==='supplier_invoice');
      if(purchasingBasis){
        let sourceInvoiceId=null;
        if(claim.claim_type==='overcharge'){
          sourceInvoiceId=Number(claim.source_id);
          const {rows:[inv]}=await tx.execute({sql:"SELECT id,supplier_id FROM supplier_invoices WHERE id=? AND status!='void'",args:[sourceInvoiceId]});
          if(!inv||Number(inv.supplier_id)!==Number(claim.supplier_id))throw new Error('Overcharge accounting basis requires the exact supplier invoice');
        }
        await tx.execute({sql:`INSERT INTO supplier_recoverable_accounting_basis(claim_id,basis_type,recognized_amount,source_invoice_id,evidence_json)
          VALUES(?,?,?,?,?) ON CONFLICT(claim_id) DO UPDATE SET recognized_amount=excluded.recognized_amount,source_invoice_id=excluded.source_invoice_id,evidence_json=excluded.evidence_json`,
          args:[claim.id,'purchasing_receiving_clearing',amount,sourceInvoiceId,JSON.stringify({supplierDocumentNumber:doc||null,confirmationNote:note||null})]});
      }
      if(claim.claim_type==='supplier_return'&&claim.source_type==='supplier_return'){
        const {rows:[ret]}=await tx.execute({sql:'SELECT * FROM supplier_returns WHERE id=?',args:[Number(claim.source_id)]});
        if(!ret||Number(ret.supplier_id)!==Number(claim.supplier_id))throw new Error('Supplier return accounting basis requires the exact dispatched return');
        const legacy=Number(ret.inventory_legacy_quantity||0),untracked=Number(ret.inventory_untracked_quantity||0),carrying=money(ret.inventory_tracked_value||0);
        let evidence={};try{evidence=JSON.parse(claim.evidence_json||'{}');}catch{}
        if(legacy>0.0001||untracked>0.0001||Math.abs(amount-carrying)>0.01){
          const reason=(legacy>0.0001||untracked>0.0001)
            ?'Returned inventory does not have complete auditable carrying-value evidence.'
            :`Supplier-confirmed credit ${amount.toFixed(2)} differs from returned inventory carrying value ${carrying.toFixed(2)}.`;
          evidence.accountingBasis={status:'unresolved',reason,confirmedCreditAmount:amount,inventoryCarryingValue:carrying,legacyQuantity:legacy,untrackedQuantity:untracked};
          await tx.execute({sql:'UPDATE supplier_recoverable_claims SET evidence_json=? WHERE id=?',args:[JSON.stringify(evidence),claim.id]});
        }else{
          evidence.accountingBasis={status:'reconciled',confirmedCreditAmount:amount,inventoryCarryingValue:carrying};
          await tx.execute({sql:'UPDATE supplier_recoverable_claims SET evidence_json=? WHERE id=?',args:[JSON.stringify(evidence),claim.id]});
          await tx.execute({sql:`INSERT INTO supplier_recoverable_accounting_basis(claim_id,basis_type,recognized_amount,source_invoice_id,evidence_json)
            VALUES(?,?,?,?,?) ON CONFLICT(claim_id) DO UPDATE SET basis_type=excluded.basis_type,recognized_amount=excluded.recognized_amount,evidence_json=excluded.evidence_json`,
            args:[claim.id,'supplier_return_clearing',amount,null,JSON.stringify({supplierReturnId:ret.id,returnNumber:ret.return_number,inventoryCarryingValue:carrying,supplierDocumentNumber:doc||null,confirmationNote:note||null})]});
        }
      }
      await tx.commit();committed=true;
    }catch(e){if(!committed)try{await tx.rollback();}catch{}throw e;}
    const {rows:[row]}=await db.execute({sql:'SELECT * FROM supplier_recoverable_claims WHERE id=?',args:[req.params.id]});
    res.json(row);
  }catch(e){res.status(400).json({error:e.message});}
});

router.post('/:id/settlements',async(req,res)=>{
  const tx=await db.transaction('write');let committed=false;
  try{
    const {rows:[claim]}=await tx.execute({sql:'SELECT * FROM supplier_recoverable_claims WHERE id=?',args:[req.params.id]});
    if(!claim)throw new Error('Recoverable claim not found');
    if(!['confirmed','partially_recovered'].includes(claim.status))throw new Error('Claim must be confirmed before recovery is recorded');
    const amount=money(req.body?.amount);
    if(!Number.isFinite(amount)||amount<=0)throw new Error('Recovery amount must be greater than zero');
    const outstanding=money(Number(claim.confirmed_amount||0)-Number(claim.recovered_amount||0));
    if(amount>outstanding+0.01)throw new Error('Recovery amount exceeds confirmed outstanding balance');
    const type=String(req.body?.settlement_type||'').trim();
    if(!['credit_note','cash_refund','bank_refund','ap_offset','replacement_value','other'].includes(type))throw new Error('Unsupported recovery settlement type');
    const reference=String(req.body?.reference||'').trim();
    if(!reference)throw new Error('Recovery reference is required');
    const {rows:[basis]}=await tx.execute({sql:'SELECT * FROM supplier_recoverable_accounting_basis WHERE claim_id=?',args:[claim.id]});
    if(basis&&['credit_note','replacement_value','other'].includes(type))throw new Error('Accounting-recognized recoverable must settle through AP offset or evidenced cash/bank refund');
    let invoiceId=null;
    if(type==='ap_offset'){
      invoiceId=Number(req.body?.supplier_invoice_id);
      if(!invoiceId)throw new Error('supplier_invoice_id is required for AP offset');
      if(!basis)throw new Error('AP offset requires a recognized supplier recoverable accounting basis');
      const {rows:[inv]}=await tx.execute({sql:"SELECT * FROM supplier_invoices WHERE id=? AND status!='void'",args:[invoiceId]});
      if(!inv||Number(inv.supplier_id)!==Number(claim.supplier_id))throw new Error('AP offset invoice must belong to the same supplier');
      const {rows:[paid]}=await tx.execute({sql:'SELECT COALESCE(SUM(amount),0) amount FROM supplier_payment_allocations WHERE supplier_invoice_id=?',args:[invoiceId]});
      const {rows:[offset]}=await tx.execute({sql:'SELECT COALESCE(SUM(amount),0) amount FROM supplier_recoverable_ap_allocations WHERE supplier_invoice_id=?',args:[invoiceId]});
      const invoiceBalance=money(Number(inv.total||0)-Number(paid?.amount||0)-Number(offset?.amount||0));
      if(amount>invoiceBalance+0.01)throw new Error('AP offset exceeds supplier invoice balance');
    }
    const settlement=await tx.execute({sql:`INSERT INTO supplier_recoverable_settlements(
      claim_id,settlement_type,amount,reference,settlement_date,evidence_json,recorded_by_employee_id
    ) VALUES(?,?,?,?,?,?,?)`,args:[claim.id,type,amount,reference,req.body?.settlement_date||new Date().toISOString(),JSON.stringify(req.body?.evidence||{}),actor(req)]});
    const settlementId=Number(settlement.lastInsertRowid);
    if(type==='ap_offset'){
      await tx.execute({sql:`INSERT INTO supplier_recoverable_ap_allocations(settlement_id,claim_id,supplier_invoice_id,amount)
        VALUES(?,?,?,?)`,args:[settlementId,claim.id,invoiceId,amount]});
    }
    const newRecovered=money(Number(claim.recovered_amount||0)+amount);
    const status=newRecovered+0.01>=Number(claim.confirmed_amount||0)?'recovered':'partially_recovered';
    await tx.execute({sql:`UPDATE supplier_recoverable_claims SET recovered_amount=?,status=?,updated_at=CURRENT_TIMESTAMP,
      recovered_at=CASE WHEN ?='recovered' THEN CURRENT_TIMESTAMP ELSE NULL END WHERE id=?`,args:[newRecovered,status,status,claim.id]});
    await tx.commit();committed=true;
    const {rows:[row]}=await db.execute({sql:'SELECT * FROM supplier_recoverable_claims WHERE id=?',args:[claim.id]});
    res.status(201).json(row);
  }catch(e){if(!committed)try{await tx.rollback();}catch{}res.status(400).json({error:e.message});}
});

router.get('/:id',async(req,res)=>{
  try{
    const {rows:[claim]}=await db.execute({sql:`SELECT c.*,s.name supplier_name,b.name branch_name
      FROM supplier_recoverable_claims c LEFT JOIN suppliers s ON s.id=c.supplier_id LEFT JOIN branches b ON b.id=c.branch_id
      WHERE c.id=?`,args:[req.params.id]});
    if(!claim)return res.status(404).json({error:'Recoverable claim not found'});
    const {rows:settlements}=await db.execute({sql:'SELECT * FROM supplier_recoverable_settlements WHERE claim_id=? ORDER BY settlement_date,id',args:[req.params.id]});
    res.json({...claim,outstanding_amount:money(Math.max(0,Number(claim.confirmed_amount||0)-Number(claim.recovered_amount||0))),aging_bucket:agingBucket(claim.due_date,claim.obligation_date),settlements});
  }catch(e){res.status(500).json({error:e.message});}
});

module.exports=router;
