'use strict';
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const exists=p=>fs.existsSync(path.join(root,p));
const server=read('server.js');
const loader=read('public/workspace-loader-hardening.js');
const guide=read('public/guided-mode-exact-fallback.js');
const deferred=read('public/shell-deferred.js');
const quotes=read('public/quotations-workspace.js');
const recall=read('routes/held-sale-recall-hardening.js');
const checkout=read('routes/retail-checkout-hardening.js');
const drawer=read('routes/drawer-session-hardening.js');
const customer=read('routes/customer-workflow-hardening.js');
const account=read('routes/customer-account-integrity.js');
const retailReturn=read('routes/retail-return-hardening.js');
const refund=read('routes/retail-refund-settlement.js');
const retailCost=read('routes/retail-cost-integrity.js');
const returnAccounting=read('lib/accounting-retail-returns.js');
const checks=[];
const check=(name,pass)=>checks.push({name,pass:!!pass});
const workflows=[
 {name:'Retail sale',route:'/api/transactions',routeFile:'routes/transactions.js',workspace:'sales-workspace',global:'TotalToolsSalesWorkspace',guide:'Complete a sale'},
 {name:'Hold / recall',route:'/api/held-sales',routeFile:'routes/held-sales.js',workspace:'held-sales-workspace',global:'TotalToolsHeldSalesWorkspace',guide:'Hold or recall a sale'},
 {name:'Return / refund',route:'/api/transactions',routeFile:'routes/retail-cost-integrity.js',workspace:'cashier-controls-workspace',global:'TotalToolsCashierControls',guide:'Return or refund a transaction'},
 {name:'Cash drawer',route:'/api/drawers',routeFile:'routes/drawers.js',workspace:null,global:null,guide:'Open or close a cash drawer'},
 {name:'Repair',route:'/api/work-orders',routeFile:'routes/work-orders.js',workspace:'work-orders-workspace',global:'TotalToolsWorkOrdersWorkspace',guide:'Create or work a repair'},
 {name:'Rental',route:'/api/rentals',routeFile:'routes/rentals.js',workspace:'rentals-workspace',global:'TotalToolsRentalsWorkspace',guide:'Create or manage a rental'},
 {name:'Dispatch',route:'/api/logistics-intelligence',routeFile:'routes/logistics-intelligence.js',workspace:'logistics-intelligence',global:'TotalToolsLogisticsIntelligence',guide:'Dispatch, route or complete a delivery'},
 {name:'Inventory adjustment',route:'/api/products',routeFile:'routes/products.js',workspace:'inventory-workspace',global:'TotalToolsInventoryWorkspace',guide:'Adjust inventory'},
 {name:'Cycle count',route:'/api/warehouse',routeFile:'routes/warehouse.js',workspace:null,global:null,guide:'Run a stock or cycle count'},
 {name:'Purchase request',route:'/api/purchase-requests',routeFile:'routes/purchase-requests.js',workspace:'purchasing-workspace',global:'TotalToolsPurchasingWorkspace',guide:'Create or approve a purchase request'},
 {name:'Purchase order',route:'/api/purchase-orders',routeFile:'routes/purchase-orders.js',workspace:'purchasing-workspace',global:'TotalToolsPurchasingWorkspace',guide:'Create, edit, copy, cancel or receive a PO'},
 {name:'Branch transfer',route:'/api/transfers',routeFile:'routes/transfers.js',workspace:'transfers-workspace',global:'TotalToolsTransfersWorkspace',guide:'Create, dispatch or receive a branch transfer'},
 {name:'Quotation',route:'/api/quotations',routeFile:'routes/quotations.js',workspace:'quotations-workspace',global:'TotalToolsQuotationsWorkspace',guide:'Create or manage a quotation'},
 {name:'Operational report',route:'/api/operational-reports',routeFile:'routes/operational-reports.js',workspace:'operational-reports',global:'TotalToolsOperationalReports',guide:'Run, export or print a report'},
 {name:'Technician compensation',route:'/api/technician-compensation',routeFile:'routes/technician-compensation.js',workspace:null,global:null,guide:'Review technician compensation'},
 {name:'ERP / inventory intelligence',route:'/api/erp-intelligence',routeFile:'routes/erp-intelligence.js',workspace:'inventory-intelligence',global:'TotalToolsInventoryIntelligence',guide:'Use ERP / inventory intelligence'}
];
for(const w of workflows){
 check(`${w.name}: route file exists`,exists(w.routeFile));
 check(`${w.name}: route mounted`,server.includes(`app.use('${w.route}'`)||server.includes(`app.use(\"${w.route}\"`));
 check(`${w.name}: Guided Mode task covered`,guide.includes(`'${w.guide}'`));
 if(w.workspace){
   check(`${w.name}: workspace registered`,loader.includes(`'${w.workspace}'`));
   check(`${w.name}: workspace global registered`,loader.includes(w.global));
 }
}
check('PO document context route mounted before normal PO router',server.indexOf("require('./routes/purchase-order-document-context')")>=0&&server.indexOf("require('./routes/purchase-order-document-context')")<server.indexOf("require('./routes/purchase-order-hardening')"));
check('PO hardening mounted before legacy PO route',server.indexOf("require('./routes/purchase-order-hardening')")<server.indexOf("require('./routes/purchase-orders')"));
check('Held-sale recall hardening mounted before transaction engine',server.indexOf("require('./routes/held-sale-recall-hardening')")>=0&&server.indexOf("require('./routes/held-sale-recall-hardening')")<server.indexOf("require('./routes/transactions')"));
check('Held-sale recall context is served by fast shell',deferred.includes("'/held-sales-recall-context.js'"));
check('Held-sale recall uses unique replay evidence',recall.includes('held_transaction_id INTEGER NOT NULL UNIQUE')&&recall.includes('completed_transaction_id INTEGER NOT NULL UNIQUE'));
check('Held-sale creation replaces browser price/tax with catalog evidence',recall.includes('unit_price: Number(product.price || 0)')&&recall.includes('tax_rate: Number(product.tax_rate || 0)'));
check('Retail checkout hardening mounted before transaction engine',server.indexOf("require('./routes/retail-checkout-hardening')")>=0&&server.indexOf("require('./routes/retail-checkout-hardening')")<server.indexOf("require('./routes/transactions')"));
check('Retail checkout requires selling branch for in-store sale',checkout.includes('A selling branch is required for a POS transaction'));
check('Retail checkout rejects overselling branch inventory',checkout.includes('state.available < qty')&&checkout.includes('selected branch'));
check('Retail checkout requires customer for charge account',checkout.includes('Charge Account requires a customer'));
check('Retail checkout enforces customer credit limit',checkout.includes('Sale would exceed the customer credit limit'));
check('Retail checkout validates store-credit balance',checkout.includes('Store credit exceeds the customer’s available balance'));
check('Retail checkout validates card and transfer references',checkout.includes('payment requires an approval/reference code'));
check('Retail checkout binds employee to authenticated cashier',checkout.includes('body.employee_id = req.employee.id'));
check('Retail checkout binds configured branch to open cashier drawer',checkout.includes('Open your cash drawer before completing an in-store sale')&&checkout.includes('body.drawer_session_id=activeSession.id'));
check('Drawer hardening mounted before legacy drawer route',server.indexOf("require('./routes/drawer-session-hardening')")>=0&&server.indexOf("require('./routes/drawer-session-hardening')")<server.indexOf("require('./routes/drawers')"));
check('Drawer opening derives employee and branch from evidence',drawer.includes('req.body.employee_id=emp.id')&&drawer.includes('req.body.branch_id=drawer.branch_id'));
check('Drawer close protects session ownership',drawer.includes('Only the cashier who opened this drawer or a drawer manager can close it'));
check('Drawer reconciliation protects counted values and reconciler identity',drawer.includes('Denomination quantities must be non-negative whole numbers')&&drawer.includes('req.body.reconciled_by=emp.id'));
check('Customer workflow hardening mounted before legacy customers route',server.indexOf("require('./routes/customer-workflow-hardening')")>=0&&server.indexOf("require('./routes/customer-workflow-hardening')")<server.indexOf("require('./routes/customers')"));
check('Customer creation detects duplicate active contact evidence',customer.includes('duplicate')&&customer.includes('active'));
check('Customer account integrity mounted before legacy accounts route',server.indexOf("require('./routes/customer-account-integrity')")>=0&&server.indexOf("require('./routes/customer-account-integrity')")<server.indexOf("require('./routes/accounts')"));
check('Credit notes create auditable account adjustments',account.includes('trg_credit_note_account_adjustment')&&account.includes('customer_account_adjustments'));
check('AR invoice balances include credit-note adjustments',account.includes('credit_adjustments')&&account.includes('balance_due'));
check('Account payments cannot erase store credit',account.includes('This customer has store credit and no receivable balance to pay'));
check('Account payments cannot exceed adjusted invoice balances',account.includes('Allocation exceeds adjusted balance'));
check('Retail return hardening is integrated before legacy return handler',retailCost.includes("router.use(require('./retail-return-hardening'))"));
check('Retail returns require whole-number quantities',retailReturn.includes('Return quantities must be positive whole numbers'));
check('Charge-account returns cannot bypass AR using refund resolution',retailReturn.includes('Charge-account sales must be returned as a credit note'));
check('Refund settlement route mounted before transaction engine',server.indexOf("require('./routes/retail-refund-settlement')")>=0&&server.indexOf("require('./routes/retail-refund-settlement')")<server.indexOf("require('./routes/transactions')"));
check('Refund settlement is idempotent per return',refund.includes('return_id INTEGER NOT NULL UNIQUE'));
check('Refund settlement binds settling employee from authenticated session',refund.includes('req.employee?.id||null'));
check('Refund settlement is capped by original tender evidence',refund.includes('originalTenderAvailability')&&refund.includes('exceeds the remaining amount originally tendered'));
check('Refund settlement blocks charge-account cash refunds',refund.includes('Charge-account transactions must be reversed through a credit note'));
check('Refund settlement accounting clears customer refunds payable',returnAccounting.includes("code:'2400',debit:settlementTotal")&&returnAccounting.includes("sourceType:'retail_refund_settlement'"));
check('Refund settlement accounting distinguishes cash bank and electronic clearing',returnAccounting.includes("if(m==='cash')return '1000'")&&returnAccounting.includes("if(m==='bank_transfer'||m==='check')return '1010'")&&returnAccounting.includes("if(m==='card')return '1050'"));
check('Refund settlement accounting validates settlement against return and tender legs',returnAccounting.includes('refund_settlement_return_mismatch')&&returnAccounting.includes('refund_settlement_leg_mismatch'));
check('Retail cost integrity mounted before legacy transaction route',server.indexOf("require('./routes/retail-cost-integrity')")<server.indexOf("require('./routes/transactions')"));
check('Replacement return hardening mounted before legacy transaction route',server.indexOf("require('./routes/replacement-return-hardening')")<server.indexOf("require('./routes/transactions')"));
check('Quotation hardening mounted before legacy quotation route',server.indexOf("require('./routes/quotation-workflow-hardening')")>=0&&server.indexOf("require('./routes/quotation-workflow-hardening')")<server.indexOf("require('./routes/quotations')"));
check('Quotation sale filter matches persisted retail type',quotes.includes('<option value="retail"')&&!quotes.includes('<option value="sale"'));
for(const c of checks)console.log(`${c.pass?'PASS':'FAIL'} Workflow: ${c.name}`);
if(checks.some(c=>!c.pass))process.exit(1);
console.log(`Workflow contract OK (${checks.length} checks across ${workflows.length} workflows).`);
