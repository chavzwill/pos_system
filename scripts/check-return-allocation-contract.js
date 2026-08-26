'use strict';
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const ret=read('routes/retail-return-hardening.js');
const refund=read('routes/retail-refund-settlement.js');
const acct=read('lib/accounting-retail-returns.js');
const checks=[
 ['return allocation ledger exists',ret.includes('CREATE TABLE IF NOT EXISTS retail_return_allocations')],
 ['prior allocations prevent repeated discount use',ret.includes('discount_allocated')&&ret.includes('remainingDiscount')],
 ['cashback is allocated across partial returns',ret.includes('cashback_allocated')&&ret.includes('remainingCashback')],
 ['store credit restoration is capped cumulatively',ret.includes('store_credit_restored')&&ret.includes('remainingStoreCredit')],
 ['final return receives rounding remainder',ret.includes('finalReturn?remainingDiscount')&&ret.includes('finalReturn?remainingCashback')],
 ['return entitlement excludes allocated discount and cashback',ret.includes('gross-discountAllocated-cashbackAllocated')],
 ['external refund excludes restored store credit',ret.includes('entitlement-storeCreditRestored')],
 ['variation stock is restored to variation record',ret.includes('UPDATE product_variations SET stock_qty=stock_qty+?')],
 ['branch stock and bin stock are restored',ret.includes('branch_inventory')&&ret.includes('syncBinQty')],
 ['refund settlement uses external refundable amount',refund.includes('external_refund_total')&&refund.includes('external refundable amount')],
 ['refund settlement still caps original tender method',refund.includes('originalTenderAvailability')&&refund.includes('remaining amount originally tendered')],
 ['return accounting splits store credit and refund payable',acct.includes("code:'2300',debit:0,credit:restored")&&acct.includes("code:'2400',debit:0,credit:external")],
 ['charge-account credit note reduces receivables',acct.includes("r.original_payment_method==='credit'?'1100':'2300'")],
 ['refund settlement accounting uses external allocation evidence',acct.includes('expected_external_refund')&&acct.includes('external_refund_total')]
];
for(const [name,pass] of checks)console.log(`${pass?'PASS':'FAIL'} Return allocation: ${name}`);
if(checks.some(([,pass])=>!pass))process.exit(1);
console.log(`Return allocation contract OK (${checks.length} checks).`);
