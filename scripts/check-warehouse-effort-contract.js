'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const repo=path.join(__dirname,'..');
const route=fs.readFileSync(path.join(repo,'routes','warehouse-fulfillment-assistant.js'),'utf8');
const ui=fs.readFileSync(path.join(repo,'public','warehouse-operations-workspace.js'),'utf8');
new vm.Script(route,{filename:'warehouse-fulfillment-assistant.js'});
new vm.Script(ui,{filename:'warehouse-operations-workspace.js'});
const checks=[
 ['Warehouse coordination route is mounted',fs.readFileSync(path.join(repo,'routes','employee-end-shift-assistant.js'),'utf8').includes("router.use(require('./warehouse-fulfillment-assistant'))")],
 ['Workflow uses Pick Verify Pack Stage sequence',route.includes("const STAGES=['ready_to_pick','picked','verified','packed','staged']")&&route.includes("ready_to_pick:'picked'")&&route.includes("picked:'verified'")&&route.includes("verified:'packed'")&&route.includes("packed:'staged'")],
 ['Stages cannot be skipped',route.includes('if(next[current]!==requested)')],
 ['Picking checks located stock sufficiency',route.includes("requested==='picked'")&&route.includes('located_qty')&&route.includes('do not have enough located stock')],
 ['Coordination layer never mutates physical inventory',!route.includes('UPDATE branch_inventory')&&!route.includes('UPDATE products SET stock_qty')&&!route.includes('inventory_movements')],
 ['Warehouse progress is employee attributable',route.includes('updated_by')&&route.includes('employee_id INTEGER NOT NULL')&&route.includes('req.employee.id')],
 ['Warehouse progress is branch scoped',route.includes("s.from_branch_id=?)")&&route.includes('default_branch_id')],
 ['UI exposes exact bin guidance',ui.includes('Go to bin')&&ui.includes('suggested_bin')&&ui.includes('Located qty')],
 ['UI enforces Pick Verify Pack Stage before Ship',ui.includes('Pick → Verify → Pack → Stage')&&ui.includes("flow?.can_ship")&&ui.includes('Complete Pick, Verify, Pack and Stage before shipping.')],
 ['Existing ship endpoint remains the stock-changing action',ui.includes("/api/warehouse/shipments/'+s.id+'/ship")&&route.includes("s.status!=='draft'")]
];
let failed=0;for(const [name,ok] of checks){if(ok)console.log(`PASS Warehouse effort: ${name}`);else{console.error(`FAIL Warehouse effort: ${name}`);failed++;}}
if(failed)process.exit(1);console.log(`Warehouse effort contract OK (${checks.length} checks).`);
