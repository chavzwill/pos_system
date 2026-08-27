'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');const root=path.join(__dirname,'..');const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const supplier=read('routes/product-composition-supplier-procurement.js'),outcome=read('routes/procurement-outcome-intelligence.js'),governance=read('routes/procurement-decision-governance.js'),market=read('routes/procurement-market-intelligence.js'),marketAlerts=read('routes/procurement-market-alerts-hardening.js'),whatChanged=read('routes/procurement-what-changed-hardening.js'),priceBreakHistory=read('routes/procurement-price-break-history.js'),trace=read('routes/inventory-traceability.js'),receiving=read('routes/purchase-receipt-traceability.js'),fx=read('lib/procurement-fx.js'),fxRoute=read('routes/procurement-fx.js'),currencyGuard=read('routes/procurement-currency-guard.js'),offerGuard=read('routes/procurement-offer-integrity-guard.js');
for(const [name,src] of Object.entries({supplier,outcome,fx,fxRoute,currencyGuard,offerGuard,marketAlerts,whatChanged,priceBreakHistory}))new vm.Script(src,{filename:name});
const checks=[
 ['supplier offer history schema exists',supplier.includes('CREATE TABLE IF NOT EXISTS supplier_offer_history')],
 ['new supplier offers automatically capture history',supplier.includes('captureOfferHistory(tx,saved')],
 ['supplier offer updates capture old and new state atomically',supplier.includes("router.put('/offers/:id'")&&supplier.includes('captureOfferHistory(tx,old')&&supplier.includes('captureOfferHistory(tx,saved')&&supplier.includes("db.transaction('write')")],
 ['supplier commercial factors reject invalid values',supplier.includes('must be greater than zero')&&supplier.includes('cannot be negative')&&supplier.includes('valid_until cannot be before valid_from')],
 ['offer integrity guard precedes sourcing engine',trace.indexOf("require('./procurement-offer-integrity-guard')")<trace.indexOf("require('./product-composition-supplier-procurement')")],
 ['nullable supplier SKU duplicate hole is closed',offerGuard.includes("lower(COALESCE(supplier_sku,''))=lower(?)")],
 ['offers require active supplier and physical product',offerGuard.includes('is inactive')&&offerGuard.includes('active physical inventory product')],
 ['offer currency code is validated',offerGuard.includes('/^[A-Z]{3}$/')],
 ['price break history is append-only and trigger-backed',priceBreakHistory.includes('supplier_price_break_history')&&priceBreakHistory.includes('CREATE TRIGGER IF NOT EXISTS trg_supplier_price_break_insert_history')&&priceBreakHistory.includes('trg_supplier_price_break_delete_history')],
 ['price break history is mounted before supplier mutations',trace.indexOf("require('./procurement-price-break-history')")<trace.indexOf("require('./product-composition-supplier-procurement')")],
 ['price break history can be reviewed by product supplier or offer',priceBreakHistory.includes("router.get('/price-break-history'")&&priceBreakHistory.includes('product_id')&&priceBreakHistory.includes('supplier_id')],
 ['governance market fingerprint includes price breaks',governance.includes('price_breaks:priceBreaks')&&governance.includes('supplier_price_breaks')&&governance.includes('fingerprint(snapshot)')],
 ['price break changes invalidate pre-PO freshness',governance.includes('price break')&&governance.includes('pre_po_blocked_stale')],
 ['what-changed hardener runs before legacy market route',trace.indexOf("require('./procurement-what-changed-hardening')")<trace.indexOf("require('./procurement-market-intelligence')")],
 ['what-changed explains added changed and removed price breaks',whatChanged.includes('price_break_added')&&whatChanged.includes('price_break_price_changed')&&whatChanged.includes('price_break_removed')],
 ['what-changed still explains supplier and offer changes',whatChanged.includes('new_offer')&&whatChanged.includes('new_supplier_candidate')&&whatChanged.includes('reliability_score')],
 ['procurement FX uses controlled base currency',fx.includes('procurement_currency_settings')&&fx.includes("base_currency TEXT NOT NULL DEFAULT 'JMD'")],
 ['foreign FX requires evidence-backed positive rate',fxRoute.includes('Positive rate_to_base and source_reference are required')&&fx.includes('No valid FX rate from ${code} to ${base}')],
 ['non-base sourcing fails closed before recommendation engine',trace.indexOf("require('./procurement-currency-guard')")<trace.indexOf("require('./product-composition-supplier-procurement')")&&currencyGuard.includes('not yet normalized to the procurement base currency')],
 ['currency guard scopes procurement kits to relevant requirements',currencyGuard.includes('product_composition_components')&&currencyGuard.includes('pcc.component_product_id IN')],
 ['hardened offer alerts run before legacy market route',trace.indexOf("require('./procurement-market-alerts-hardening')")<trace.indexOf("require('./procurement-market-intelligence')")],
 ['offer alerts prioritize inactive expired unavailable then expiring',marketAlerts.indexOf("THEN 'inactive'")<marketAlerts.indexOf("THEN 'expired'")&&marketAlerts.indexOf("THEN 'expired'")<marketAlerts.indexOf("THEN 'unavailable'")&&marketAlerts.indexOf("THEN 'unavailable'")<marketAlerts.indexOf("THEN 'expiring_soon'")],
 ['procurement outcome module cannot create purchase orders',!outcome.includes('INSERT INTO purchase_orders')],
 ['decision-to-PO linkage requires approved review and pre-PO freshness',outcome.includes("review.status!=='approved'")&&outcome.includes("event_type='pre_po_check_passed'")],
 ['actual charges require evidence and approved charge types',outcome.includes('evidence_reference')&&outcome.includes("'freight','duty','brokerage','insurance','handling','other'")],
 ['actual charges cannot silently mix currencies',outcome.includes('Actual procurement charges must be recorded in the base currency')],
 ['actual merchandise derives from receipt evidence',outcome.includes('SUM(pr.total_cost)')&&outcome.includes('purchase_receipts pr')],
 ['outcome computes cost variance',outcome.includes('expected_landed_cost')&&outcome.includes('actual_landed_cost')&&outcome.includes('cost_variance_pct')],
 ['outcome measures quantity exceptions quality and delivery',outcome.includes("exception_type='shortage'")&&outcome.includes("exception_type='overage'")&&outcome.includes("q.status IN ('damaged','blocked','quarantine')")&&outcome.includes('on_time_rate')],
 ['outcome snapshots are append-only and approval gated',outcome.includes('procurement_outcome_snapshots')&&outcome.includes("requirePermission('purchasing_approve')")],
 ['governance still never auto-creates POs',governance.includes('This approval does not create a purchase order')&&governance.includes('purchase_order_created:false')],
 ['supplier scorecards use real receiving evidence',market.includes('purchase_receipt_exceptions')&&market.includes('purchase_receipt_quality_holds')],
 ['receiving preserves merchandise evidence for outcome analysis',receiving.includes('purchase_receipts')&&receiving.includes('total_cost')]
];
let failed=0;for(const[n,ok]of checks){console.log(`${ok?'PASS':'FAIL'} Procurement outcome: ${n}`);if(!ok)failed++;}if(failed){console.error(`Procurement outcome contract FAILED (${failed}/${checks.length} failed).`);process.exit(1)}console.log(`Procurement outcome contract OK (${checks.length} checks).`);
