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
    const marks=requirements.map(()=>'?').join(',');
    const {rows}=await db.execute({sql:`SELECT DISTINCT upper(o.currency) currency
      FROM supplier_product_offers o
      WHERE o.active=1 AND (
        o.product_id IN (${marks}) OR
        o.product_id IN (SELECT pc.parent_product_id FROM product_compositions pc WHERE pc.composition_type='procurement_kit' AND pc.active=1)
      )`,args:requirements});
    const currencies=rows.map(r=>String(r.currency||'').toUpperCase()).filter(Boolean);
    if(currencies.length>1){
      return res.status(409).json({error:'Cross-currency supplier comparison is blocked until all candidate offers are normalized to the procurement base currency.',currencies,base_currency:await getBaseCurrency(db),requires_fx_normalization:true});
    }
    req.procurementCurrencyContext={currency:currencies[0]||await getBaseCurrency(db),base_currency:await getBaseCurrency(db)};
    next();
  }catch(e){res.status(500).json({error:e.message});}
});
module.exports=router;
