'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const value=read('routes/loss-control-value-preservation.js'),trace=read('routes/inventory-traceability.js'),accounting=read('lib/accounting-posting.js');
new vm.Script(value,{filename:'value preservation intelligence'});
const checks=[
 ['value preservation intelligence is mounted under loss control',trace.includes("router.use('/loss-control',require('./loss-control-value-preservation'))")],
 ['value preservation intelligence requires reports permission',value.includes("router.use(requirePermission('reports'))")],
 ['financial contribution reads posted journal evidence only',value.includes("je.status='posted'")&&value.includes('journal_lines')&&value.includes('journal_entries')],
 ['revenue classification uses configured retail service and rental revenue accounts',value.includes("['4000','4100','4200']")],
 ['direct cost classification includes COGS labour logistics fees tax and inventory loss',value.includes("['5000','5100','5200','5300','5450','5500']")],
 ['contribution is explicitly before unallocated overhead',value.includes('accounted_contribution_before_unallocated_overhead')],
 ['known leakage is an explanatory overlay rather than a second subtraction',value.includes('NOT subtracted again from ledger contribution')&&value.includes('double-count')],
 ['settled refunds and approved writeoffs are included in leakage explanation',value.includes("sr.status='settled'")&&value.includes("'inventory_writeoff'")],
 ['approved concessions become realized only after settlement application',value.includes("sc.status='approved' AND sc.applied_transaction_id IS NOT NULL")&&value.includes("sc.status='approved' AND sc.applied_transaction_id IS NULL")],
 ['pending refunds and promotions remain at-risk exposure',value.includes("status IN ('pending_approval','approved')")&&value.includes("'promotion_discount'")],
 ['writeoff overlay uses tracked inventory valuation',value.includes('COALESCE(tracked_value,0)')],
 ['branch view preserves account-level revenue and direct-cost evidence',value.includes('revenue_accounts')&&value.includes('direct_cost_accounts')],
 ['posted journal source coverage is exposed',value.includes('posted_source_coverage')&&value.includes('source_type')],
 ['historical retail COGS evidence gap is detected instead of invented',value.includes('retail_historical_cogs')&&value.includes('full retail gross profit and product profitability are not claimed')],
 ['accounting ledger foundation preserves posted journal and line evidence',accounting.includes('journal_entries')&&accounting.includes('journal_lines')&&accounting.includes("status TEXT NOT NULL DEFAULT 'draft'")],
 ['audited net profit is explicitly not claimed',value.includes('does not claim audited net profit')],
 ['value preservation intelligence is read only',value.includes('automatic_actions:false')&&!value.includes('UPDATE products SET')&&!value.includes('UPDATE customers SET')&&!value.includes('INSERT INTO purchase_orders')&&!value.includes('INSERT INTO journal_entries')]
];
let failed=0;for(const [name,ok]of checks){console.log(`${ok?'PASS':'FAIL'} Value preservation: ${name}`);if(!ok)failed++;}if(failed){console.error(`Value preservation contract FAILED (${failed}/${checks.length} failed).`);process.exit(1)}console.log(`Value preservation contract OK (${checks.length} checks).`);
