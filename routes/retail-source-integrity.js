'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');

function sameNullable(a,b){
  if(a==null||a==='')return b==null||b==='';
  if(b==null||b==='')return false;
  return String(a)===String(b);
}
function canonicalLines(rows){
  return (rows||[]).map(x=>({product_id:Number(x.product_id),variation_id:x.variation_id==null?null:Number(x.variation_id),quantity:Number(x.quantity)}))
    .sort((a,b)=>a.product_id-b.product_id||Number(a.variation_id||0)-Number(b.variation_id||0)||a.quantity-b.quantity);
}
function sameLines(a,b){return JSON.stringify(canonicalLines(a))===JSON.stringify(canonicalLines(b));}

router.post('/transactions',async(req,res,next)=>{
  try{
    const body=req.body||{};
    const heldId=Number(body.source_hold_id||0)||null;
    const quoteId=Number(body.quote_id||0)||null;
    let held=null,quote=null;

    if(heldId){
      const {rows:[row]}=await db.execute({sql:'SELECT id,transaction_number,status,branch_id,customer_id FROM transactions WHERE id=?',args:[heldId]});
      if(!row)return res.status(404).json({error:'Source held sale was not found',control:'retail_source_integrity'});
      if(row.status!=='hold')return res.status(409).json({error:'Source held sale is no longer open for checkout',control:'retail_source_integrity'});
      held=row;
      if(body.branch_id!=null&&!sameNullable(body.branch_id,row.branch_id))return res.status(409).json({error:'Held sale must be completed in its original branch',control:'retail_source_integrity'});
      if(body.customer_id!=null&&!sameNullable(body.customer_id,row.customer_id))return res.status(409).json({error:'Held sale customer cannot be silently changed during checkout',control:'retail_source_integrity'});
      if(body.branch_id==null)body.branch_id=row.branch_id;
      if(body.customer_id==null)body.customer_id=row.customer_id;
    }

    if(quoteId){
      const {rows:[row]}=await db.execute({sql:'SELECT id,quote_number,status,quote_type,branch_id,customer_id,converted_to_tx,converted_to_agreement_id,valid_until FROM quotations WHERE id=?',args:[quoteId]});
      if(!row)return res.status(404).json({error:'Source quotation was not found',control:'retail_source_integrity'});
      if(row.quote_type==='rental')return res.status(409).json({error:'Rental quotations must be completed through the Rentals workflow',control:'retail_source_integrity'});
      if(['declined','cancelled'].includes(row.status))return res.status(409).json({error:`${row.status} quotation cannot be checked out`,control:'retail_source_integrity'});
      if(row.converted_to_agreement_id)return res.status(409).json({error:'Quotation is already bound to a rental agreement',control:'retail_source_integrity'});
      quote=row;

      if(row.status==='converted'||row.converted_to_tx){
        if(!row.converted_to_tx)return res.status(409).json({error:'Converted quotation has no authoritative transaction link',control:'retail_source_integrity'});
        const {rows:[linked]}=await db.execute({sql:'SELECT id,status,branch_id,customer_id FROM transactions WHERE id=?',args:[row.converted_to_tx]});
        if(!linked)return res.status(409).json({error:'Quotation conversion points to a missing transaction',control:'retail_source_integrity'});
        if(linked.status==='completed')return res.status(409).json({error:'Quotation has already been completed as a sale',completed_transaction_id:linked.id,control:'retail_source_integrity'});
        if(linked.status!=='hold')return res.status(409).json({error:`Quotation is linked to a ${linked.status} transaction and cannot be checked out again`,control:'retail_source_integrity'});
        if(!heldId||String(heldId)!==String(linked.id))return res.status(409).json({error:'Checkout must recall the exact held transaction created by this quotation',expected_source_hold_id:linked.id,control:'retail_source_integrity'});
        const {rows:heldItems}=await db.execute({sql:'SELECT product_id,variation_id,quantity FROM transaction_items WHERE transaction_id=? ORDER BY id',args:[linked.id]});
        if(!sameLines(body.items,heldItems))return res.status(409).json({error:'A quotation-backed held sale cannot change its quoted products or quantities during checkout. Revise the quotation through its controlled workflow instead.',control:'retail_source_integrity'});
      }else{
        if(row.status!=='accepted')return res.status(409).json({error:'Quotation must be accepted before checkout',control:'retail_source_integrity'});
        if(row.valid_until&&new Date(`${row.valid_until}T23:59:59Z`).getTime()<Date.now())return res.status(409).json({error:'Quotation has expired and must be reviewed before checkout',control:'retail_source_integrity'});
      }

      if(body.branch_id!=null&&!sameNullable(body.branch_id,row.branch_id))return res.status(409).json({error:'Quotation must be completed in its quoted branch',control:'retail_source_integrity'});
      if(body.customer_id!=null&&!sameNullable(body.customer_id,row.customer_id))return res.status(409).json({error:'Quotation customer cannot be silently changed during checkout',control:'retail_source_integrity'});
      if(body.branch_id==null)body.branch_id=row.branch_id;
      if(body.customer_id==null)body.customer_id=row.customer_id;
    }

    if(held&&quote&&quote.converted_to_tx&&String(quote.converted_to_tx)!==String(held.id))return res.status(409).json({error:'Held sale does not belong to the supplied quotation',control:'retail_source_integrity'});
    next();
  }catch(error){res.status(500).json({error:'Unable to validate checkout source integrity',detail:error.message,control:'retail_source_integrity'});}
});

module.exports=router;
module.exports.sameLines=sameLines;
