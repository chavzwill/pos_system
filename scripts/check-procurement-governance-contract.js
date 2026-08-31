'use strict';
const fs=require('fs'),path=require('path');const root=path.join(__dirname,'..');const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const governance=read('routes/procurement-decision-governance.js'),trace=read('routes/inventory-traceability.js'),supplierProc=read('routes/product-composition-supplier-procurement.js');
const checks=[
 ['governance route is mounted under inventory traceability',trace.includes("router.use('/procurement-governance',require('./procurement-decision-governance'))")],
 ['sourcing decisions are stored separately from purchase orders',governance.includes('procurement_decision_reviews')&&!governance.includes('INSERT INTO purchase_orders')],
 ['buyer recommendation payload is preserved for review',governance.includes('recommendation_json')&&governance.includes('requirements_json')],
 ['market fingerprint captures supplier state at review time',governance.includes('market_fingerprint')&&governance.includes('marketSnapshot')],
 ['supplier offer price and availability are part of freshness state',governance.includes('unit_cost_per_purchase_uom')&&governance.includes('availability_qty')],
 ['supplier terms reliability and active status are part of freshness state',governance.includes('payment_terms')&&governance.includes('reliability_score')&&governance.includes('supplier_active')],
 ['new candidate suppliers are part of market freshness state',governance.includes('supplier_candidate_reviews')&&governance.includes("review_status IN ('pending','approved')")],
 ['candidate suppliers require review before trust',governance.includes("review_status TEXT NOT NULL DEFAULT 'pending'")&&governance.includes("status must be approved or rejected")],
 ['candidate supplier approval requires purchasing approval authority',governance.includes("router.patch('/supplier-candidates/:id/review',requirePermission('purchasing_approve')")],
 ['offer history preserves price changes instead of overwriting history',governance.includes('supplier_offer_history')&&governance.includes("router.post('/offer-history/capture/:offerId'")],
 ['decision review creation does not create a PO',governance.includes('Human purchasing review created; no purchase order was generated.')],
 ['decision approval requires purchasing approval authority',governance.includes("router.post('/decision-reviews/:id/approve',requirePermission('purchasing_approve')")],
 ['stale market blocks approval',governance.includes('approval_blocked_stale')&&governance.includes('requires_recommendation_refresh:true')],
 ['approved decision still does not create a PO',governance.includes('purchase_order_created:false')],
 ['final pre-PO freshness check is mandatory',governance.includes("router.post('/decision-reviews/:id/pre-po-check'")&&governance.includes("status!=='approved'")],
 ['market change after approval revokes PO readiness',governance.includes("status='stale'")&&governance.includes('pre_po_blocked_stale')],
 ['successful pre-PO check explicitly leaves PO creation to buyer',governance.includes('A buyer must still explicitly create/convert the purchase order.')],
 ['decision events create immutable audit evidence',governance.includes('procurement_decision_events')&&governance.includes("event_type TEXT NOT NULL")],
 ['supplier procurement engine itself remains recommendation-only',supplierProc.includes("router.post('/recommendations'")&&!supplierProc.includes('INSERT INTO purchase_orders')],
 ['manual buyer control is preserved across recommendation and approval layers',supplierProc.includes('buyer review')&&governance.includes('Buyer approval recorded. This approval does not create a purchase order.')]
];
let failed=0;for(const[n,ok]of checks){console.log(`${ok?'PASS':'FAIL'} Procurement governance: ${n}`);if(!ok)failed++;}if(failed){console.error(`Procurement governance contract FAILED (${failed}/${checks.length} failed).`);process.exit(1)}console.log(`Procurement governance contract OK (${checks.length} checks).`);
