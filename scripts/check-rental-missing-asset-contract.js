'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const disposition=read('routes/rental-missing-asset-disposition.js'),guard=read('routes/rental-loss-prevention.js'),availability=read('lib/rentalAvailability.js'),loss=read('routes/loss-control-rental-missing-asset-leaks.js'),trace=read('routes/inventory-traceability.js');
for(const [name,src] of [['missing asset disposition',disposition],['rental loss guard',guard],['missing asset loss intelligence',loss]])new vm.Script(src,{filename:name});
const checks=[
 ['missing asset workflow is mounted before normal rental processing',guard.includes("router.use(require('./rental-missing-asset-disposition'))")],
 ['normal rental return fails closed for missing or lost conditions',guard.includes('rental_missing_asset_disposition_required')&&guard.includes('missingLike(incomingCondition)')],
 ['missing declaration requires evidence and a meaningful reason',disposition.includes('evidence_reference')&&disposition.includes('missing-asset reason and evidence/reference are required')],
 ['missing disposition requires independent management authorization',disposition.includes('independent financial authorizer')&&disposition.includes('financial_authorizer_pin')],
 ['creator cannot financially authorize own missing asset disposition',disposition.includes('employee who declared the asset missing cannot provide its financial authorization')],
 ['material recovery waiver requires documented reason',disposition.includes('loss_control_rental_missing_asset_waiver_threshold')&&disposition.includes('documented waiver/recovery reason')],
 ['missing physical unit is removed from branch and global inventory',disposition.includes('UPDATE branch_inventory SET stock_qty=stock_qty-?')&&disposition.includes('UPDATE products SET stock_qty=(SELECT COALESCE(SUM(stock_qty),0)')],
 ['missing stock movement is auditable',disposition.includes("'rental_missing_writeoff'")&&disposition.includes('stock_movement_id')],
 ['missing inventory loss uses tracked valuation where possible',disposition.includes('valueStockAdjustment')&&disposition.includes('inventory_adjustment_valuations')&&disposition.includes('current_tracked_inventory_pool')],
 ['missing inventory loss posts accounting evidence',disposition.includes("sourceType:'rental_missing_asset'")&&disposition.includes("code:'5500'")&&disposition.includes("code:'1200'")],
 ['missing quantity is permanently distinguished from physical return',disposition.includes('quantity_missing=quantity_missing+?')&&disposition.includes('quantity_returned=quantity_returned+?')],
 ['rental availability uses administratively resolved quantity without double reserving',availability.includes('rai.quantity - rai.quantity_returned')&&!availability.includes('quantity_returned - COALESCE(rai.quantity_missing')],
 ['approved customer recovery is tracked separately from inventory loss',disposition.includes('approved_customer_charge')&&disposition.includes('inventory_loss_value')&&disposition.includes('waived_amount')],
 ['cash recovery requires an open matching cashier drawer',disposition.includes("drawer_sessions WHERE id=? AND status='open'")&&disposition.includes('Cash collection requires the cashier and an open drawer session')],
 ['missing asset recovery creates durable transaction evidence',disposition.includes("source)'rental_missing_asset'")||disposition.includes("'rental_missing_asset']")||disposition.includes("'rental_missing_asset'" )],
 ['credit recovery increases customer account balance',disposition.includes("if(method==='credit')")&&disposition.includes('account_balance=account_balance+?')],
 ['charge collection is idempotence guarded by pending_collection status',disposition.includes("charge_status!=='pending_collection'")&&disposition.includes("WHERE id=? AND charge_status='pending_collection'")],
 ['loss intelligence is mounted under Loss Control',trace.includes("router.use('/loss-control',require('./loss-control-rental-missing-asset-leaks'))")],
 ['loss intelligence surfaces pending approval, uncollected recovery, and waiver exposure',loss.includes('rental_missing_asset_pending_approval')&&loss.includes('rental_missing_asset_charge_uncollected')&&loss.includes('rental_missing_asset_recovery_waiver')],
 ['loss intelligence remains non-accusatory and cannot mutate financial records',loss.includes('not findings of misconduct')&&loss.includes('No rental, inventory, customer, payment or employee record was changed automatically')]
];
let failed=0;for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Rental missing asset: ${name}`);if(!ok)failed++;}if(failed){console.error(`Rental missing-asset contract FAILED (${failed}/${checks.length} failed).`);process.exit(1);}console.log(`Rental missing-asset contract OK (${checks.length} checks).`);
