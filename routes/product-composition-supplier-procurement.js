'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');
const {ensureProductComposition,getComposition}=require('../lib/product-composition');

let readyPromise=null;
async function ensureSupplierProcurement(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await ensureProductComposition();
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS supplier_product_offers(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
        product_id INTEGER NOT NULL REFERENCES products(id),
        supplier_sku TEXT,
        purchase_uom TEXT NOT NULL DEFAULT 'EA',
        units_per_purchase_uom REAL NOT NULL DEFAULT 1,
        unit_cost_per_purchase_uom REAL NOT NULL,
        currency TEXT NOT NULL DEFAULT 'JMD',
        minimum_order_qty REAL NOT NULL DEFAULT 1,
        order_multiple REAL NOT NULL DEFAULT 1,
        lead_time_days INTEGER,
        freight_per_order REAL NOT NULL DEFAULT 0,
        freight_per_purchase_uom REAL NOT NULL DEFAULT 0,
        duty_rate REAL NOT NULL DEFAULT 0,
        availability_qty REAL,
        valid_from TEXT,
        valid_until TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        updated_by_employee_id INTEGER REFERENCES employees(id),
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(supplier_id,product_id,supplier_sku)
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS supplier_price_breaks(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        offer_id INTEGER NOT NULL REFERENCES supplier_product_offers(id) ON DELETE CASCADE,
        min_purchase_qty REAL NOT NULL,
        unit_cost_per_purchase_uom REAL NOT NULL,
        UNIQUE(offer_id,min_purchase_qty)
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS supplier_performance_snapshots(
        supplier_id INTEGER PRIMARY KEY REFERENCES suppliers(id),
        on_time_rate REAL,
        fill_rate REAL,
        quality_acceptance_rate REAL,
        reliability_score REAL,
        sample_size INTEGER NOT NULL DEFAULT 0,
        calculated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:'CREATE INDEX IF NOT EXISTS idx_supplier_offers_product ON supplier_product_offers(product_id,active,supplier_id)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_supplier_breaks_offer ON supplier_price_breaks(offer_id,min_purchase_qty)'}
    ],'write');
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
const r2=v=>Number(Number(v||0).toFixed(2));
function ceilMultiple(value,multiple){const m=Math.max(Number(multiple)||1,1e-9);return Math.ceil((Number(value)||0)/m-1e-12)*m;}
async function effectiveOffer(executor,offer,baseQty){
  const factor=Number(offer.units_per_purchase_uom||1);if(!(factor>0))throw new Error('Supplier offer has invalid units_per_purchase_uom');
  let purchaseQty=Math.max(Number(offer.minimum_order_qty||1),Number(baseQty||0)/factor);purchaseQty=ceilMultiple(purchaseQty,Number(offer.order_multiple||1));
  const {rows:breaks}=await executor.execute({sql:'SELECT * FROM supplier_price_breaks WHERE offer_id=? AND min_purchase_qty<=? ORDER BY min_purchase_qty DESC LIMIT 1',args:[offer.id,purchaseQty]});
  const unitCost=Number(breaks[0]?.unit_cost_per_purchase_uom??offer.unit_cost_per_purchase_uom);if(!(unitCost>=0))throw new Error('Supplier offer has invalid unit cost');
  const merchandise=unitCost*purchaseQty,freight=Number(offer.freight_per_order||0)+Number(offer.freight_per_purchase_uom||0)*purchaseQty,duty=merchandise*Math.max(0,Number(offer.duty_rate||0))/100,total=r2(merchandise+freight+duty),baseUnits=purchaseQty*factor;
  return {offer_id:offer.id,supplier_id:offer.supplier_id,supplier_name:offer.supplier_name,supplier_sku:offer.supplier_sku,purchase_uom:offer.purchase_uom,purchase_quantity:Number(purchaseQty.toFixed(6)),base_units:Number(baseUnits.toFixed(6)),excess_base_units:Number(Math.max(0,baseUnits-baseQty).toFixed(6)),unit_cost_per_purchase_uom:unitCost,merchandise_cost:r2(merchandise),freight_cost:r2(freight),duty_cost:r2(duty),landed_cost:total,effective_landed_cost_per_base_unit:baseUnits>0?Number((total/baseUnits).toFixed(6)):null,lead_time_days:offer.lead_time_days==null?null:Number(offer.lead_time_days),availability_qty:offer.availability_qty==null?null:Number(offer.availability_qty),payment_terms:offer.payment_terms||null,reliability_score:offer.reliability_score==null?null:Number(offer.reliability_score)};
}
async function offersForProduct(executor,productId,baseQty){
  const {rows}=await executor.execute({sql:`SELECT o.*,s.name supplier_name,s.payment_terms,sp.reliability_score FROM supplier_product_offers o JOIN suppliers s ON s.id=o.supplier_id LEFT JOIN supplier_performance_snapshots sp ON sp.supplier_id=s.id WHERE o.product_id=? AND o.active=1 AND s.active=1 AND (o.valid_from IS NULL OR date(o.valid_from)<=date('now')) AND (o.valid_until IS NULL OR date(o.valid_until)>=date('now'))`,args:[productId]});
  const out=[];for(const o of rows){const e=await effectiveOffer(executor,o,baseQty);if(e.availability_qty!=null&&e.purchase_quantity>e.availability_qty+1e-9)continue;out.push(e);}return out.sort((a,b)=>a.landed_cost-b.landed_cost||((b.reliability_score??0)-(a.reliability_score??0))||((a.lead_time_days??9999)-(b.lead_time_days??9999)));
}
async function requirementPlan(executor,requirements){
  const lines=[];let total=0;for(const req of requirements){const qty=Number(req.quantity||0),pid=Number(req.product_id);if(!(pid>0&&qty>0))continue;const {rows:[p]}=await executor.execute({sql:'SELECT id,name,sku FROM products WHERE id=?',args:[pid]});if(!p)throw new Error(`Product ${pid} not found`);const offers=await offersForProduct(executor,pid,qty);if(!offers.length)return {complete:false,missing_product_id:pid,missing_product_name:p.name,lines,total_landed_cost:null};const best=offers[0];lines.push({product_id:pid,product_name:p.name,sku:p.sku||'',required_quantity:qty,best_offer:best,alternatives:offers.slice(1,5)});total+=best.landed_cost;}return {complete:true,lines,total_landed_cost:r2(total)};
}
async function kitCandidates(executor,requirements){
  const reqMap=new Map(requirements.map(x=>[Number(x.product_id),Number(x.quantity)]));
  const {rows:rows}=await executor.execute({sql:`SELECT pc.id,p.id parent_product_id,p.name parent_product_name,p.sku parent_sku FROM product_compositions pc JOIN products p ON p.id=pc.parent_product_id WHERE pc.composition_type='procurement_kit' AND pc.active=1 AND p.active=1`,args:[]});
  const options=[];
  for(const row of rows){const c=await getComposition(executor,Number(row.id));if(!c)continue;const relevant=c.components.filter(x=>reqMap.has(Number(x.component_product_id)));if(!relevant.length)continue;const kits=Math.max(...relevant.map(x=>Math.ceil(reqMap.get(Number(x.component_product_id))/Number(x.quantity_per_parent||1))));if(!(kits>0))continue;const parentOffers=await offersForProduct(executor,row.parent_product_id,kits);if(!parentOffers.length)continue;const parent=parentOffers[0],remaining=[],coverage=[],extras=[];
    for(const req of requirements){const comp=c.components.find(x=>Number(x.component_product_id)===Number(req.product_id));const produced=comp?Number(comp.quantity_per_parent||0)*kits:0;const covered=Math.min(Number(req.quantity),produced);coverage.push({product_id:req.product_id,required:Number(req.quantity),produced,covered,remaining:Math.max(0,Number(req.quantity)-produced)});if(Number(req.quantity)>produced)remaining.push({product_id:req.product_id,quantity:Number(req.quantity)-produced});}
    for(const comp of c.components){const required=Number(reqMap.get(Number(comp.component_product_id))||0),produced=Number(comp.quantity_per_parent||0)*kits;if(produced>required)extras.push({product_id:Number(comp.component_product_id),product_name:comp.component_name,quantity:Number((produced-required).toFixed(6))});}
    const remPlan=await requirementPlan(executor,remaining);if(!remPlan.complete)continue;const total=r2(parent.landed_cost+(remPlan.total_landed_cost||0));options.push({composition_id:c.id,parent_product_id:row.parent_product_id,parent_product_name:row.parent_product_name,parent_sku:row.parent_sku,kits_required:kits,kit_supplier_offer:parent,remaining_component_plan:remPlan,coverage,extra_components:extras,total_landed_cost:total});
  }
  return options.sort((a,b)=>a.total_landed_cost-b.total_landed_cost);
}

router.use(async(req,res,next)=>{try{await ensureSupplierProcurement();next();}catch(e){res.status(500).json({error:'Supplier procurement initialization failed',detail:e.message});}});
router.post('/offers',requirePermission('suppliers'),async(req,res)=>{try{const b=req.body||{};if(!(Number(b.supplier_id)>0&&Number(b.product_id)>0&&Number(b.unit_cost_per_purchase_uom)>=0))return res.status(400).json({error:'supplier_id, product_id and non-negative unit_cost_per_purchase_uom are required'});const result=await db.execute({sql:`INSERT INTO supplier_product_offers(supplier_id,product_id,supplier_sku,purchase_uom,units_per_purchase_uom,unit_cost_per_purchase_uom,currency,minimum_order_qty,order_multiple,lead_time_days,freight_per_order,freight_per_purchase_uom,duty_rate,availability_qty,valid_from,valid_until,active,updated_by_employee_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:[b.supplier_id,b.product_id,b.supplier_sku||null,b.purchase_uom||'EA',Number(b.units_per_purchase_uom||1),Number(b.unit_cost_per_purchase_uom),b.currency||'JMD',Number(b.minimum_order_qty||1),Number(b.order_multiple||1),b.lead_time_days==null?null:Number(b.lead_time_days),Number(b.freight_per_order||0),Number(b.freight_per_purchase_uom||0),Number(b.duty_rate||0),b.availability_qty==null?null:Number(b.availability_qty),b.valid_from||null,b.valid_until||null,b.active===false?0:1,req.employee?.id||null]});const id=Number(result.lastInsertRowid);for(const br of Array.isArray(b.price_breaks)?b.price_breaks:[])if(Number(br.min_purchase_qty)>0&&Number(br.unit_cost_per_purchase_uom)>=0)await db.execute({sql:'INSERT INTO supplier_price_breaks(offer_id,min_purchase_qty,unit_cost_per_purchase_uom) VALUES(?,?,?)',args:[id,Number(br.min_purchase_qty),Number(br.unit_cost_per_purchase_uom)]});res.status(201).json({id});}catch(e){res.status(400).json({error:e.message});}});
router.get('/offers',requirePermission('purchase_requests'),async(req,res)=>{try{const pid=Number(req.query.product_id),qty=Number(req.query.quantity||1);if(!pid)return res.status(400).json({error:'product_id is required'});res.json(await offersForProduct(db,pid,qty));}catch(e){res.status(500).json({error:e.message});}});
router.put('/performance/:supplierId',requirePermission('suppliers'),async(req,res)=>{try{const b=req.body||{},id=Number(req.params.supplierId);const vals=[b.on_time_rate,b.fill_rate,b.quality_acceptance_rate].map(v=>v==null?null:Number(v));if(vals.some(v=>v!=null&&(v<0||v>100)))return res.status(400).json({error:'Performance rates must be between 0 and 100'});const score=b.reliability_score==null?(vals.filter(v=>v!=null).length?vals.filter(v=>v!=null).reduce((s,v)=>s+v,0)/vals.filter(v=>v!=null).length:null):Number(b.reliability_score);await db.execute({sql:`INSERT INTO supplier_performance_snapshots(supplier_id,on_time_rate,fill_rate,quality_acceptance_rate,reliability_score,sample_size,calculated_at) VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(supplier_id) DO UPDATE SET on_time_rate=excluded.on_time_rate,fill_rate=excluded.fill_rate,quality_acceptance_rate=excluded.quality_acceptance_rate,reliability_score=excluded.reliability_score,sample_size=excluded.sample_size,calculated_at=CURRENT_TIMESTAMP`,args:[id,vals[0],vals[1],vals[2],score,b.sample_size||0]});res.json({supplier_id:id,reliability_score:score});}catch(e){res.status(500).json({error:e.message});}});
router.post('/recommendations',requirePermission('purchase_requests'),async(req,res)=>{try{const requirements=(Array.isArray(req.body?.requirements)?req.body.requirements:[]).map(x=>({product_id:Number(x.product_id),quantity:Number(x.quantity)})).filter(x=>x.product_id>0&&x.quantity>0);if(!requirements.length)return res.status(400).json({error:'At least one requirement is required'});const direct=await requirementPlan(db,requirements),kits=await kitCandidates(db,requirements);const viable=[];if(direct.complete)viable.push({strategy:'individual_supplier_mix',total_landed_cost:direct.total_landed_cost,plan:direct});for(const k of kits)viable.push({strategy:'procurement_kit_plus_individuals',total_landed_cost:k.total_landed_cost,plan:k});viable.sort((a,b)=>a.total_landed_cost-b.total_landed_cost);res.json({requirements,direct_plan:direct,procurement_kit_options:kits,recommendation:viable[0]||null,decision_basis:'landed_cost',notes:'Landed cost includes configured merchandise cost, quantity breaks, freight and duty. Lead time, payment terms, availability and reliability are returned for buyer review and tie-breaking; actual PO/receipt evidence remains authoritative.'});}catch(e){res.status(500).json({error:e.message});}});

module.exports=router;
module.exports.ensureSupplierProcurement=ensureSupplierProcurement;
