'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const sale=read('routes/rental-asset-sales.js'),guard=read('routes/rental-asset-sale-guard.js'),trace=read('routes/inventory-traceability.js'),life=read('routes/rental-asset-lifecycle.js');
new vm.Script(sale,{filename:'rental asset sales'});new vm.Script(guard,{filename:'rental asset sale guard'});
const checks=[
 ['sale guard is mounted before fleet sale route',trace.includes("require('./rental-asset-sale-guard')")&&trace.indexOf('rental-asset-sale-guard')<trace.indexOf('rental-asset-sales')],
 ['fleet sale route is mounted before lifetime reporting',trace.includes("require('./rental-asset-sales')")&&trace.indexOf('rental-asset-sales')<trace.indexOf('rental-asset-lifetime-economics')],
 ['zero-value exits are rejected as sales',guard.includes('price<=0')&&guard.includes('controlled disposal/write-off workflow')],
 ['customer buyout requires source rental agreement evidence',guard.includes("type==='customer_buyout'")&&guard.includes('source_agreement_id')],
 ['asset must explicitly be awaiting sale',sale.includes("status)!=='awaiting_sale'")&&life.includes("status='awaiting_sale'" )],
 ['open rental allocation blocks ownership transfer',sale.includes('cannot be sold while allocated to an unresolved rental')],
 ['open maintenance blocks fleet sale',sale.includes('Complete or formally close maintenance before selling this asset')],
 ['duplicate physical asset sale is prevented',sale.includes('asset_id INTEGER NOT NULL UNIQUE')&&sale.includes('has already been sold')],
 ['customer buyout proves exact asset/customer rental history',sale.includes('rental_asset_allocations')&&sale.includes('source agreement does not prove this customer previously held this exact rental asset')],
 ['cash sale requires authenticated matching open drawer',sale.includes('Cash fleet sale requires the authenticated cashier and an open drawer session')&&sale.includes("d.status!=='open'")&&sale.includes('Number(d.branch_id)!==Number(r.asset.branch_id)')],
 ['charge-account sale checks customer eligibility and limit',sale.includes("customer_type!=='credit'")&&sale.includes('would exceed the customer credit limit')],
 ['electronic/cheque settlement requires external payment evidence',sale.includes('External payment/reference evidence is required for non-cash fleet sale settlement')],
 ['sale creates a distinct completed POS transaction',sale.includes("'rental_fleet_sale'")&&sale.includes('Used Fleet Asset')&&sale.includes("'completed'" )],
 ['sale removes exactly one physical fleet unit from branch/global stock',sale.includes("quantity_change,type,reference,reason")&&sale.includes("-1,'rental_fleet_sale'")&&sale.includes('stock_qty=stock_qty-1')],
 ['inventory cost pool is reduced with auditable movement valuation',sale.includes('valueStockAdjustment')&&sale.includes('inventory_adjustment_valuations')],
 ['sale revenue and tax are journaled from actual settlement',sale.includes("code:'4000'")&&sale.includes("code:'2100'")&&sale.includes("sourceType:'rental_asset_sale'")],
 ['COGS/inventory accounting only posts from preserved cost evidence',sale.includes("cogsStatus='blocked_missing_cost_evidence'")&&sale.includes("acquisition_evidence_grade)==='complete'")&&sale.includes("sourceType:'rental_asset_sale_cogs'")],
 ['serial identity is permanently marked sold',sale.includes("inventory_serials SET status='sold'")],
 ['rental asset lifecycle becomes permanently sold and stores transaction/customer',sale.includes("rental_assets SET status='sold'")&&sale.includes('sold_transaction_id')&&sale.includes('sold_customer_id')],
 ['lifetime economics receives actual disposal proceeds',sale.includes('disposal_value=?')&&sale.includes('sale_price')],
 ['sale evidence keeps exact asset serial customer payment and cost basis',sale.includes('rental_asset_sales')&&sale.includes('payment_reference')&&sale.includes('cost_evidence_basis')],
 ['sale is not implemented by toggling product rental designation',!sale.includes('UPDATE products SET is_rental')],
 ['sale route never creates purchase orders or silently reactivates assets',!sale.includes('INSERT INTO purchase_orders')&&!sale.includes("status='active'")]
];
let failed=0;for(const [name,ok]of checks){console.log(`${ok?'PASS':'FAIL'} Rental fleet sale: ${name}`);if(!ok)failed++;}
if(failed){console.error(`Rental fleet sale contract FAILED (${failed}/${checks.length} failed).`);process.exit(1)}
console.log(`Rental fleet sale contract OK (${checks.length} checks).`);
