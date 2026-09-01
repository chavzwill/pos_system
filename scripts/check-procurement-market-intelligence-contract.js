'use strict';
const fs=require('fs'),path=require('path');const root=path.join(__dirname,'..');const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const route=read('routes/procurement-market-intelligence.js'),trace=read('routes/inventory-traceability.js');
const checks=[
 ['market intelligence is mounted under inventory traceability',trace.includes("router.use('/procurement-market',require('./procurement-market-intelligence'))")],
 ['price trend endpoint exists',route.includes("router.get('/price-trends'")],
 ['price trends use preserved supplier offer history',route.includes('supplier_offer_history')&&route.includes('percent_change')],
 ['price trend response includes availability and lead time context',route.includes('latest_availability')&&route.includes('latest_lead_time_days')],
 ['offer expiry and unavailability alerts exist',route.includes("router.get('/offer-alerts'")&&route.includes("'expiring_soon'")&&route.includes("'unavailable'")],
 ['supplier scorecards derive from real purchase orders',route.includes('FROM purchase_orders WHERE supplier_id=?')],
 ['supplier fill rate derives from ordered versus received quantities',route.includes('ordered_units')&&route.includes('received_units')&&route.includes('fillRate')],
 ['supplier on-time score uses expected versus received date',route.includes('date(received_at)<=date(expected_date)')],
 ['supplier quality score consumes incoming inspection evidence',route.includes('purchase_receipt_quality_holds')&&route.includes('quality_acceptance_rate')],
 ['supplier shortage and overage history affect scorecard evidence',route.includes('purchase_receipt_exceptions')&&route.includes('shortage_units')&&route.includes('overage_units')],
 ['scorecard refresh requires purchasing approval',route.includes("router.post('/scorecards/refresh/:supplierId',requirePermission('purchasing_approve')")],
 ['scorecards update the supplier performance signal used by sourcing',route.includes('supplier_performance_snapshots')],
 ['scorecard history is append-only',route.includes('supplier_scorecard_history')&&route.includes('INSERT INTO supplier_scorecard_history')],
 ['buyer can inspect scorecard history',route.includes("router.get('/scorecards/:supplierId/history'")],
 ['what-changed explanation exists for sourcing reviews',route.includes("router.get('/decision-reviews/:id/what-changed'")],
 ['what-changed detects new supplier offers',route.includes("type:'new_offer'")],
 ['what-changed detects price changes',route.includes("'unit_cost_per_purchase_uom'")],
 ['what-changed detects availability changes',route.includes("'availability_qty'")],
 ['what-changed detects lead-time and terms changes',route.includes("'lead_time_days'")&&route.includes("'payment_terms'")],
 ['what-changed detects supplier reliability changes',route.includes("'reliability_score'")],
 ['what-changed detects new supplier candidates',route.includes("type:'new_supplier_candidate'")],
 ['market intelligence remains decision support with no PO insertion',!route.includes('INSERT INTO purchase_orders')&&!route.includes('INSERT INTO purchase_order_items')]
];
let failed=0;for(const[n,ok]of checks){console.log(`${ok?'PASS':'FAIL'} Procurement market intelligence: ${n}`);if(!ok)failed++;}if(failed){console.error(`Procurement market intelligence contract FAILED (${failed}/${checks.length} failed).`);process.exit(1)}console.log(`Procurement market intelligence contract OK (${checks.length} checks).`);
