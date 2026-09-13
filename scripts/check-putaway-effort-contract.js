'use strict';
const fs=require('fs'),path=require('path');
const repo=path.join(__dirname,'..');
const routePath=path.join(repo,'routes','warehouse-putaway-assistant.js');
const uiPath=path.join(repo,'public','warehouse-operations-workspace.js');
const warehousePath=path.join(repo,'routes','warehouse.js');
const route=fs.existsSync(routePath)?fs.readFileSync(routePath,'utf8'):'';
const ui=fs.readFileSync(uiPath,'utf8');
const warehouse=fs.readFileSync(warehousePath,'utf8');
const checks=[
 ['Put-away queue exists',route.includes("router.get('/putaway")],
 ['Put-away mutation requires warehouse authority',route.includes("router.post('/putaway")&&route.includes("requirePermission('warehouse')")],
 ['Put-away never changes physical stock totals',!route.includes('UPDATE branch_inventory')&&!route.includes('UPDATE products SET stock_qty')&&!route.includes('inventory_movements')],
 ['Put-away rejects allocations above branch stock',route.includes('allocated')&&route.includes('branchStock')&&route.includes('exceed')],
 ['Put-away is branch scoped',route.includes('default_branch_id')&&route.includes('branch_id')),
 ['Put-away records employee evidence',route.includes('employee_id')&&route.includes('req.employee.id')&&route.includes('warehouse_putaway_events')),
 ['Put-away supports idempotent operation keys',route.includes('operation_key')&&route.includes('UNIQUE')),
 ['Inspection-held stock is excluded from available put-away work',route.includes('quality_hold')||route.includes('inspection')),
 ['Warehouse UI exposes Put away work',ui.includes('Put away')&&ui.includes('data-putaway')),
 ['Generic assignment create cannot accept arbitrary positive quantity',warehouse.includes("router.post('/assignments'")&&!warehouse.includes("quantity || 0, is_primary")]
];
let failed=0;for(const [name,ok] of checks){if(ok)console.log(`PASS Put-away effort: ${name}`);else{console.error(`FAIL Put-away effort: ${name}`);failed++;}}
if(failed)process.exit(1);console.log(`Put-away effort contract OK (${checks.length} checks).`);
