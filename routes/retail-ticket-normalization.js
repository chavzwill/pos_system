'use strict';
const express=require('express');const router=express.Router();
const {db}=require('../database');
const {requirePermission,can}=require('../lib/permissions');
const {normalizeExtras}=require('../lib/retail-ticket-pricing');
const {ensureSchema}=require('../lib/retail-ticket');
router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Ticket schema initialization failed',detail:e.message});}});
async function normalize(req,res,next){try{
  const {rows:[s]}=await db.execute({sql:"SELECT value FROM settings WHERE key='tax_rate'",args:[]});const rate=Number(s?.value||0);if(!Number.isFinite(rate)||rate<0||rate>100)throw new Error('Default tax rate is invalid');
  const result=normalizeExtras(req.body?.items,rate);
  if(!result.products.length)throw new Error('Include at least one inventory product on a retail ticket');
  if(result.extras.some(x=>x.line_type==='delivery')&&(req.apiKey||!can(req.employee?.permissions,'pos_discounts')))return res.status(403).json({error:'Setting delivery charges requires POS price/discount authority'});
  req.body.items=result.products;req.retailTicketExtras=result.extras;
  // Overwrite any client assertion. Canonical extras participate in checkout replay hashes.
  req.body.retail_ticket={extras:result.extras};next();
}catch(e){res.status(400).json({error:e.message});}}
router.post('/',requirePermission('pos'),(req,res,next)=>{
  // Fail before cart normalization: every sale needs one durable operation ID.
  if(require('./retail-sale-idempotency').operationKey(req))return next();
  res.set('Idempotency-Protection','required');
  return res.status(428).json({
    error:'Idempotency-Key is required for sale settlement. Retry the same logical sale with one stable operation key.',
    code:'IDEMPOTENCY_KEY_REQUIRED'
  });
},normalize);
router.post('/hold',requirePermission('pos_hold'),normalize);
module.exports=router;
