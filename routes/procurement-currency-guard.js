'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {ensureProcurementFx,getBaseCurrency}=require('../lib/procurement-fx');
router.use(async(req,res,next)=>{try{await ensureProcurementFx();next();}catch(e){res.status(500).json({error:'Procurement currency guard initialization failed',detail:e.message});}});
router.post('/recommendations',async(req,res,next)=>{
  try{
    const requirements=(Array.isArray(req.body?.requirements)?req.body.requirements:[]).map(x=>Number(x.product_id)).filter(x=>x>0);
    if(!requirements.length)return next();
    const marks=requirements.map(()=>'?').join(','),kitMarks=requirements.map(()=>'?').join(',');
    const {rows}=await db.execute({sql:`SELECT DISTINCT upper(o.currency) currency
      FROM supplier_product_offers o
      WHERE o.active=1 AND (
        o.product_id IN (${marks}) OR
        o.product_id IN (
          SELECT pc.parent_product_id
          FROM product_compositions pc
          JOIN product_composition_components pcc ON pcc.composition_id=pc.id
          WHERE pc.composition_type='procurement_kit' AND pc.active=1 AND pcc.component_product_id IN (${kitMarks})
        )
      )`,args:[...requirements,...requirements]});
    const currencies=rows.map(r=>String(r.currency||'').toUpperCase()).filter(Boolean),base=await getBaseCurrency(db),foreign=currencies.filter(c=>c!==base);
    if(foreign.length){
      return res.status(409).json({error:'Supplier recommendation is blocked because one or more relevant candidate offers are not yet normalized to the procurement base currency.',currencies,foreign_currencies:foreign,base_currency:base,requires_fx_normalization:true});
    }
    req.procurementCurrencyContext={currency:base,base_currency:base};
    next();
  }catch(e){res.status(500).json({error:e.message});}
});
module.exports=router;
