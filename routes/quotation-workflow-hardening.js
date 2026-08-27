'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');

router.use(require('./quotation-virtual-bundle-guard'));
router.use(require('./quotation-uom-guard'));
router.use(requirePermission('quotations'));

router.put('/:id',async(req,res,next)=>{
  try{
    const {rows:[quote]}=await db.execute({sql:'SELECT id,status,quote_type FROM quotations WHERE id=?',args:[req.params.id]});
    if(!quote)return next();
    if(quote.status==='converted')return res.status(409).json({error:'Converted quotations are immutable'});
    if(quote.status==='accepted'&&quote.quote_type!=='rental'){
      const {rows:[commitments]}=await db.execute({sql:`SELECT
        (SELECT COUNT(*) FROM quotation_item_sources qis JOIN quotation_items qi ON qi.id=qis.quotation_item_id WHERE qi.quote_id=? AND (qis.transfer_id IS NOT NULL OR qis.purchase_request_item_id IS NOT NULL)) source_commitments,
        (SELECT COUNT(*) FROM quotation_items WHERE quote_id=? AND purchase_request_id IS NOT NULL) item_commitments`,args:[quote.id,quote.id]});
      if(Number(commitments?.source_commitments||0)+Number(commitments?.item_commitments||0)>0)return res.status(409).json({error:'Accepted quotation has downstream purchasing or transfer commitments. Revert those commitments before editing the quote.'});
    }
    next();
  }catch(e){res.status(500).json({error:e.message});}
});

router.patch('/:id/status',async(req,res,next)=>{
  try{
    const nextStatus=String(req.body?.status||'');const {rows:[quote]}=await db.execute({sql:'SELECT id,status,converted_to_tx,converted_to_agreement_id FROM quotations WHERE id=?',args:[req.params.id]});
    if(!quote)return next();
    if(quote.status==='converted'||quote.converted_to_tx||quote.converted_to_agreement_id)return res.status(409).json({error:'Converted quotation status cannot be changed'});
    const rank={draft:0,sent:1,accepted:2,declined:2};
    if(rank[quote.status]!=null&&rank[nextStatus]!=null&&rank[nextStatus]<rank[quote.status])return res.status(409).json({error:`Quotation cannot move backward from ${quote.status} to ${nextStatus}`});
    next();
  }catch(e){res.status(500).json({error:e.message});}
});

router.post('/:id/convert',async(req,res,next)=>{
  try{
    const {rows:[quote]}=await db.execute({sql:'SELECT id,status,converted_to_tx,converted_to_agreement_id FROM quotations WHERE id=?',args:[req.params.id]});
    if(!quote)return next();
    if(quote.status==='converted'||quote.converted_to_tx||quote.converted_to_agreement_id)return res.status(409).json({error:'Quotation is already converted'});
    if(quote.status==='declined'||quote.status==='cancelled')return res.status(409).json({error:`${quote.status} quotation cannot be converted`});
    next();
  }catch(e){res.status(500).json({error:e.message});}
});

module.exports=router;
