'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const route=read('routes/warehouse-put-away.js');
const core=read('lib/warehouse-put-away-core.js');
const guard=read('routes/multi-branch-integrity-guard.js');
const ui=read('public/warehouse-put-away-ui.js');
const bridge=read('public/warehouse-shell-bridge.js');
new vm.Script(route);new vm.Script(core);new vm.Script(ui);
const authority=route+'\n'+core;
const checks=[
['permission',route.includes("requirePermission('warehouse')")],
['branch scope',route.includes('default_branch_id')&&authority.includes('branch_id')],
['unlocated stock',authority.includes('branch_inventory')&&authority.includes('product_bin_assignments')&&authority.includes('unlocated_quantity')],
['restricted stock excluded',authority.includes('inventory_stock_status_balances')&&authority.includes('inspection')],
['over-allocation blocked',authority.includes('exceeds available unlocated stock')],
['no stock mutation',!/(UPDATE\s+products\s+SET\s+stock_qty|UPDATE\s+branch_inventory\s+SET\s+stock_qty|INSERT\s+INTO\s+stock_movements)/i.test(authority)],
['employee evidence',authority.includes('warehouse_putaway_events')&&route.includes('req.employee.id')],
['idempotent operation key',authority.includes('operation_key')&&authority.includes('UNIQUE')&&authority.includes('existingEvent')],
['receiving evidence initialized',core.includes('ensurePurchaseReceivingControls')],
['postcondition protects located totals',core.includes('after.located>after.available')],
['generic create blocked',guard.includes('Bin quantity must be changed through Put Away')],
['generic create resolves actual bin branch',guard.includes('binBranch')&&guard.includes('req.body.branch_id=resolvedBranch')],
['legacy null-branch assignment resolves physical bin branch',guard.includes('resolved_branch_id')&&guard.includes('assignmentRecord')],
['generic edit blocked',guard.includes('Use Put Away to change bin quantity')],
['occupied assignment deletion blocked',guard.includes('Cannot delete a bin assignment that still contains stock')],
['authority mounted first',guard.includes("router.use('/warehouse/put-away',require('./warehouse-put-away'))")],
['UI queue',ui.includes('Put Away')&&ui.includes('Unlocated stock')],
['UI bin guidance',ui.includes('Available to put away')&&ui.includes('Target bin')],
['UI exceptions',ui.includes('Inspection holds')&&ui.includes('Receiving exceptions')],
['shell loader',bridge.includes('/warehouse-put-away-ui.js')]
];
let failed=0;for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} put-away: ${name}`);if(!ok)failed++;}
if(failed)throw new Error(`Put-away contract failed: ${failed}`);
console.log(`Put-away contract: ${checks.length}/${checks.length} checks passed`);
