'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requireAnyPermission}=require('../lib/permissions');
const {ensureSupplierRecoverablesSchema,money}=require('../lib/supplier-recoverables');
const creditNotes=require('./supplier-credit-notes');
const recoveryCases=require('./supplier-recovery-cases');

function daysSince(value){
  if(!value)return null;
  const t=new Date(value).getTime();
  if(!Number.isFinite(t))return null;
  return Math.max(0,Math.floor((Date.now()-t)/86400000));
}
function severity(rank){return rank>=90?'critical':rank>=60?'high':rank>=30?'medium':'low';}
function ageRank(days,{critical=60,high=30,medium=14}={}){
  if(days===null)return 0;
  if(days>=critical)return 95;
  if(days>=high)return 70;
  if(days>=medium)return 40;
  return 15;
}
function parseEvidence(raw){try{return JSON.parse(raw||'{}')||{};}catch{return {};}}
function itemKey(type,id){return type+':'+String(id);}

router.use(requireAnyPermission('purchasing','reports_financial','accounts'));
router.use(async(req,res,next)=>{try{
  await ensureSupplierRecoverablesSchema();
  if(creditNotes.ensureSchema)await creditNotes.ensureSchema();
  if(recoveryCases.ensureSchema)await recoveryCases.ensureSchema();
  next();
}catch(e){res.status(500).json({error:'Supplier recovery attention initialization failed'});}});

