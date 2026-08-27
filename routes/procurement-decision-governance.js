'use strict';
const express=require('express');
const crypto=require('crypto');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');

let readyPromise=null;
async function ensureGovernance(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS supplier_candidate_reviews(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        proposed_name TEXT NOT NULL,
        website TEXT,
        contact_name TEXT,
        email TEXT,
        phone TEXT,
        source_note TEXT,
        quotation_reference TEXT,
        review_status TEXT NOT NULL DEFAULT 'pending',
        linked_supplier_id INTEGER REFERENCES suppliers(id),
        submitted_by_employee_id INTEGER REFERENCES employees(id),
        reviewed_by_employee_id INTEGER REFERENCES employees(id),
        review_notes TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        reviewed_at DATETIME
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS procurement_decision_reviews(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        decision_key TEXT NOT NULL UNIQUE,
        requirements_json TEXT NOT NULL,
        recommendation_json TEXT NOT NULL,
        market_fingerprint TEXT NOT NULL,
        market_snapshot_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        stale_reason TEXT,
        created_by_employee_id INTEGER REFERENCES employees(id),
        approved_by_employee_id INTEGER REFERENCES employees(id),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        refreshed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        approved_at DATETIME
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS procurement_decision_events(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        review_id INTEGER NOT NULL REFERENCES procurement_decision_reviews(id),
        event_type TEXT NOT NULL,
        employee_id INTEGER REFERENCES employees(id),
        details TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS supplier_offer_history(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        offer_id INTEGER,
        supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
        product_id INTEGER NOT NULL REFERENCES products(id),
        supplier_sku TEXT,
        purchase_uom TEXT,
        units_per_purchase_uom REAL,
        unit_cost_per_purchase_uom REAL,
        currency TEXT,
        minimum_order_qty REAL,
        order_multiple REAL,
        lead_time_days INTEGER,
        freight_per_order REAL,
        freight_per_purchase_uom REAL,
        duty_rate REAL,
        availability_qty REAL,
        valid_from TEXT,
        valid_until TEXT,
        active INTEGER,
        captured_by_employee_id INTEGER REFERENCES employees(id),
        captured_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:'CREATE INDEX IF NOT EXISTS idx_candidate_supplier_status ON supplier_candidate_reviews(review_status,created_at)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_procurement_decision_status ON procurement_decision_reviews(status,created_at)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_supplier_offer_history_product ON supplier_offer_history(product_id,supplier_id,captured_at)'}
    ],'write');
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
const stable=v=>JSON.stringify(v,Object.keys(v).sort());
function sha(v){return crypto.createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');}
function normalizeRequirements(rows){
  const map=new Map();
  for(const r of Array.isArray(rows)?rows:[]){const id=Number(r?.product_id),qty=Number(r?.quantity);if(id>0&&Number.isFinite(qty)&&qty>0)map.set(id,Number(((map.get(id)||0)+qty).toFixed(6)));}
  return [...map.entries()].map(([product_id,quantity])=>({product_id,quantity})).sort((a,b)=>a.product_id-b.product_id);
}
async function marketSnapshot(executor,requirements){
  const ids=requirements.map(x=>x.product_id);if(!ids.length)return {offers:[],candidates:[]};
  const marks=ids.map(()=>'?').join(',');
  const {rows:offers}=await executor.execute({sql:`SELECT o.id,o.supplier_id,o.product_id,o.supplier_sku,o.purchase_uom,o.units_per_purchase_uom,o.unit_cost_per_purchase_uom,o.currency,o.minimum_order_qty,o.order_multiple,o.lead_time_days,o.freight_per_order,o.freight_per_purchase_uom,o.duty_rate,o.availability_qty,o.valid_from,o.valid_until,o.active,o.updated_at,s.active supplier_active,s.name supplier_name,s.payment_terms,sp.reliability_score
    FROM supplier_product_offers o JOIN suppliers s ON s.id=o.supplier_id LEFT JOIN supplier_performance_snapshots sp ON sp.supplier_id=s.id
    WHERE o.product_id IN (${marks}) ORDER BY o.product_id,o.supplier_id,o.id`,args:ids});
  const {rows:candidates}=await executor.execute({sql:`SELECT id,proposed_name,website,quotation_reference,review_status,linked_supplier_id,created_at,reviewed_at FROM supplier_candidate_reviews WHERE review_status IN ('pending','approved') ORDER BY id`,args:[]});
  return {offers,candidates};
}
function fingerprint(snapshot){return sha(JSON.stringify(snapshot));}
async function event(executor,reviewId,type,employeeId,details){await executor.execute({sql:'INSERT INTO procurement_decision_events(review_id,event_type,employee_id,details) VALUES(?,?,?,?)',args:[reviewId,type,employeeId||null,details||null]});}
async function freshness(executor,review){
  const requirements=JSON.parse(review.requirements_json||'[]');const current=await marketSnapshot(executor,requirements);const currentFingerprint=fingerprint(current);
  return {fresh:currentFingerprint===review.market_fingerprint,current_fingerprint:currentFingerprint,current_snapshot:current};
}

router.use(async(req,res,next)=>{try{await ensureGovernance();next();}catch(e){res.status(500).json({error:'Procurement governance initialization failed',detail:e.message});}});

router.post('/supplier-candidates',requirePermission('purchase_requests'),async(req,res)=>{
  try{const b=req.body||{},name=String(b.proposed_name||'').trim();if(!name)return res.status(400).json({error:'proposed_name is required'});const r=await db.execute({sql:`INSERT INTO supplier_candidate_reviews(proposed_name,website,contact_name,email,phone,source_note,quotation_reference,submitted_by_employee_id) VALUES(?,?,?,?,?,?,?,?)`,args:[name,b.website||null,b.contact_name||null,b.email||null,b.phone||null,b.source_note||null,b.quotation_reference||null,req.employee?.id||null]});res.status(201).json({id:Number(r.lastInsertRowid),review_status:'pending'});}catch(e){res.status(400).json({error:e.message});}
});
router.get('/supplier-candidates',requirePermission('purchase_requests'),async(req,res)=>{try{const args=[];let sql='SELECT * FROM supplier_candidate_reviews WHERE 1=1';if(req.query.status){sql+=' AND review_status=?';args.push(String(req.query.status));}sql+=' ORDER BY created_at DESC,id DESC LIMIT 500';const{rows}=await db.execute({sql,args});res.json(rows);}catch(e){res.status(500).json({error:e.message});}});
router.patch('/supplier-candidates/:id/review',requirePermission('purchasing_approve'),async(req,res)=>{
  try{const status=String(req.body?.status||'');if(!['approved','rejected'].includes(status))return res.status(400).json({error:'status must be approved or rejected'});const {rows:[row]}=await db.execute({sql:'SELECT * FROM supplier_candidate_reviews WHERE id=?',args:[req.params.id]});if(!row)return res.status(404).json({error:'Supplier candidate not found'});if(row.review_status!=='pending')return res.status(409).json({error:'Supplier candidate has already been reviewed'});await db.execute({sql:`UPDATE supplier_candidate_reviews SET review_status=?,linked_supplier_id=?,reviewed_by_employee_id=?,review_notes=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?`,args:[status,req.body?.linked_supplier_id||null,req.employee?.id||null,req.body?.review_notes||null,row.id]});const{rows:[updated]}=await db.execute({sql:'SELECT * FROM supplier_candidate_reviews WHERE id=?',args:[row.id]});res.json(updated);}catch(e){res.status(500).json({error:e.message});}
});

router.post('/offer-history/capture/:offerId',requirePermission('suppliers'),async(req,res)=>{
  try{const {rows:[o]}=await db.execute({sql:'SELECT * FROM supplier_product_offers WHERE id=?',args:[req.params.offerId]});if(!o)return res.status(404).json({error:'Supplier offer not found'});const r=await db.execute({sql:`INSERT INTO supplier_offer_history(offer_id,supplier_id,product_id,supplier_sku,purchase_uom,units_per_purchase_uom,unit_cost_per_purchase_uom,currency,minimum_order_qty,order_multiple,lead_time_days,freight_per_order,freight_per_purchase_uom,duty_rate,availability_qty,valid_from,valid_until,active,captured_by_employee_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:[o.id,o.supplier_id,o.product_id,o.supplier_sku,o.purchase_uom,o.units_per_purchase_uom,o.unit_cost_per_purchase_uom,o.currency,o.minimum_order_qty,o.order_multiple,o.lead_time_days,o.freight_per_order,o.freight_per_purchase_uom,o.duty_rate,o.availability_qty,o.valid_from,o.valid_until,o.active,req.employee?.id||null]});res.status(201).json({history_id:Number(r.lastInsertRowid)});}catch(e){res.status(500).json({error:e.message});}
});
router.get('/offer-history',requirePermission('purchase_requests'),async(req,res)=>{try{const args=[];let sql='SELECT h.*,s.name supplier_name,p.name product_name,p.sku product_sku FROM supplier_offer_history h JOIN suppliers s ON s.id=h.supplier_id JOIN products p ON p.id=h.product_id WHERE 1=1';if(req.query.product_id){sql+=' AND h.product_id=?';args.push(req.query.product_id);}if(req.query.supplier_id){sql+=' AND h.supplier_id=?';args.push(req.query.supplier_id);}sql+=' ORDER BY h.captured_at DESC,h.id DESC LIMIT 1000';const{rows}=await db.execute({sql,args});res.json(rows);}catch(e){res.status(500).json({error:e.message});}});

router.post('/decision-reviews',requirePermission('purchase_requests'),async(req,res)=>{
  try{const requirements=normalizeRequirements(req.body?.requirements);if(!requirements.length)return res.status(400).json({error:'At least one positive requirement is required'});if(!req.body?.recommendation)return res.status(400).json({error:'The buyer-facing recommendation being reviewed is required'});const snap=await marketSnapshot(db,requirements),fp=fingerprint(snap),key=`SRC-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;const r=await db.execute({sql:`INSERT INTO procurement_decision_reviews(decision_key,requirements_json,recommendation_json,market_fingerprint,market_snapshot_json,created_by_employee_id) VALUES(?,?,?,?,?,?)`,args:[key,JSON.stringify(requirements),JSON.stringify(req.body.recommendation),fp,JSON.stringify(snap),req.employee?.id||null]});const id=Number(r.lastInsertRowid);await event(db,id,'created',req.employee?.id,'Human purchasing review created; no purchase order was generated.');res.status(201).json({id,decision_key:key,status:'pending',market_fingerprint:fp});}catch(e){res.status(500).json({error:e.message});}
});
router.get('/decision-reviews/:id',requirePermission('purchase_requests'),async(req,res)=>{try{const{rows:[r]}=await db.execute({sql:'SELECT * FROM procurement_decision_reviews WHERE id=?',args:[req.params.id]});if(!r)return res.status(404).json({error:'Decision review not found'});const{rows:events}=await db.execute({sql:'SELECT * FROM procurement_decision_events WHERE review_id=? ORDER BY id',args:[r.id]});r.requirements=JSON.parse(r.requirements_json);r.recommendation=JSON.parse(r.recommendation_json);r.events=events;delete r.requirements_json;delete r.recommendation_json;res.json(r);}catch(e){res.status(500).json({error:e.message});}});
router.post('/decision-reviews/:id/refresh-check',requirePermission('purchase_requests'),async(req,res)=>{
  try{const{rows:[r]}=await db.execute({sql:'SELECT * FROM procurement_decision_reviews WHERE id=?',args:[req.params.id]});if(!r)return res.status(404).json({error:'Decision review not found'});const f=await freshness(db,r);if(!f.fresh){await db.execute({sql:`UPDATE procurement_decision_reviews SET status=CASE WHEN status='approved' THEN 'stale' ELSE status END,stale_reason='Supplier market changed; regenerate and review sourcing recommendation before PO creation.',refreshed_at=CURRENT_TIMESTAMP WHERE id=?`,args:[r.id]});await event(db,r.id,'market_changed',req.employee?.id,'Supplier offers, supplier status, reliability, or candidate-supplier market changed.');}else await db.execute({sql:'UPDATE procurement_decision_reviews SET refreshed_at=CURRENT_TIMESTAMP WHERE id=?',args:[r.id]});res.json({review_id:r.id,fresh:f.fresh,current_fingerprint:f.current_fingerprint,requires_recommendation_refresh:!f.fresh});}catch(e){res.status(500).json({error:e.message});}
});
router.post('/decision-reviews/:id/approve',requirePermission('purchasing_approve'),async(req,res)=>{
  try{const{rows:[r]}=await db.execute({sql:'SELECT * FROM procurement_decision_reviews WHERE id=?',args:[req.params.id]});if(!r)return res.status(404).json({error:'Decision review not found'});if(r.status!=='pending')return res.status(409).json({error:`Only pending decisions can be approved; current status is ${r.status}`});const f=await freshness(db,r);if(!f.fresh){await db.execute({sql:`UPDATE procurement_decision_reviews SET status='stale',stale_reason='Supplier market changed before approval; regenerate recommendation.' WHERE id=?`,args:[r.id]});await event(db,r.id,'approval_blocked_stale',req.employee?.id,'Approval blocked because supplier market changed.');return res.status(409).json({error:'Supplier market changed since this recommendation was generated. Refresh sourcing before approval.',requires_recommendation_refresh:true});}await db.execute({sql:`UPDATE procurement_decision_reviews SET status='approved',approved_by_employee_id=?,approved_at=CURRENT_TIMESTAMP,refreshed_at=CURRENT_TIMESTAMP WHERE id=?`,args:[req.employee?.id||null,r.id]});await event(db,r.id,'approved',req.employee?.id,'Buyer approval recorded. This approval does not create a purchase order.');res.json({id:r.id,status:'approved',purchase_order_created:false,next_step:'Buyer may manually create or convert an approved purchasing document after a final refresh check.'});}catch(e){res.status(500).json({error:e.message});}
});
router.post('/decision-reviews/:id/pre-po-check',requirePermission('purchase_requests'),async(req,res)=>{
  try{const{rows:[r]}=await db.execute({sql:'SELECT * FROM procurement_decision_reviews WHERE id=?',args:[req.params.id]});if(!r)return res.status(404).json({error:'Decision review not found'});if(r.status!=='approved')return res.status(409).json({error:'Sourcing decision must have explicit buyer approval before PO preparation'});const f=await freshness(db,r);if(!f.fresh){await db.execute({sql:`UPDATE procurement_decision_reviews SET status='stale',stale_reason='Supplier market changed after approval; re-review required before PO creation.' WHERE id=?`,args:[r.id]});await event(db,r.id,'pre_po_blocked_stale',req.employee?.id,'Market changed after approval; PO preparation blocked.');return res.status(409).json({error:'Supplier price, availability, terms, performance, or candidate market changed after approval. Re-run sourcing review.',po_creation_allowed:false});}await event(db,r.id,'pre_po_check_passed',req.employee?.id,'Final market freshness check passed. No PO was generated.');res.json({review_id:r.id,po_creation_allowed:true,purchase_order_created:false,approved_recommendation:JSON.parse(r.recommendation_json),message:'Freshness and approval controls passed. A buyer must still explicitly create/convert the purchase order.'});}catch(e){res.status(500).json({error:e.message});}
});

module.exports=router;
module.exports.ensureGovernance=ensureGovernance;
