'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');
const {ensureGovernance}=require('./procurement-decision-governance');

function keyBreak(x){return `${Number(x.offer_id)}:${Number(x.min_purchase_qty)}`;}
router.use(async(req,res,next)=>{try{await ensureGovernance();next();}catch(e){res.status(500).json({error:'Procurement change explanation initialization failed',detail:e.message});}});
router.get('/decision-reviews/:id/what-changed',requirePermission('purchase_requests'),async(req,res)=>{
  try{
    const {rows:[r]}=await db.execute({sql:'SELECT * FROM procurement_decision_reviews WHERE id=?',args:[req.params.id]});if(!r)return res.status(404).json({error:'Decision review not found'});
    const before=JSON.parse(r.market_snapshot_json||'{"offers":[],"price_breaks":[],"candidates":[]}'),requirements=JSON.parse(r.requirements_json||'[]'),ids=requirements.map(x=>Number(x.product_id)).filter(Boolean),changes=[];
    let offers=[];
    if(ids.length){const marks=ids.map(()=>'?').join(',');const result=await db.execute({sql:`SELECT o.id,o.supplier_id,o.product_id,o.supplier_sku,o.purchase_uom,o.units_per_purchase_uom,o.unit_cost_per_purchase_uom,o.currency,o.minimum_order_qty,o.order_multiple,o.lead_time_days,o.freight_per_order,o.freight_per_purchase_uom,o.duty_rate,o.availability_qty,o.valid_from,o.valid_until,o.active,o.updated_at,s.active supplier_active,s.name supplier_name,s.payment_terms,sp.reliability_score FROM supplier_product_offers o JOIN suppliers s ON s.id=o.supplier_id LEFT JOIN supplier_performance_snapshots sp ON sp.supplier_id=s.id WHERE o.product_id IN (${marks}) ORDER BY o.product_id,o.supplier_id,o.id`,args:ids});offers=result.rows;}
    const offerIds=offers.map(o=>Number(o.id));let priceBreaks=[];
    if(offerIds.length){const marks=offerIds.map(()=>'?').join(',');const result=await db.execute({sql:`SELECT offer_id,min_purchase_qty,unit_cost_per_purchase_uom FROM supplier_price_breaks WHERE offer_id IN (${marks}) ORDER BY offer_id,min_purchase_qty`,args:offerIds});priceBreaks=result.rows;}
    const {rows:candidates}=await db.execute({sql:`SELECT id,proposed_name,website,quotation_reference,review_status,linked_supplier_id,created_at,reviewed_at FROM supplier_candidate_reviews WHERE review_status IN ('pending','approved') ORDER BY id`,args:[]});
    const beforeMap=new Map((before.offers||[]).map(o=>[String(o.id),o])),currentMap=new Map(offers.map(o=>[String(o.id),o]));
    for(const [id,o] of currentMap){const old=beforeMap.get(id);if(!old){changes.push({type:'new_offer',offer_id:Number(id),supplier_id:o.supplier_id,product_id:o.product_id,summary:`New supplier offer from ${o.supplier_name}`});continue;}for(const field of ['unit_cost_per_purchase_uom','availability_qty','lead_time_days','valid_until','active','supplier_active','payment_terms','reliability_score','freight_per_order','freight_per_purchase_uom','duty_rate','currency','minimum_order_qty','order_multiple','units_per_purchase_uom'])if(String(old[field]??'')!==String(o[field]??''))changes.push({type:`${field}_changed`,offer_id:Number(id),supplier_id:o.supplier_id,product_id:o.product_id,previous:old[field]??null,current:o[field]??null,summary:`${o.supplier_name}: ${field} changed`});}
    for(const [id,o] of beforeMap)if(!currentMap.has(id))changes.push({type:'offer_removed',offer_id:Number(id),supplier_id:o.supplier_id,product_id:o.product_id,summary:`Supplier offer ${id} is no longer present`});
    const oldBreaks=new Map((before.price_breaks||[]).map(x=>[keyBreak(x),x])),newBreaks=new Map(priceBreaks.map(x=>[keyBreak(x),x]));
    for(const [key,b] of newBreaks){const old=oldBreaks.get(key);if(!old)changes.push({type:'price_break_added',offer_id:Number(b.offer_id),min_purchase_qty:Number(b.min_purchase_qty),current:Number(b.unit_cost_per_purchase_uom),summary:`New quantity price break at ${b.min_purchase_qty} purchase units`});else if(Number(old.unit_cost_per_purchase_uom)!==Number(b.unit_cost_per_purchase_uom))changes.push({type:'price_break_price_changed',offer_id:Number(b.offer_id),min_purchase_qty:Number(b.min_purchase_qty),previous:Number(old.unit_cost_per_purchase_uom),current:Number(b.unit_cost_per_purchase_uom),summary:`Quantity-break price changed at ${b.min_purchase_qty} purchase units`});}
    for(const [key,b] of oldBreaks)if(!newBreaks.has(key))changes.push({type:'price_break_removed',offer_id:Number(b.offer_id),min_purchase_qty:Number(b.min_purchase_qty),previous:Number(b.unit_cost_per_purchase_uom),summary:`Quantity price break at ${b.min_purchase_qty} purchase units was removed`});
    const oldCandidates=new Map((before.candidates||[]).map(c=>[String(c.id),c]));for(const c of candidates){const old=oldCandidates.get(String(c.id));if(!old)changes.push({type:'new_supplier_candidate',candidate_id:c.id,summary:`New supplier candidate: ${c.proposed_name}`});else if(old.review_status!==c.review_status)changes.push({type:'supplier_candidate_status_changed',candidate_id:c.id,previous:old.review_status,current:c.review_status,summary:`Supplier candidate ${c.proposed_name} changed from ${old.review_status} to ${c.review_status}`});}
    res.json({review_id:r.id,status:r.status,changed:changes.length>0,change_count:changes.length,changes});
  }catch(e){res.status(500).json({error:e.message});}
});
module.exports=router;
