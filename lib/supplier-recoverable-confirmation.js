'use strict';
const {money}=require('./supplier-recoverables');

async function confirmRecoverable(executor,claim,input={}){
  const amount=money(input.confirmedAmount??claim.identified_amount);
  if(!Number.isFinite(amount)||amount<=0)throw new Error('Confirmed amount must be greater than zero');
  if(amount+0.01<Number(claim.recovered_amount||0))throw new Error('Confirmed amount cannot be below amount already recovered');
  const doc=String(input.supplierDocumentNumber||claim.supplier_document_number||'').trim();
  const note=String(input.confirmationNote||'').trim();
  if(!doc&&!note)throw new Error('Supplier document number or confirmation note is required');

  await executor.execute({sql:`UPDATE supplier_recoverable_claims SET
    status=CASE WHEN recovered_amount>0 THEN 'partially_recovered' ELSE 'confirmed' END,
    confirmed_amount=?,due_date=COALESCE(?,due_date),supplier_document_number=COALESCE(?,supplier_document_number),
    notes=CASE WHEN ?!='' THEN COALESCE(notes||char(10),'')||? ELSE notes END,
    confirmed_at=COALESCE(confirmed_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP
    WHERE id=?`,args:[amount,input.dueDate||null,doc||null,note,note,claim.id]});

  const purchasingBasis=(claim.claim_type==='shorted_goods'&&claim.source_type==='purchase_order')||
    (claim.claim_type==='overcharge'&&claim.source_type==='supplier_invoice');

  if(purchasingBasis){
    let sourceInvoiceId=null;
    if(claim.claim_type==='overcharge'){
      sourceInvoiceId=Number(claim.source_id);
      const {rows:[inv]}=await executor.execute({sql:"SELECT id,supplier_id FROM supplier_invoices WHERE id=? AND status!='void'",args:[sourceInvoiceId]});
      if(!inv||Number(inv.supplier_id)!==Number(claim.supplier_id))throw new Error('Overcharge accounting basis requires the exact supplier invoice');
    }
    await executor.execute({sql:`INSERT INTO supplier_recoverable_accounting_basis(claim_id,basis_type,recognized_amount,source_invoice_id,evidence_json)
      VALUES(?,?,?,?,?) ON CONFLICT(claim_id) DO UPDATE SET recognized_amount=excluded.recognized_amount,source_invoice_id=excluded.source_invoice_id,evidence_json=excluded.evidence_json`,
      args:[claim.id,'purchasing_receiving_clearing',amount,sourceInvoiceId,JSON.stringify({supplierDocumentNumber:doc||null,confirmationNote:note||null,sourceCreditNoteId:input.sourceCreditNoteId||null})]});
  }

  if(claim.claim_type==='supplier_return'&&claim.source_type==='supplier_return'){
    const {rows:[ret]}=await executor.execute({sql:'SELECT * FROM supplier_returns WHERE id=?',args:[Number(claim.source_id)]});
    if(!ret||Number(ret.supplier_id)!==Number(claim.supplier_id))throw new Error('Supplier return accounting basis requires the exact dispatched return');
    const legacy=Number(ret.inventory_legacy_quantity||0),untracked=Number(ret.inventory_untracked_quantity||0),carrying=money(ret.inventory_tracked_value||0);
    let evidence={};try{evidence=JSON.parse(claim.evidence_json||'{}');}catch{}
    if(legacy>0.0001||untracked>0.0001||Math.abs(amount-carrying)>0.01){
      const reason=(legacy>0.0001||untracked>0.0001)
        ?'Returned inventory does not have complete auditable carrying-value evidence.'
        :`Supplier-confirmed credit ${amount.toFixed(2)} differs from returned inventory carrying value ${carrying.toFixed(2)}.`;
      evidence.accountingBasis={status:'unresolved',reason,confirmedCreditAmount:amount,inventoryCarryingValue:carrying,legacyQuantity:legacy,untrackedQuantity:untracked,sourceCreditNoteId:input.sourceCreditNoteId||null};
      await executor.execute({sql:'UPDATE supplier_recoverable_claims SET evidence_json=? WHERE id=?',args:[JSON.stringify(evidence),claim.id]});
    }else{
      evidence.accountingBasis={status:'reconciled',confirmedCreditAmount:amount,inventoryCarryingValue:carrying,sourceCreditNoteId:input.sourceCreditNoteId||null};
      await executor.execute({sql:'UPDATE supplier_recoverable_claims SET evidence_json=? WHERE id=?',args:[JSON.stringify(evidence),claim.id]});
      await executor.execute({sql:`INSERT INTO supplier_recoverable_accounting_basis(claim_id,basis_type,recognized_amount,source_invoice_id,evidence_json)
        VALUES(?,?,?,?,?) ON CONFLICT(claim_id) DO UPDATE SET basis_type=excluded.basis_type,recognized_amount=excluded.recognized_amount,evidence_json=excluded.evidence_json`,
        args:[claim.id,'supplier_return_clearing',amount,null,JSON.stringify({supplierReturnId:ret.id,returnNumber:ret.return_number,inventoryCarryingValue:carrying,supplierDocumentNumber:doc||null,confirmationNote:note||null,sourceCreditNoteId:input.sourceCreditNoteId||null})]});
    }
  }
  const {rows:[updated]}=await executor.execute({sql:'SELECT * FROM supplier_recoverable_claims WHERE id=?',args:[claim.id]});
  return updated;
}
module.exports={confirmRecoverable};
