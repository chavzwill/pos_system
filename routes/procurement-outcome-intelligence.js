'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');
const {ensureGovernance}=require('./procurement-decision-governance');
const {ensurePurchaseReceivingControls}=require('../lib/purchase-receiving-controls');

let readyPromise=null;
async function ensureOutcomeIntelligence(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await ensureGovernance();await ensurePurchaseReceivingControls();
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS procurement_decision_po_links(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        review_id INTEGER NOT NULL REFERENCES procurement_decision_reviews(id),
        po_id INTEGER NOT NULL REFERENCES purchase_orders(id),
        linked_by_employee_id INTEGER REFERENCES employees(id),
        linked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(review_id,po_id)
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS procurement_actual_charges(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        po_id INTEGER NOT NULL REFERENCES purchase_orders(id),
        charge_type TEXT NOT NULL,
        amount REAL NOT NULL,
        currency TEXT NOT NULL DEFAULT 'JMD',
        evidence_reference TEXT NOT NULL,
        notes TEXT,
        recorded_by_employee_id INTEGER REFERENCES employees(id),
        recorded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS procurement_outcome_snapshots(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        review_id INTEGER NOT NULL REFERENCES procurement_decision_reviews(id),
        expected_landed_cost REAL,
        actual_merchandise_cost REAL NOT NULL DEFAULT 0,
        actual_additional_charges REAL NOT NULL DEFAULT 0,
        actual_landed_cost REAL NOT NULL DEFAULT 0,
        cost_variance REAL,
        cost_variance_pct REAL,
        ordered_units REAL NOT NULL DEFAULT 0,
        received_units REAL NOT NULL DEFAULT 0,
        shortage_units REAL NOT NULL DEFAULT 0,
        overage_units REAL NOT NULL DEFAULT 0,
        inspection_units REAL NOT NULL DEFAULT 0,
        rejected_units REAL NOT NULL DEFAULT 0,
        on_time_po_count INTEGER NOT NULL DEFAULT 0,
        completed_po_count INTEGER NOT NULL DEFAULT 0,
        average_delivery_variance_days REAL,
        captured_by_employee_id INTEGER REFERENCES employees(id),
        captured_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:'CREATE INDEX IF NOT EXISTS idx_procurement_po_links_review ON procurement_decision_po_links(review_id,po_id)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_procurement_actual_charges_po ON procurement_actual_charges(po_id,recorded_at)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_procurement_outcomes_review ON procurement_outcome_snapshots(review_id,captured_at)'}
    ],'write');
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
const r2=v=>Number(Number(v||0).toFixed(2));
function expectedLandedCost(recommendation){
  const candidates=[recommendation?.total_landed_cost,recommendation?.estimated_total_replenishment_cost,recommendation?.plan?.total_landed_cost,recommendation?.plan?.estimated_total_replenishment_cost,recommendation?.plan?.kit_purchase_cost&&recommendation?.plan?.remaining_standalone_cost!=null?Number(recommendation.plan.kit_purchase_cost)+Number(recommendation.plan.remaining_standalone_cost):null];
  for(const v of candidates)if(v!=null&&Number.isFinite(Number(v)))return r2(v);
  return null;
}
async function linkedPos(executor,reviewId){const {rows}=await executor.execute({sql:`SELECT l.*,po.po_number,po.supplier_id,po.status,po.expected_date,po.received_at,po.total,po.subtotal,s.name supplier_name FROM procurement_decision_po_links l JOIN purchase_orders po ON po.id=l.po_id LEFT JOIN suppliers s ON s.id=po.supplier_id WHERE l.review_id=? ORDER BY l.id`,args:[reviewId]});return rows;}
async function calculateOutcome(executor,review){
  const links=await linkedPos(executor,review.id);if(!links.length)return {review_id:review.id,linked_purchase_orders:[],complete:false,reason:'No purchase orders are linked to this approved sourcing decision.'};
  const ids=links.map(x=>Number(x.po_id)),marks=ids.map(()=>'?').join(',');
  const {rows:[merch]}=await executor.execute({sql:`SELECT COALESCE(SUM(pr.total_cost),0) receipt_merchandise_cost,COUNT(*) receipt_count FROM purchase_receipts pr WHERE pr.po_id IN (${marks})`,args:ids});
  const {rows:[charges]}=await executor.execute({sql:`SELECT COALESCE(SUM(amount),0) additional_charges,COUNT(*) charge_count FROM procurement_actual_charges WHERE po_id IN (${marks})`,args:ids});
  const {rows:[qty]}=await executor.execute({sql:`SELECT COALESCE(SUM(quantity_ordered),0) ordered_units,COALESCE(SUM(quantity_received),0) received_units FROM purchase_order_items WHERE po_id IN (${marks})`,args:ids});
  const {rows:[exceptions]}=await executor.execute({sql:`SELECT COALESCE(SUM(CASE WHEN exception_type='shortage' THEN ABS(variance_quantity) ELSE 0 END),0) shortage_units,COALESCE(SUM(CASE WHEN exception_type='overage' THEN ABS(variance_quantity) ELSE 0 END),0) overage_units FROM purchase_receipt_exceptions WHERE po_id IN (${marks})`,args:ids});
  const {rows:[quality]}=await executor.execute({sql:`SELECT COALESCE(SUM(q.quantity),0) inspection_units,COALESCE(SUM(CASE WHEN q.status IN ('damaged','blocked','quarantine') THEN q.quantity ELSE 0 END),0) rejected_units FROM purchase_receipt_quality_holds q JOIN purchase_receipt_items pri ON pri.id=q.receipt_item_id JOIN purchase_receipts pr ON pr.id=pri.receipt_id WHERE pr.po_id IN (${marks})`,args:ids});
  const completed=links.filter(x=>x.status==='received'&&x.received_at),onTime=completed.filter(x=>x.expected_date&&new Date(x.received_at).getTime()<=new Date(`${x.expected_date}T23:59:59`).getTime());
  const deliveryVariances=completed.filter(x=>x.expected_date).map(x=>(new Date(x.received_at).getTime()-new Date(`${x.expected_date}T00:00:00`).getTime())/86400000).filter(Number.isFinite);
  const recommendation=JSON.parse(review.recommendation_json||'{}'),expected=expectedLandedCost(recommendation),actualMerch=r2(merch?.receipt_merchandise_cost),actualCharges=r2(charges?.additional_charges),actual=r2(actualMerch+actualCharges),variance=expected==null?null:r2(actual-expected),variancePct=expected&&expected!==0?Number((100*(actual-expected)/expected).toFixed(2)):null;
  return {review_id:review.id,decision_key:review.decision_key,linked_purchase_orders:links,expected_landed_cost:expected,actual_merchandise_cost:actualMerch,actual_additional_charges:actualCharges,actual_landed_cost:actual,cost_variance:variance,cost_variance_pct:variancePct,ordered_units:Number(qty?.ordered_units||0),received_units:Number(qty?.received_units||0),shortage_units:Number(exceptions?.shortage_units||0),overage_units:Number(exceptions?.overage_units||0),inspection_units:Number(quality?.inspection_units||0),rejected_units:Number(quality?.rejected_units||0),completed_po_count:completed.length,on_time_po_count:onTime.length,on_time_rate:completed.length?Number((100*onTime.length/completed.length).toFixed(2)):null,average_delivery_variance_days:deliveryVariances.length?Number((deliveryVariances.reduce((s,v)=>s+v,0)/deliveryVariances.length).toFixed(2)):null,receipt_count:Number(merch?.receipt_count||0),actual_charge_count:Number(charges?.charge_count||0),complete:links.every(x=>x.status==='received')};
}

router.use(async(req,res,next)=>{try{await ensureOutcomeIntelligence();next();}catch(e){res.status(500).json({error:'Procurement outcome intelligence initialization failed',detail:e.message});}});

router.post('/decision-reviews/:reviewId/link-po',requirePermission('purchase_requests'),async(req,res)=>{
  try{const reviewId=Number(req.params.reviewId),poId=Number(req.body?.po_id);if(!(reviewId>0&&poId>0))return res.status(400).json({error:'Valid reviewId and po_id are required'});const {rows:[review]}=await db.execute({sql:'SELECT * FROM procurement_decision_reviews WHERE id=?',args:[reviewId]});if(!review)return res.status(404).json({error:'Decision review not found'});if(review.status!=='approved')return res.status(409).json({error:'Only an explicitly approved sourcing decision can be linked to a purchase order'});const {rows:[gate]}=await db.execute({sql:`SELECT id FROM procurement_decision_events WHERE review_id=? AND event_type='pre_po_check_passed' AND created_at>=COALESCE(?,created_at) ORDER BY id DESC LIMIT 1`,args:[reviewId,review.approved_at]});if(!gate)return res.status(409).json({error:'A final market freshness check must pass after approval before the resulting PO can be linked'});const {rows:[po]}=await db.execute({sql:'SELECT id,po_number,status FROM purchase_orders WHERE id=?',args:[poId]});if(!po)return res.status(404).json({error:'Purchase order not found'});await db.execute({sql:'INSERT INTO procurement_decision_po_links(review_id,po_id,linked_by_employee_id) VALUES(?,?,?)',args:[reviewId,poId,req.employee?.id||null]});await db.execute({sql:'INSERT INTO procurement_decision_events(review_id,event_type,employee_id,details) VALUES(?,?,?,?)',args:[reviewId,'po_linked',req.employee?.id||null,`Linked manually created purchase order ${po.po_number}; no PO was generated by procurement intelligence.`]});res.status(201).json({review_id:reviewId,po_id:poId,po_number:po.po_number,purchase_order_created:false});}catch(e){res.status(409).json({error:e.message});}
});

router.post('/purchase-orders/:poId/actual-charges',requirePermission('purchase_requests'),async(req,res)=>{
  try{const poId=Number(req.params.poId),b=req.body||{},type=String(b.charge_type||'').toLowerCase(),amount=Number(b.amount),ref=String(b.evidence_reference||'').trim();if(!['freight','duty','brokerage','insurance','handling','other'].includes(type))return res.status(400).json({error:'charge_type must be freight, duty, brokerage, insurance, handling, or other'});if(!(amount>=0)||!ref)return res.status(400).json({error:'Non-negative amount and evidence_reference are required'});const {rows:[po]}=await db.execute({sql:'SELECT id FROM purchase_orders WHERE id=?',args:[poId]});if(!po)return res.status(404).json({error:'Purchase order not found'});const r=await db.execute({sql:`INSERT INTO procurement_actual_charges(po_id,charge_type,amount,currency,evidence_reference,notes,recorded_by_employee_id) VALUES(?,?,?,?,?,?,?)`,args:[poId,type,amount,b.currency||'JMD',ref,b.notes||null,req.employee?.id||null]});res.status(201).json({id:Number(r.lastInsertRowid),po_id:poId});}catch(e){res.status(500).json({error:e.message});}
});

router.get('/decision-reviews/:reviewId/outcome',requirePermission('purchase_requests'),async(req,res)=>{try{const {rows:[review]}=await db.execute({sql:'SELECT * FROM procurement_decision_reviews WHERE id=?',args:[req.params.reviewId]});if(!review)return res.status(404).json({error:'Decision review not found'});res.json(await calculateOutcome(db,review));}catch(e){res.status(500).json({error:e.message});}});

router.post('/decision-reviews/:reviewId/outcome-snapshot',requirePermission('purchasing_approve'),async(req,res)=>{
  try{const {rows:[review]}=await db.execute({sql:'SELECT * FROM procurement_decision_reviews WHERE id=?',args:[req.params.reviewId]});if(!review)return res.status(404).json({error:'Decision review not found'});const out=await calculateOutcome(db,review);if(!out.linked_purchase_orders?.length)return res.status(409).json({error:'No linked purchase orders exist for this decision'});const r=await db.execute({sql:`INSERT INTO procurement_outcome_snapshots(review_id,expected_landed_cost,actual_merchandise_cost,actual_additional_charges,actual_landed_cost,cost_variance,cost_variance_pct,ordered_units,received_units,shortage_units,overage_units,inspection_units,rejected_units,on_time_po_count,completed_po_count,average_delivery_variance_days,captured_by_employee_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:[review.id,out.expected_landed_cost,out.actual_merchandise_cost,out.actual_additional_charges,out.actual_landed_cost,out.cost_variance,out.cost_variance_pct,out.ordered_units,out.received_units,out.shortage_units,out.overage_units,out.inspection_units,out.rejected_units,out.on_time_po_count,out.completed_po_count,out.average_delivery_variance_days,req.employee?.id||null]});await db.execute({sql:'INSERT INTO procurement_decision_events(review_id,event_type,employee_id,details) VALUES(?,?,?,?)',args:[review.id,'outcome_snapshot',req.employee?.id||null,`Outcome snapshot captured: expected landed cost ${out.expected_landed_cost??'unknown'}, actual landed cost ${out.actual_landed_cost}.`]});res.status(201).json({snapshot_id:Number(r.lastInsertRowid),...out});}catch(e){res.status(500).json({error:e.message});}
});

router.get('/decision-reviews/:reviewId/outcome-history',requirePermission('purchase_requests'),async(req,res)=>{try{const{rows}=await db.execute({sql:'SELECT * FROM procurement_outcome_snapshots WHERE review_id=? ORDER BY captured_at DESC,id DESC LIMIT 100',args:[req.params.reviewId]});res.json(rows);}catch(e){res.status(500).json({error:e.message});}});

module.exports=router;
module.exports.ensureOutcomeIntelligence=ensureOutcomeIntelligence;
module.exports.calculateOutcome=calculateOutcome;
