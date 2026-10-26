'use strict';
const express=require('express');const router=express.Router();const {db}=require('../database');
const {requirePermission,can}=require('../lib/permissions');
const {ensureSchema,resolveCurrency}=require('../lib/purchase-order-currency');
const {getBaseCurrency,getRate}=require('../lib/procurement-fx');
router.use(requirePermission('purchasing'));
router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Purchase-order currency initialization failed'});}});
router.get('/currency-options',requirePermission('purchasing_create'),async(req,res)=>{try{
 const base=await getBaseCurrency(db),date=String(req.query.as_of||new Date().toISOString().slice(0,10));if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return res.status(400).json({error:'Invalid rate date'});
 const {rows}=await db.execute({sql:'SELECT DISTINCT upper(currency_code) code FROM procurement_fx_rates WHERE base_currency=?',args:[base]});
 const codes=[...new Set([base,'USD','JMD','CAD','EUR','GBP','CNY',...rows.map(x=>x.code)])],options=[];
 for(const code of codes){try{const r=await getRate(db,code,date);options.push({currency:code,rate_to_base:r.rate_to_base,rate_id:r.id||null,source_reference:r.source_reference,valid_from:r.valid_from||null,valid_until:r.valid_until||null,available:true});}catch(e){if(e.status!==409)throw e;options.push({currency:code,available:false});}}
 res.json({base_currency:base,as_of:date,options,can_set_order_rate:!req.apiKey&&!!req.employee&&can(req.employee.permissions,'purchasing_approve')});
}catch(e){res.status(e.status||500).json({error:e.message});}});
router.post('/',requirePermission('purchasing_create'),async(req,res,next)=>{try{
 if(!Array.isArray(req.body?.items)||!req.body.items.length)return next();
 req.purchaseCurrency=await resolveCurrency(req,req.body.items);req.body.items=req.purchaseCurrency.items;next();
}catch(e){res.status(e.status||400).json({error:e.message});}});
router.get('/:id/currency-evidence',requirePermission('purchasing'),async(req,res)=>{try{const {rows:[row]}=await db.execute({sql:'SELECT * FROM purchase_order_fx_snapshots WHERE po_id=?',args:[req.params.id]});if(!row)return res.status(404).json({error:'This historical PO has no saved currency snapshot'});res.json({...row,lines:JSON.parse(row.lines_json),lines_json:undefined});}catch(e){res.status(500).json({error:e.message});}});
module.exports=router;
