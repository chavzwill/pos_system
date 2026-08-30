'use strict';
const express=require('express');
const router=express.Router();

// Fleet sale is a transfer of ownership, not a write-off. Zero-value exits
// belong in the controlled disposal/write-off lifecycle instead of masquerading
// as a sale. Customer buyouts must also point back to the rental that proves
// this customer actually held the exact physical asset.
router.post('/assets/:id/sell',(req,res,next)=>{
  const price=Number(req.body?.sale_price),type=String(req.body?.sale_type||'fleet_sale').trim().toLowerCase();
  if(!Number.isFinite(price)||price<=0)return res.status(400).json({error:'Fleet sale price must be greater than zero. Use the controlled disposal/write-off workflow for zero-value asset exits.',control:'rental_fleet_sale_value'});
  if(type==='customer_buyout'&&!Number(req.body?.source_agreement_id))return res.status(400).json({error:'Customer buyout requires the source rental agreement so the exact customer/asset relationship can be verified.',control:'rental_customer_buyout_evidence'});
  next();
});

module.exports=router;
