'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');
const {ensureGovernance}=require('./procurement-decision-governance');
const {ensureSupplierProcurement}=require('./product-composition-supplier-procurement');
const {ensurePurchaseReceivingControls}=require('../lib/purchase-receiving-controls');

const r2=v=>Number(Number(v||0).toFixed(2));
let readyPromise=null;
async function ensureMarketIntelligence(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await ensureGovernance();await ensureSupplierProcurement();await ensurePurchaseReceivingControls();
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS procurement_market_observations(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        observation_type TEXT NOT NULL,
        supplier_id INTEGER REFERENCES suppliers(id),
        product_id INTEGER REFERENCES products(id),
        offer_id INTEGER,
        previous_value TEXT,
        current_value TEXT,
        severity TEXT NOT NULL DEFAULT 'info',
        details TEXT NOT NULL,
        observed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS supplier_scorecard_history(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
        po_count INTEGER NOT NULL DEFAULT 0,
        receipt_count INTEGER NOT NULL DEFAULT 0,
        ordered_units REAL NOT NULL DEFAULT 0,
        received_units REAL NOT NULL DEFAULT 0,
        shortage_units REAL NOT NULL DEFAULT 0,
        overage_units REAL NOT NULL DEFAULT 0,
        inspection_units REAL NOT NULL DEFAULT 0,
        damaged_or_blocked_units REAL NOT NULL DEFAULT 0,
        on_time_rate REAL,
        fill_rate REAL,
        quality_acceptance_rate REAL,
        reliability_score REAL,
        captured_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:'CREATE INDEX IF NOT EXISTS idx_proc_market_supplier_product ON procurement_market_observations(supplier_id,product_id,observed_at)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_supplier_scorecard_history ON supplier_scorecard_history(supplier_id,captured_at)'}
    ],'write');
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}

async function scoreSupplier(executor,supplierId){
  const {rows:[po]}=await executor.execute({sql:`SELECT COUNT(*) po_count,
      COALESCE(SUM(CASE WHEN status='received' THEN 1 ELSE 0 END),0) completed_po_count,
      COALESCE(SUM(CASE WHEN status='received' AND expected_date IS NOT NULL AND received_at IS NOT NULL AND date(received_at)<=date(expected_date) THEN 1 ELSE 0 END),0) on_time_po_count
      FROM purchase_orders WHERE supplier_id=?`,args:[supplierId]});
  const {rows:[qty]}=await executor.execute({sql:`SELECT COALESCE(SUM(poi.quantity_ordered),0) ordered_units,COALESCE(SUM(poi.quantity_received),0) received_units
      FROM purchase_order_items poi JOIN purchase_orders po ON po.id=poi.po_id WHERE po.supplier_id=?`,args:[supplierId]});
  const {rows:[receipts]}=await executor.execute({sql:'SELECT COUNT(*) receipt_count FROM purchase_receipts WHERE supplier_id=?',args:[supplierId]});
  const {rows:[exceptions]}=await executor.execute({sql:`SELECT
      COALESCE(SUM(CASE WHEN pre.exception_type='shortage' THEN ABS(pre.variance_quantity) ELSE 0 END),0) shortage_units,
      COALESCE(SUM(CASE WHEN pre.exception_type='overage' THEN ABS(pre.variance_quantity) ELSE 0 END),0) overage_units
      FROM purchase_receipt_exceptions pre JOIN purchase_orders po ON po.id=pre.po_id WHERE po.supplier_id=?`,args:[supplierId]});
  const {rows:[quality]}=await executor.execute({sql:`SELECT
      COALESCE(SUM(q.quantity),0) inspection_units,
      COALESCE(SUM(CASE WHEN q.status IN ('damaged','blocked','quarantine') THEN q.quantity ELSE 0 END),0) rejected_units
      FROM purchase_receipt_quality_holds q JOIN purchase_receipt_items pri ON pri.id=q.receipt_item_id JOIN purchase_receipts pr ON pr.id=pri.receipt_id WHERE pr.supplier_id=?`,args:[supplierId]});
  const completed=Number(po?.completed_po_count||0),onTime=Number(po?.on_time_po_count||0),ordered=Number(qty?.ordered_units||0),received=Number(qty?.received_units||0),shortage=Number(exceptions?.shortage_units||0),inspection=Number(quality?.inspection_units||0),rejected=Number(quality?.rejected_units||0);
  const onTimeRate=completed>0?Number((100*onTime/completed).toFixed(2)):null;
  const fillRate=ordered>0?Number((100*Math.min(received,ordered)/ordered).toFixed(2)):null;
  const qualityRate=inspection>0?Number((100*Math.max(0,inspection-rejected)/inspection).toFixed(2)):null;
  const parts=[onTimeRate,fillRate,qualityRate].filter(v=>v!=null);const reliability=parts.length?Number((parts.reduce((s,v)=>s+v,0)/parts.length).toFixed(2)):null;
  return {supplier_id:Number(supplierId),po_count:Number(po?.po_count||0),receipt_count:Number(receipts?.receipt_count||0),ordered_units:ordered,received_units:received,shortage_units:shortage,overage_units:Number(exceptions?.overage_units||0),inspection_units:inspection,damaged_or_blocked_units:rejected,on_time_rate:onTimeRate,fill_rate:fillRate,quality_acceptance_rate:qualityRate,reliability_score:reliability};
}

