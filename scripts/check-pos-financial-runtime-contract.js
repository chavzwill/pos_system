'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const checkout=read('routes/retail-checkout-hardening.js');
const snapshot=read('routes/retail-cost-snapshot.js');
const refunds=read('routes/retail-refund-settlement.js');
const drawer=read('routes/drawer-refund-evidence.js');
const drawerGuard=read('routes/drawer-session-hardening.js');
const drawerUi=read('public/cash-drawer-workspace.js');
const securitySpec=read('tests/security-boundaries.spec.js');
const runtimeSpec=read('tests/pos-financial-runtime.js');
for(const [name,src] of Object.entries({checkout,snapshot,refunds,drawer,drawerGuard,drawerUi,securitySpec,runtimeSpec}))new vm.Script(src.replace(/^import .*$/mg,'').replace(/\btest\.describe[\s\S]*/,'// test body omitted for syntax contract'),{filename:name});
const checks=[
 ['checkout mounts sale-time cost snapshot',checkout.includes("router.use(require('./retail-cost-snapshot'))")],
 ['sale-time cost evidence preserves transaction and line identity',snapshot.includes('retail_transaction_cost_snapshots')&&snapshot.includes('transaction_item_id')&&snapshot.includes('cost_basis')],
 ['refund settlement is bound to a drawer session for cash',refunds.includes('resolveRefundDrawer')&&refunds.includes('drawer_session_id')],
 ['drawer evidence subtracts refund legs from gross tender',drawer.includes('retail_refund_settlements')&&drawer.includes('net_tenders')&&drawer.includes('cash_net_movement')],
 ['refund-aware drawer evidence is mounted before legacy drawer detail',drawerGuard.includes("router.use(require('./drawer-refund-evidence'))")],
 ['drawer UI exposes gross, refunds and net movement',drawerUi.includes('Gross ${money(t.gross_tender)}')&&drawerUi.includes('Refunds ${money(t.refunds)}')&&drawerUi.includes('Net cash movement')],
 ['release-gate security spec imports POS financial runtime certification',securitySpec.includes("import './pos-financial-runtime.js'")],
 ['runtime fixture creates controlled stock through stock adjustment',runtimeSpec.includes('adjustment:2')&&runtimeSpec.includes('Runtime POS financial certification')],
 ['runtime fixture proves branch stock decreases then restores',runtimeSpec.includes('branch_stock_qty)).toBe(1)')&&runtimeSpec.includes('branch_stock_qty)).toBe(2)')],
 ['runtime fixture proves cash refund is tied to the same drawer',runtimeSpec.includes('drawer_session_id:session.id')&&runtimeSpec.includes("tenders:[{method:'cash',amount:100}]")],
 ['runtime fixture proves net drawer movement returns to zero',runtimeSpec.includes('cash.net_movement)).toBe(0)')&&runtimeSpec.includes('cash_net_movement)).toBe(0)')],
 ['runtime fixture retires temporary master records',runtimeSpec.includes('active:0')&&runtimeSpec.includes('/api/drawers/${drawer.id}')&&runtimeSpec.includes('/api/products/${product.id}')]
];
let failed=0;for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} POS financial runtime prerequisite: ${name}`);if(!ok)failed++;}
if(failed){console.error(`POS financial runtime prerequisite contract FAILED (${failed}/${checks.length} failed).`);process.exit(1);}
console.log(`POS financial runtime prerequisite contract OK (${checks.length} checks). Playwright execution remains the authoritative runtime certification.`);
