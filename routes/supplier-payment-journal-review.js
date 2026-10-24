'use strict';
const router=require('express').Router();
const {db}=require('../database');
const {requirePermission,can}=require('../lib/permissions');

router.get('/',requirePermission('reports_financial'),async(req,res)=>{
 try{
  if(!req.employee)return res.status(401).json({error:'A staff session is required'});
  const after=Number(req.query.after||0),requested=req.query.branch_id?Number(req.query.branch_id):null;
  if(!Number.isSafeInteger(after)||after<0||(requested!==null&&(!Number.isSafeInteger(requested)||requested<1)))return res.status(400).json({error:'Invalid branch or payment cursor'});
  const all=can(req.employee.permissions,'multi_branch_access'),home=Number(req.employee.default_branch_id);
  if(!all&&(!home||(requested&&requested!==home)))return res.status(403).json({error:'Review is restricted to your assigned branch'});
  const branch=all?requested:home;
  const tables=new Set((await db.execute({sql:"SELECT name FROM sqlite_master WHERE type='table'",args:[]})).rows.map(x=>x.name));
  if(!tables.has('supplier_payments'))return res.json({rows:[],next_cursor:null,branch_id:branch,read_only:true});
  const ledger=['journal_entries','journal_lines','ledger_accounts'].every(x=>tables.has(x));
  const {rows:payments}=await db.execute({sql:'SELECT id,payment_number,payment_date,branch_id,amount,payment_method FROM supplier_payments WHERE id>?'+(branch?' AND branch_id=?':'')+' ORDER BY id LIMIT 51',args:branch?[after,branch]:[after]});
  const rows=[];
  for(const payment of payments.slice(0,50)){
   const journals=ledger?(await db.execute({sql:"SELECT id,journal_number,status,reversal_of_id FROM journal_entries WHERE (source_type='supplier_payment' AND source_id=?) OR reversal_of_id IN (SELECT id FROM journal_entries WHERE source_type='supplier_payment' AND source_id=?) ORDER BY id",args:[String(payment.id),String(payment.id)]})).rows:[];
   const amount=Number(payment.amount),method=String(payment.payment_method||'').trim().toLowerCase();
   const cash=method==='cash',bank=['bank_transfer','bank transfer','bank','cheque','check','ach','wire','eft'].includes(method),credit=cash?'1000':bank?'1010':null;
   let state='missing',reason='No journal exists for this recorded supplier payment.';
   if(!Number.isFinite(amount)||amount<=0||!credit){state='needs_review';reason='Review the payment amount or payment method before posting.';}
   else if(journals.length){
    state='needs_review';reason='Existing draft, reversal, duplicate or inconsistent journal evidence needs Finance review.';
    if(journals.length===1&&journals[0].status==='posted'&&!journals[0].reversal_of_id){
     const lines=(await db.execute({sql:'SELECT a.code,l.debit,l.credit FROM journal_lines l JOIN ledger_accounts a ON a.id=l.ledger_account_id WHERE l.journal_entry_id=?',args:[journals[0].id]})).rows;
     const cents=v=>Math.round(Number(v)*100),ap=lines.find(x=>x.code==='2000'),paid=lines.find(x=>x.code===credit);
     if(lines.length===2&&ap&&paid&&cents(ap.debit)===cents(amount)&&cents(ap.credit)===0&&cents(paid.credit)===cents(amount)&&cents(paid.debit)===0){state='posted';reason='Recorded payment agrees with its AP and cash/bank journal lines.';}
    }
   }
   rows.push({...payment,review_status:state,reason,expected_debit_account:'2000',expected_credit_account:credit,journals});
  }
  res.json({rows,next_cursor:payments.length>50?Number(rows.at(-1).id):null,branch_id:branch,read_only:true});
 }catch(error){res.status(500).json({error:'Unable to review supplier payment journals'});}
});
module.exports=router;
