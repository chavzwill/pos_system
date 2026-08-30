'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..');const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const server=read('server.js'),checkout=read('routes/rental-checkout-cash-drawer-guard.js'),refund=read('routes/rental-refund-settlement.js'),drawer=read('routes/drawer-refund-evidence.js'),rentals=read('routes/rentals.js'),acct=read('lib/accounting-rentals.js'),helper=read('tests/rental-financial-runtime-helper.js'),business=read('tests/business-integrity.spec.js');
for(const [name,src] of Object.entries({server,checkout,refund,drawer,rentals,acct}))new vm.Script(src,{filename:name});
const checks=[
 ['cash checkout guard mounted before rentals',server.indexOf("rental-checkout-cash-drawer-guard")<server.indexOf("require('./routes/rentals')")],
 ['cash checkout requires employee and drawer',checkout.includes('Cash rental checkout requires the cashier and an open drawer session')],
 ['checkout drawer employee must match',checkout.includes('belongs to a different employee')],
 ['checkout drawer branch must match rental branch',checkout.includes('belongs to a different branch')],
 ['rental accounting treats deposit as liability',acct.includes("code: '2200'")&&acct.includes('Refundable rental deposit liability')],
 ['returned rental releases deposit liability',acct.includes('Release refundable rental deposit liability')],
 ['negative non-credit settlement creates refund payable',acct.includes("code: '2400'")&&acct.includes('Customer rental refund payable')],
 ['refund settlement requires refund permission',refund.includes("requirePermission('transactions_refund')")],
 ['refund settlement refuses non-returned rentals',refund.includes('fully returned before its refund can be settled')],
 ['refund settlement enforces original tender method',refund.includes('must use the original tender method')],
 ['cash rental refund requires open drawer',refund.includes('Open the correct cash drawer before settling this rental refund')],
 ['cash rental refund validates employee ownership',refund.includes('Cash refund drawer belongs to another employee')],
 ['cash rental refund validates branch ownership',refund.includes('Cash refund drawer belongs to another branch')],
 ['refund payout clears refund payable',refund.includes("code:'2400',debit:amount")],
 ['refund payout credits cash or bank evidence account',refund.includes("method==='cash'?'1000':'1010'")],
 ['drawer custody merges rental refund outflows',drawer.includes('rental_refund_settlements')],
 ['runtime fixture proves checkout without drawer is rejected',helper.includes("control).toBe('rental_checkout_cash_drawer')")],
 ['runtime fixture proves issue and return chain',helper.includes("status).toBe('active')")&&helper.includes("status).toBe('returned')")],
 ['runtime fixture proves refund payable accounting',helper.includes("line(detail,'2400')?.credit")],
 ['runtime fixture proves refund payout accounting',helper.includes("source_type==='rental_refund_settlement'")],
 ['runtime fixture proves drawer sees rental refund',helper.includes('cash_refunds')],
 ['business integrity gate registers rental runtime certification',business.includes('registerRentalFinancialRuntimeCertification')]
];
let failed=0;for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Rental runtime prerequisite: ${name}`);if(!ok)failed++;}
if(failed){console.error(`Rental runtime prerequisite FAILED (${failed}/${checks.length} failed).`);process.exit(1);}
console.log(`Rental runtime prerequisite OK (${checks.length} checks).`);
