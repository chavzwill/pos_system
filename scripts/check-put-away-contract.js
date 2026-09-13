'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const repo=path.join(__dirname,'..');
function read(p){return fs.readFileSync(path.join(repo,p),'utf8');}
const route=read('routes/warehouse-put-away.js');
const warehouse=read('routes/warehouse.js');
const ui=read('public/warehouse-operations-workspace.js');
new vm.Script(route,{filename:'warehouse-put-away.js'});
const checks=[];
function check(name,ok){checks.push([name,!!ok]);if(!ok)process.exitCode=1;}
check('Put-away requires warehouse permission',route.includes("requirePermission('warehouse')"));
check('Put-away is branch scoped to the employee',route.includes('default_branch_id')&&route.includes('branch_id'));
check('Put-away computes unlocated quantity from branch stock minus bin assignments',route.includes('branch_inventory')&&route.includes('product_bin_assignments')&&route.includes('unlocated_quantity'));
check('Put-away excludes inspection-held quantity from available work',route.includes('inventory_stock_status')&&route.includes('inspection'));
check('Put-away rejects allocation beyond eligible unlocated stock',route.includes('exceeds available unlocated stock'));
check('Put-away writes location evidence only',!/(UPDATE\s+products\s+SET\s+stock_qty|UPDATE\s+branch_inventory\s+SET\s+stock_qty|INSERT\s+INTO\s+stock_movements)/i.test(route));
check('Put-away records attributable employee evidence',route.includes('warehouse_putaway_events')&&route.includes('employee_id')&&route.includes('req.employee.id'));
check('Generic assignment creation cannot seed nonzero quantity',warehouse.includes('Bin quantity must be changed through Put Away')||warehouse.includes('quantity must be zero'));
check('Generic assignment edit cannot directly change quantity',warehouse.includes('Use Put Away to change bin quantity')||warehouse.includes('quantity changes are controlled by Put Away'));
check('Occupied bin assignment cannot be deleted',warehouse.includes('Cannot delete a bin assignment that still contains stock'));
check('Warehouse UI exposes Put Away queue',ui.includes('Put Away')&&ui.includes('Unlocated stock'));
check('Warehouse UI shows target bin and eligible quantity',ui.includes('Available to put away')&&ui.includes('Target bin'));
for(const [name,ok] of checks)console.log(`${ok?'PASS':'FAIL'} put-away: ${name}`);
if(process.exitCode)throw new Error('Put-away contract failed');
console.log(`Put-away contract: ${checks.length}/${checks.length} checks passed`);
