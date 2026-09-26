'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requireAnyPermission}=require('../lib/permissions');
const {ensureSupplierRecoverablesSchema,money}=require('../lib/supplier-recoverables');
const recoveryCases=require('./supplier-recovery-cases');
const creditNotes=require('./supplier-credit-notes');

function daysBetween(a,b){
  const x=new Date(a||'').getTime(),y=new Date(b||'').getTime();
  if(!Number.isFinite(x)||!Number.isFinite(y)||y<x)return null;
  return Number(((y-x)/86400000).toFixed(1));
}
function parseEvidence(raw){try{return JSON.parse(raw||'{}')||{};}catch{return {};}}
function advisory(row){
  const reasons=[];
  let level='normal';
  if(Number(row.overdue_outstanding||0)>0){level='watch';reasons.push('confirmed recoverables are overdue');}
  if(Number(row.broken_promise_count||0)>0||Number(row.dispute_count||0)>=2){level='elevated';reasons.push(Number(row.broken_promise_count||0)>0?'supplier settlement promise was missed':'multiple recovery cases are disputed');}
  if(Number(row.overdue_60_plus||0)>0||Number(row.unresolved_accounting_count||0)>=2){
    level='high';
    reasons.push(Number(row.overdue_60_plus||0)>0?'recoverable balance is more than 60 days overdue':'multiple recoverables have unresolved accounting evidence');
  }
  return {level,reasons};
}

router.use(requireAnyPermission('purchasing','reports_financial','accounts'));
router.use(async(req,res,next)=>{try{
  await ensureSupplierRecoverablesSchema();
  if(recoveryCases.ensureSchema)await recoveryCases.ensureSchema();
  if(creditNotes.ensureSchema)await creditNotes.ensureSchema();
  next();
}catch(e){res.status(500).json({error:'Supplier recovery performance initialization failed'});}});