router.get('/',async(req,res)=>{
  try{
    const items=[];
    const {rows:claims}=await db.execute({sql:`SELECT c.*,s.name supplier_name,b.name branch_name,
      ROUND(MAX(0,c.confirmed_amount-c.recovered_amount),2) outstanding_amount
      FROM supplier_recoverable_claims c
      LEFT JOIN suppliers s ON s.id=c.supplier_id
      LEFT JOIN branches b ON b.id=c.branch_id
      WHERE c.status NOT IN ('recovered','cancelled')
      ORDER BY c.id DESC`,args:[]});

    for(const c of claims){
      const evidence=parseEvidence(c.evidence_json);
      const obligationAge=daysSince(c.obligation_date||c.created_at);
      const confirmedAge=daysSince(c.confirmed_at);
      const outstanding=money(Math.max(0,Number(c.confirmed_amount||0)-Number(c.recovered_amount||0)));
      const identified=money(c.identified_amount||0);
      if(c.status==='identified'){
        const rank=ageRank(obligationAge,{critical:45,high:21,medium:7});
        items.push({
          key:itemKey('unconfirmed_claim',c.id),type:'unconfirmed_claim',severity:severity(rank),rank,
          supplier_id:c.supplier_id,supplier_name:c.supplier_name,branch_name:c.branch_name,
          claim_id:c.id,claim_number:c.claim_number,claim_type:c.claim_type,source_reference:c.source_reference,
          amount_at_risk:identified,age_days:obligationAge,
          reason:'Supplier obligation has been identified but is still not confirmed.',
          next_action:'Obtain supplier acknowledgement or credit-note evidence.'
        });
      }
      if(outstanding>0&&c.due_date&&new Date(c.due_date).getTime()<Date.now()){
        const overdue=daysSince(c.due_date);
        const rank=overdue>=60?100:overdue>=30?80:overdue>=14?55:35;
        items.push({
          key:itemKey('overdue_recoverable',c.id),type:'overdue_recoverable',severity:severity(rank),rank,
          supplier_id:c.supplier_id,supplier_name:c.supplier_name,branch_name:c.branch_name,
          claim_id:c.id,claim_number:c.claim_number,claim_type:c.claim_type,source_reference:c.source_reference,
          amount_at_risk:outstanding,age_days:overdue,
          reason:'Confirmed supplier recoverable is past its due date.',
          next_action:'Follow up with supplier and settle by AP offset or evidenced refund.'
        });
      }else if(outstanding>0&&confirmedAge!==null&&confirmedAge>=30){
        const rank=confirmedAge>=90?95:confirmedAge>=60?75:50;
        items.push({
          key:itemKey('stale_confirmed',c.id),type:'stale_confirmed',severity:severity(rank),rank,
          supplier_id:c.supplier_id,supplier_name:c.supplier_name,branch_name:c.branch_name,
          claim_id:c.id,claim_number:c.claim_number,claim_type:c.claim_type,source_reference:c.source_reference,
          amount_at_risk:outstanding,age_days:confirmedAge,
          reason:'Confirmed supplier recoverable has remained unsettled for an extended period.',
          next_action:'Chase settlement and apply available supplier credit/refund evidence.'
        });
      }
      if(evidence?.accountingBasis?.status==='unresolved'){
        const rank=85;
        items.push({
          key:itemKey('accounting_unresolved',c.id),type:'accounting_unresolved',severity:severity(rank),rank,
          supplier_id:c.supplier_id,supplier_name:c.supplier_name,branch_name:c.branch_name,
          claim_id:c.id,claim_number:c.claim_number,claim_type:c.claim_type,source_reference:c.source_reference,
          amount_at_risk:money(c.confirmed_amount||c.identified_amount||0),age_days:confirmedAge??obligationAge,
          reason:evidence.accountingBasis.reason||'Supplier recoverable accounting basis is unresolved.',
          next_action:'Resolve carrying-value/source-evidence difference before financial settlement.'
        });
      }
    }

    const {rows:returns}=await db.execute({sql:`SELECT r.*,s.name supplier_name,b.name branch_name
      FROM supplier_returns r
      JOIN suppliers s ON s.id=r.supplier_id
      LEFT JOIN branches b ON b.id=r.branch_id
      WHERE r.status='dispatched'
      ORDER BY r.id DESC`,args:[]}).catch(()=>({rows:[]}));
    for(const r of returns){
      const age=daysSince(r.dispatched_at);
      if(age!==null&&age>=7&&r.recoverable_claim_id){
        const {rows:[claim]}=await db.execute({sql:'SELECT status,confirmed_amount,recovered_amount FROM supplier_recoverable_claims WHERE id=?',args:[r.recoverable_claim_id]});
        if(claim&&claim.status==='identified'){
          const rank=age>=45?95:age>=21?70:40;
          items.push({
            key:itemKey('return_no_supplier_response',r.id),type:'return_no_supplier_response',severity:severity(rank),rank,
            supplier_id:r.supplier_id,supplier_name:r.supplier_name,branch_name:r.branch_name,
            claim_id:r.recoverable_claim_id,source_reference:r.return_number,
            amount_at_risk:money(r.expected_credit_amount||0),age_days:age,
            reason:'Goods were dispatched back to the supplier but no confirmed supplier credit is recorded.',
            next_action:'Request supplier credit note or written acknowledgement for the dispatched return.'
          });
        }
      }
    }

    const {rows:notes}=await db.execute({sql:`SELECT n.*,s.name supplier_name,
      ROUND(MAX(0,n.amount-n.applied_amount),2) remaining_amount,
      ROUND(COALESCE((SELECT SUM(a.amount-a.settled_amount) FROM supplier_credit_note_applications a WHERE a.credit_note_id=n.id),0),2) matched_unsettled
      FROM supplier_credit_notes n
      JOIN suppliers s ON s.id=n.supplier_id
      ORDER BY n.id DESC`,args:[]}).catch(()=>({rows:[]}));
    for(const n of notes){
      const age=daysSince(n.credit_date||n.created_at);
      const remaining=money(n.remaining_amount||0),unsettled=money(n.matched_unsettled||0);
      if(remaining>0&&age!==null&&age>=7){
        const rank=age>=60?90:age>=30?65:35;
        items.push({
          key:itemKey('unmatched_credit_note',n.id),type:'unmatched_credit_note',severity:severity(rank),rank,
          supplier_id:n.supplier_id,supplier_name:n.supplier_name,credit_note_id:n.id,source_reference:n.credit_note_number,
          amount_at_risk:remaining,age_days:age,
          reason:'Supplier credit note has value that is not yet matched to recoverable claims.',
          next_action:'Match the remaining credit-note amount to the correct supplier claim.'
        });
      }
      if(unsettled>0){
        const matchedAge=age;
        const rank=matchedAge>=60?95:matchedAge>=30?70:45;
        items.push({
          key:itemKey('matched_not_settled',n.id),type:'matched_not_settled',severity:severity(rank),rank,
          supplier_id:n.supplier_id,supplier_name:n.supplier_name,credit_note_id:n.id,source_reference:n.credit_note_number,
          amount_at_risk:unsettled,age_days:matchedAge,
          reason:'Supplier credit note is matched to claims but has not been applied to Accounts Payable.',
          next_action:'Apply matched credit to an eligible open supplier invoice.'
        });
      }
    }

    const {rows:cases}=await db.execute({sql:`SELECT rc.*,c.claim_number,c.claim_type,c.confirmed_amount,c.recovered_amount,c.supplier_id,
      s.name supplier_name
      FROM supplier_recovery_cases rc
      JOIN supplier_recoverable_claims c ON c.id=rc.claim_id
      JOIN suppliers s ON s.id=c.supplier_id
      WHERE rc.status!='closed'
      ORDER BY rc.id DESC`,args:[]}).catch(()=>({rows:[]}));
    for(const c of cases){
      const outstanding=money(Math.max(0,Number(c.confirmed_amount||0)-Number(c.recovered_amount||0)));
      if(c.next_follow_up_at&&new Date(c.next_follow_up_at).getTime()<Date.now()){
        const late=daysSince(c.next_follow_up_at);
        const rank=late>=14?90:late>=7?70:45;
        items.push({
          key:itemKey('missed_follow_up',c.id),type:'missed_follow_up',severity:severity(rank),rank,
          supplier_id:c.supplier_id,supplier_name:c.supplier_name,claim_id:c.claim_id,claim_number:c.claim_number,
          recovery_case_id:c.id,amount_at_risk:outstanding,age_days:late,
          reason:'Recovery case follow-up date has passed without the case being resolved.',
          next_action:'Contact the supplier and record the follow-up outcome or update the next follow-up date.'
        });
      }
      if(c.status==='promised'&&c.promised_settlement_date&&new Date(c.promised_settlement_date).getTime()<Date.now()){
        const late=daysSince(c.promised_settlement_date);
        const promised=money(c.promised_amount||0);
        const rank=late>=14?100:late>=7?85:65;
        items.push({
          key:itemKey('broken_supplier_promise',c.id),type:'broken_supplier_promise',severity:severity(rank),rank,
          supplier_id:c.supplier_id,supplier_name:c.supplier_name,claim_id:c.claim_id,claim_number:c.claim_number,
          recovery_case_id:c.id,amount_at_risk:money(Math.min(outstanding,promised||outstanding)),age_days:late,
          reason:'Supplier-promised settlement date has passed and the linked recoverable is still outstanding.',
          next_action:'Escalate the supplier commitment and obtain a new evidenced settlement date.'
        });
      }
      if(c.status==='disputed'){
        const rank=80;
        items.push({
          key:itemKey('supplier_dispute',c.id),type:'supplier_dispute',severity:severity(rank),rank,
          supplier_id:c.supplier_id,supplier_name:c.supplier_name,claim_id:c.claim_id,claim_number:c.claim_number,
          recovery_case_id:c.id,amount_at_risk:outstanding,age_days:daysSince(c.updated_at),
          reason:c.dispute_reason||'Supplier has disputed the recoverable claim.',
          next_action:'Resolve the dispute using source documents, receipt/return evidence, and supplier correspondence.'
        });
      }
    }

    items.sort((a,b)=>b.rank-a.rank||Number(b.amount_at_risk||0)-Number(a.amount_at_risk||0)||String(a.key).localeCompare(String(b.key)));
    const summary={total_items:items.length,critical:0,high:0,medium:0,low:0,total_amount_at_risk:0};
    const uniqueRisk=new Map();
    for(const x of items){
      summary[x.severity]=(summary[x.severity]||0)+1;
      // Claim-level exceptions can overlap (overdue + accounting unresolved + stale),
      // so only keep the largest open balance per claim. Matched-not-settled credit
      // notes are already represented by the underlying confirmed claim balance and
      // are excluded from the headline to prevent double-counting.
      if(x.claim_id){
        const riskKey='claim:'+x.claim_id;
        uniqueRisk.set(riskKey,Math.max(Number(uniqueRisk.get(riskKey)||0),Number(x.amount_at_risk||0)));
      }else if(x.type==='unmatched_credit_note'&&x.credit_note_id){
        const riskKey='unmatched-credit:'+x.credit_note_id;
        uniqueRisk.set(riskKey,Math.max(Number(uniqueRisk.get(riskKey)||0),Number(x.amount_at_risk||0)));
      }
    }
    summary.total_amount_at_risk=money([...uniqueRisk.values()].reduce((s,v)=>s+v,0));
    res.json({summary,items});
  }catch(e){res.status(500).json({error:e.message});}
});

module.exports=router;
