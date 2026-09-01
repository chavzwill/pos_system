'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const server=read('server.js');
const guard=read('routes/multi-branch-integrity-guard.js');
const checkout=read('routes/retail-checkout-hardening.js');
const drawers=read('routes/drawer-session-hardening.js');
const po=read('routes/purchase-order-hardening.js');
const rentals=read('routes/rental-loss-prevention.js');
const workOrders=read('routes/work-orders.js');
const adjustment=read('routes/inventory-adjustment-hardening.js');
const writeoffs=read('routes/inventory-writeoffs.js');
const transfer=read('routes/transfer-traceability-hardening.js');
const accounting=read('lib/accounting-posting.js');
for(const [name,src] of Object.entries({server,guard,checkout,drawers,po,rentals,workOrders,adjustment,writeoffs,transfer,accounting}))new vm.Script(src,{filename:name});
const checks=[
 ['branch guard mounts immediately after session authentication',server.indexOf("app.use('/api', require('./routes/multi-branch-integrity-guard'))")>server.indexOf("app.use('/api', sessionAuth)")&&server.indexOf("app.use('/api', require('./routes/multi-branch-integrity-guard'))")<server.indexOf("/api/inventory-writeoffs")],
 ['ordinary branch users are compared to default_branch_id',guard.includes('default_branch_id')&&guard.includes("control:'multi_branch_integrity'")],
 ['cross-branch override is limited to branch/security administrators',guard.includes("can(employee.permissions,'branches')")&&guard.includes("can(employee.permissions,'security_manage')")],
 ['API integrations are left to explicit API-key scope/branch contracts',guard.includes('if(req.apiKey||!req.employee')],
 ['POS checkout binds normal employees to assigned branch',checkout.includes('canOperateCrossBranch')&&checkout.includes('You cannot complete a sale for another branch')],
 ['POS forces authenticated employee identity',checkout.includes('body.employee_id = req.employee.id')],
 ['POS drawer session must match employee',checkout.includes('This cash drawer session belongs to another employee')],
 ['POS drawer session must match selling branch',checkout.includes('Cash drawer session does not belong to the selling branch')],
 ['direct inventory adjustment is branch-bound',guard.includes('/products\\/\\d+\\/stock')&&adjustment.includes('global stock cannot be edited independently of branch inventory')],
 ['inventory adjustment reconciles global stock from branch totals',adjustment.includes("SELECT COALESCE(SUM(stock_qty),0) qty FROM branch_inventory")&&adjustment.includes("UPDATE products SET stock_qty=?")],
 ['repair intake is branch-bound',guard.includes("p==='/work-orders'")&&guard.includes('req.body.employee_id=req.employee.id')],
 ['existing repair mutations use stored work-order branch',guard.includes("sourceBranch('work_orders',id)")],
 ['repair money routes are forced to work-order branch',guard.includes("assessment-paid|deposit-paid|final-payment")&&guard.includes('req.body.branch_id=branchId')],
 ['repair payment transactions preserve work-order branch fallback',workOrders.includes('branch_id || wo.branch_id || null')],
 ['new rental agreement is branch-bound',guard.includes("p==='/rentals/agreements'")],
 ['rental agreement mutations use stored agreement branch',guard.includes("sourceBranch('rental_agreements',id)")],
 ['rental money/return routes are forced to agreement branch',guard.includes("checkout|collect-balance|return")&&rentals.includes('cash drawer session belongs to a different branch')],
 ['PO physical receipt is restricted to PO receiving branch',guard.includes("purchase-orders\\/(\\d+)\\/receive")&&po.includes('purchase_receipts')],
 ['PO receipt evidence persists branch_id from PO',po.includes('po.branch_id||null')],
 ['write-off creation is branch-bound',guard.includes("p==='/inventory-writeoffs'")],
 ['write-off approval/rejection uses stored write-off branch',guard.includes("sourceBranch('inventory_writeoffs',id)")],
 ['write-off physical stock updates exact branch',writeoffs.includes('UPDATE branch_inventory SET stock_qty=stock_qty-?')&&writeoffs.includes('WHERE product_id=? AND branch_id=?')],
 ['transfer creation requires source-branch authority',guard.includes("p==='/transfers'")&&guard.includes('from_branch_id')],
 ['transfer receipt requires destination-branch authority',guard.includes('SELECT to_branch_id FROM branch_transfers')],
 ['transfer source and destination must differ',transfer.includes('from===to')],
 ['transfer removes source branch stock',transfer.includes('UPDATE branch_inventory SET stock_qty=stock_qty-?')],
 ['transfer serial identity must belong to source branch',transfer.includes("branch_id=? AND status='available'")&&transfer.includes('Serial')],
 ['transfer serial identity moves to destination branch on receipt',transfer.includes("UPDATE inventory_serials SET branch_id=?,bin_id=?,status='available'")],
 ['transfer valuation is reserved and received explicitly',transfer.includes('reserveTransferValuation')&&transfer.includes('receiveTransferValuation')],
 ['automatic accounting journals preserve branch identity',accounting.includes('branch_id,source_type,source_id')&&accounting.includes('branchId||null')],
 ['drawer opening enforces employee default branch unless manager',drawers.includes('default_branch_id')&&drawers.includes('This drawer belongs to another branch')],
 ['drawer reconciliation remains tied to owning cashier or manager',drawers.includes('Only the owning cashier or a drawer manager can reconcile this session')]
];
let failed=0;for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Multi-branch integrity: ${name}`);if(!ok)failed++;}
if(failed){console.error(`Multi-branch integrity certification FAILED (${failed}/${checks.length} failed).`);process.exit(1);}console.log(`Multi-branch mutation integrity certification OK (${checks.length} checks).`);