router.get('/',async(req,res)=>{
  try{
    const {rows:suppliers}=await db.execute({sql:'SELECT id,name FROM suppliers ORDER BY name',args:[]});
    const {rows:claims}=await db.execute({sql:`SELECT * FROM supplier_recoverable_claims
      WHERE status!='cancelled' ORDER BY supplier_id,id`,args:[]});
    const {rows:cases}=await db.execute({sql:`SELECT rc.*,c.supplier_id,c.confirmed_amount,c.recovered_amount,c.status claim_status
      FROM supplier_recovery_cases rc JOIN supplier_recoverable_claims c ON c.id=rc.claim_id`,args:[]}).catch(()=>({rows:[]}));
    const {rows:returns}=await db.execute({sql:`SELECT r.*,c.status claim_status
      FROM supplier_returns r LEFT JOIN supplier_recoverable_claims c ON c.id=r.recoverable_claim_id
      WHERE r.status='dispatched'`,args:[]}).catch(()=>({rows:[]}));
    const {rows:notes}=await db.execute({sql:`SELECT n.*,
      ROUND(MAX(0,n.amount-n.applied_amount),2) remaining_amount
      FROM supplier_credit_notes n`,args:[]}).catch(()=>({rows:[]}));

    const bySupplier=new Map();
    for(const s of suppliers)bySupplier.set(Number(s.id),{
      supplier_id:Number(s.id),supplier_name:s.name,total_claims:0,identified_total:0,confirmed_total:0,recovered_total:0,
      outstanding_total:0,overdue_outstanding:0,overdue_60_plus:0,unconfirmed_count:0,dispute_count:0,broken_promise_count:0,
      unresolved_accounting_count:0,return_no_response_count:0,unmatched_credit_note_value:0,confirmation_days:[],recovery_days:[]
    });

    const now=Date.now();
    for(const c of claims){
      const row=bySupplier.get(Number(c.supplier_id));if(!row)continue;
      const identified=Number(c.identified_amount||0),confirmed=Number(c.confirmed_amount||0),recovered=Number(c.recovered_amount||0);
      const outstanding=Math.max(0,confirmed-recovered);
      row.total_claims++;row.identified_total+=identified;row.confirmed_total+=confirmed;row.recovered_total+=recovered;row.outstanding_total+=outstanding;
      if(c.status==='identified')row.unconfirmed_count++;
      if(outstanding>0&&c.due_date&&new Date(c.due_date).getTime()<now){
        row.overdue_outstanding+=outstanding;
        if((now-new Date(c.due_date).getTime())/86400000>=60)row.overdue_60_plus+=outstanding;
      }
      const ev=parseEvidence(c.evidence_json);
      if(ev?.accountingBasis?.status==='unresolved')row.unresolved_accounting_count++;
      if(c.confirmed_at){
        const d=daysBetween(c.obligation_date||c.created_at,c.confirmed_at);if(d!==null)row.confirmation_days.push(d);
      }
      if(c.confirmed_at&&c.recovered_at){
        const d=daysBetween(c.confirmed_at,c.recovered_at);if(d!==null)row.recovery_days.push(d);
      }
    }

    for(const c of cases){
      const row=bySupplier.get(Number(c.supplier_id));if(!row)continue;
      if(c.status==='disputed')row.dispute_count++;
      const outstanding=Math.max(0,Number(c.confirmed_amount||0)-Number(c.recovered_amount||0));
      if(c.status==='promised'&&outstanding>0&&c.promised_settlement_date&&new Date(c.promised_settlement_date).getTime()<now)row.broken_promise_count++;
    }
    for(const r of returns){
      const row=bySupplier.get(Number(r.supplier_id));if(!row)continue;
      const age=r.dispatched_at?(now-new Date(r.dispatched_at).getTime())/86400000:0;
      if(age>=7&&r.claim_status==='identified')row.return_no_response_count++;
    }
    for(const n of notes){
      const row=bySupplier.get(Number(n.supplier_id));if(!row)continue;
      row.unmatched_credit_note_value+=Number(n.remaining_amount||0);
    }

    const output=[];
    for(const row of bySupplier.values()){
      if(row.total_claims===0&&row.unmatched_credit_note_value<=0&&row.return_no_response_count===0)continue;
      const avg=a=>a.length?Number((a.reduce((s,v)=>s+v,0)/a.length).toFixed(1)):null;
      row.identified_total=money(row.identified_total);row.confirmed_total=money(row.confirmed_total);row.recovered_total=money(row.recovered_total);
      row.outstanding_total=money(row.outstanding_total);row.overdue_outstanding=money(row.overdue_outstanding);row.overdue_60_plus=money(row.overdue_60_plus);
      row.unmatched_credit_note_value=money(row.unmatched_credit_note_value);
      row.recovery_rate_pct=row.confirmed_total>0?Number((row.recovered_total/row.confirmed_total*100).toFixed(1)):null;
      row.avg_confirmation_days=avg(row.confirmation_days);row.avg_recovery_days=avg(row.recovery_days);
      delete row.confirmation_days;delete row.recovery_days;
      const flag=advisory(row);row.advisory_level=flag.level;row.advisory_reasons=flag.reasons;
      output.push(row);
    }
    output.sort((a,b)=>{
      const rank={high:3,elevated:2,watch:1,normal:0};
      return rank[b.advisory_level]-rank[a.advisory_level]||Number(b.overdue_outstanding)-Number(a.overdue_outstanding)||Number(b.outstanding_total)-Number(a.outstanding_total)||a.supplier_name.localeCompare(b.supplier_name);
    });
    const summary={
      suppliers_with_recovery_history:output.length,
      suppliers_high_or_elevated:output.filter(x=>['high','elevated'].includes(x.advisory_level)).length,
      total_outstanding:money(output.reduce((s,x)=>s+Number(x.outstanding_total||0),0)),
      total_overdue:money(output.reduce((s,x)=>s+Number(x.overdue_outstanding||0),0)),
      unmatched_credit_note_value:money(output.reduce((s,x)=>s+Number(x.unmatched_credit_note_value||0),0))
    };
    res.json({summary,suppliers:output});
  }catch(e){res.status(500).json({error:e.message});}
});

module.exports=router;