async function offerTrend(executor,{productId,supplierId,days=365}){
  const args=[];let sql=`SELECT h.*,s.name supplier_name,p.name product_name,p.sku product_sku FROM supplier_offer_history h JOIN suppliers s ON s.id=h.supplier_id JOIN products p ON p.id=h.product_id WHERE h.captured_at>=datetime('now',?)`;args.push(`-${Math.max(1,Number(days)||365)} days`);
  if(productId){sql+=' AND h.product_id=?';args.push(productId);}if(supplierId){sql+=' AND h.supplier_id=?';args.push(supplierId);}sql+=' ORDER BY h.product_id,h.supplier_id,h.captured_at,h.id';
  const {rows}=await executor.execute({sql,args});const groups=new Map();for(const row of rows){const key=`${row.product_id}:${row.supplier_id}:${row.supplier_sku||''}`;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
  return [...groups.values()].map(list=>{const first=list[0],last=list[list.length-1],firstCost=Number(first.unit_cost_per_purchase_uom||0),lastCost=Number(last.unit_cost_per_purchase_uom||0);return {product_id:last.product_id,product_name:last.product_name,product_sku:last.product_sku,supplier_id:last.supplier_id,supplier_name:last.supplier_name,supplier_sku:last.supplier_sku,purchase_uom:last.purchase_uom,currency:last.currency,first_cost:firstCost,current_cost:lastCost,absolute_change:r2(lastCost-firstCost),percent_change:firstCost>0?Number((100*(lastCost-firstCost)/firstCost).toFixed(2)):null,first_seen:first.captured_at,last_seen:last.captured_at,observations:list.length,latest_availability:last.availability_qty,latest_lead_time_days:last.lead_time_days};});
}

router.use(async(req,res,next)=>{try{await ensureMarketIntelligence();next();}catch(e){res.status(500).json({error:'Procurement market intelligence initialization failed',detail:e.message});}});

router.get('/price-trends',requirePermission('purchase_requests'),async(req,res)=>{try{res.json(await offerTrend(db,{productId:req.query.product_id?Number(req.query.product_id):null,supplierId:req.query.supplier_id?Number(req.query.supplier_id):null,days:req.query.days||365}));}catch(e){res.status(500).json({error:e.message});}});

router.get('/offer-alerts',requirePermission('purchase_requests'),async(req,res)=>{try{
  const days=Math.max(0,Number(req.query.expiry_days||14));
  const {rows}=await db.execute({sql:`SELECT o.*,s.name supplier_name,p.name product_name,p.sku product_sku,
      CASE WHEN o.active=0 THEN 'inactive' WHEN o.valid_until IS NOT NULL AND date(o.valid_until)<date('now') THEN 'expired' WHEN o.valid_until IS NOT NULL AND date(o.valid_until)<=date('now', ?) THEN 'expiring_soon' WHEN o.availability_qty IS NOT NULL AND o.availability_qty<=0 THEN 'unavailable' ELSE 'active' END alert_type
      FROM supplier_product_offers o JOIN suppliers s ON s.id=o.supplier_id JOIN products p ON p.id=o.product_id
      WHERE o.active=0 OR (o.valid_until IS NOT NULL AND date(o.valid_until)<=date('now', ?)) OR (o.availability_qty IS NOT NULL AND o.availability_qty<=0)
      ORDER BY CASE alert_type WHEN 'expired' THEN 1 WHEN 'unavailable' THEN 2 WHEN 'expiring_soon' THEN 3 ELSE 4 END,o.valid_until,o.updated_at`,args:[`+${days} days`,`+${days} days`]});res.json(rows);
}catch(e){res.status(500).json({error:e.message});}});

router.post('/scorecards/refresh/:supplierId',requirePermission('purchasing_approve'),async(req,res)=>{try{const id=Number(req.params.supplierId);const {rows:[s]}=await db.execute({sql:'SELECT id,name FROM suppliers WHERE id=?',args:[id]});if(!s)return res.status(404).json({error:'Supplier not found'});const score=await scoreSupplier(db,id);await db.execute({sql:`INSERT INTO supplier_performance_snapshots(supplier_id,on_time_rate,fill_rate,quality_acceptance_rate,reliability_score,sample_size,calculated_at) VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(supplier_id) DO UPDATE SET on_time_rate=excluded.on_time_rate,fill_rate=excluded.fill_rate,quality_acceptance_rate=excluded.quality_acceptance_rate,reliability_score=excluded.reliability_score,sample_size=excluded.sample_size,calculated_at=CURRENT_TIMESTAMP`,args:[id,score.on_time_rate,score.fill_rate,score.quality_acceptance_rate,score.reliability_score,score.po_count]});await db.execute({sql:`INSERT INTO supplier_scorecard_history(supplier_id,po_count,receipt_count,ordered_units,received_units,shortage_units,overage_units,inspection_units,damaged_or_blocked_units,on_time_rate,fill_rate,quality_acceptance_rate,reliability_score) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:[id,score.po_count,score.receipt_count,score.ordered_units,score.received_units,score.shortage_units,score.overage_units,score.inspection_units,score.damaged_or_blocked_units,score.on_time_rate,score.fill_rate,score.quality_acceptance_rate,score.reliability_score]});res.json({...score,supplier_name:s.name});}catch(e){res.status(500).json({error:e.message});}});

router.get('/scorecards/:supplierId/history',requirePermission('purchase_requests'),async(req,res)=>{try{const{rows}=await db.execute({sql:'SELECT * FROM supplier_scorecard_history WHERE supplier_id=? ORDER BY captured_at DESC,id DESC LIMIT 100',args:[req.params.supplierId]});res.json(rows);}catch(e){res.status(500).json({error:e.message});}});

router.get('/decision-reviews/:id/what-changed',requirePermission('purchase_requests'),async(req,res)=>{try{
  const {rows:[r]}=await db.execute({sql:'SELECT * FROM procurement_decision_reviews WHERE id=?',args:[req.params.id]});if(!r)return res.status(404).json({error:'Decision review not found'});const before=JSON.parse(r.market_snapshot_json||'{"offers":[],"candidates":[]}');const requirements=JSON.parse(r.requirements_json||'[]');const ids=requirements.map(x=>Number(x.product_id)).filter(Boolean);const marks=ids.map(()=>'?').join(',')||'NULL';
  const {rows:offers}=ids.length?await db.execute({sql:`SELECT o.id,o.supplier_id,o.product_id,o.supplier_sku,o.purchase_uom,o.units_per_purchase_uom,o.unit_cost_per_purchase_uom,o.currency,o.minimum_order_qty,o.order_multiple,o.lead_time_days,o.freight_per_order,o.freight_per_purchase_uom,o.duty_rate,o.availability_qty,o.valid_from,o.valid_until,o.active,o.updated_at,s.active supplier_active,s.name supplier_name,s.payment_terms,sp.reliability_score FROM supplier_product_offers o JOIN suppliers s ON s.id=o.supplier_id LEFT JOIN supplier_performance_snapshots sp ON sp.supplier_id=s.id WHERE o.product_id IN (${marks}) ORDER BY o.product_id,o.supplier_id,o.id`,args:ids}):{rows:[]};
  const {rows:candidates}=await db.execute({sql:`SELECT id,proposed_name,website,quotation_reference,review_status,linked_supplier_id,created_at,reviewed_at FROM supplier_candidate_reviews WHERE review_status IN ('pending','approved') ORDER BY id`,args:[]});const current={offers,candidates};
  const beforeMap=new Map((before.offers||[]).map(o=>[String(o.id),o])),currentMap=new Map((current.offers||[]).map(o=>[String(o.id),o]));const changes=[];
  for(const [id,o] of currentMap){const old=beforeMap.get(id);if(!old){changes.push({type:'new_offer',offer_id:Number(id),supplier_id:o.supplier_id,product_id:o.product_id,summary:`New supplier offer from ${o.supplier_name}`});continue;}for(const field of ['unit_cost_per_purchase_uom','availability_qty','lead_time_days','valid_until','active','supplier_active','payment_terms','reliability_score','freight_per_order','freight_per_purchase_uom','duty_rate']){if(String(old[field]??'')!==String(o[field]??''))changes.push({type:`${field}_changed`,offer_id:Number(id),supplier_id:o.supplier_id,product_id:o.product_id,previous:old[field]??null,current:o[field]??null,summary:`${o.supplier_name}: ${field} changed`});}}
  for(const [id,o] of beforeMap)if(!currentMap.has(id))changes.push({type:'offer_removed',offer_id:Number(id),supplier_id:o.supplier_id,product_id:o.product_id,summary:`Supplier offer ${id} is no longer present`});
  const oldCandidates=new Map((before.candidates||[]).map(c=>[String(c.id),c]));for(const c of current.candidates||[]){const old=oldCandidates.get(String(c.id));if(!old)changes.push({type:'new_supplier_candidate',candidate_id:c.id,summary:`New supplier candidate: ${c.proposed_name}`});else if(old.review_status!==c.review_status)changes.push({type:'supplier_candidate_status_changed',candidate_id:c.id,previous:old.review_status,current:c.review_status,summary:`Supplier candidate ${c.proposed_name} changed from ${old.review_status} to ${c.review_status}`});}
  res.json({review_id:r.id,status:r.status,changed:changes.length>0,change_count:changes.length,changes});
}catch(e){res.status(500).json({error:e.message});}});

module.exports=router;
module.exports.ensureMarketIntelligence=ensureMarketIntelligence;
