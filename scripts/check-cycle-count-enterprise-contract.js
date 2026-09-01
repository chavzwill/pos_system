'use strict';
const fs=require('fs');
function read(p){return fs.readFileSync(p,'utf8');}
const server=read('server.js');
const route=read('routes/cycle-count-hardening.js');
const valuation=read('lib/inventory-movement-valuation.js');
const checks=[
 ['hardening mounted before warehouse',server.indexOf("require('./routes/cycle-count-hardening')")>=0&&server.indexOf("require('./routes/cycle-count-hardening')")<server.indexOf("require('./routes/warehouse')")],
 ['creation uses dedicated create permission',route.includes("requirePermission('cyclecounts_create')")],
 ['approval uses dedicated approve permission',route.includes("requirePermission('cyclecounts_approve')")],
 ['creator identity comes from authenticated employee',route.includes('req.body.employee_id=actor(req)')],
 ['branch is mandatory and validated',route.includes('A branch is required for a cycle count')&&route.includes("SELECT id FROM branches WHERE id=? AND active=1")],
 ['overlapping active count scope is rejected',route.includes('An active count (')&&route.includes("status!='committed'")],
 ['blind count is default',route.includes('blind_count INTEGER NOT NULL DEFAULT 1')],
 ['blind count hides expected quantity from counters',route.includes('expected_qty:null')&&route.includes('book_qty_at_count:null')],
 ['live book quantity captured at count entry',route.includes('const book=await liveBookQty')&&route.includes('book_qty_at_count=')],
 ['count and recount events remain auditable',route.includes('cycle_count_events')&&route.includes("eventType=ctl?.latest_count_qty==null?'count':'recount'")],
 ['all lines must be counted before approval',route.includes('Every item must be counted before approval')],
 ['independent approval enforced by default',route.includes("cycle_count_allow_self_approval',false")&&route.includes('Independent approval is required')],
 ['approval prevents negative resulting inventory',route.includes('would make inventory negative')],
 ['bin-level counts update exact bin assignment',route.includes('UPDATE product_bin_assignments SET quantity=quantity+?')],
 ['branch/global inventory and movement evidence update together',route.includes('UPDATE products SET stock_qty=stock_qty+?')&&route.includes("'cycle_count'")],
 ['valuation follows count difference',route.includes('valueStockAdjustment(tx')&&valuation.includes('inventory_adjustment_valuations')],
 ['approval is optimistic/concurrency guarded',route.includes("WHERE id=? AND status!='committed'")&&route.includes('changed concurrently')],
 ['approval/count actor trail is immutable append evidence',route.includes("event_type,employee_id")&&route.includes("'approved'")]
];
let failed=0;
for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Cycle count enterprise: ${name}`);if(!ok)failed++;}
if(failed){console.error(`Cycle-count enterprise contract failed (${failed}/${checks.length}).`);process.exit(1);}
console.log(`Cycle-count enterprise contract OK (${checks.length} checks).`);
