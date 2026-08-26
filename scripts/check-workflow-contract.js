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
check('Retail cost integrity mounted before legacy transaction route',server.indexOf("require('./routes/retail-cost-integrity')")<server.indexOf("require('./routes/transactions')"));
check('Replacement return hardening mounted before legacy transaction route',server.indexOf("require('./routes/replacement-return-hardening')")<server.indexOf("require('./routes/transactions')"));
check('Quotation hardening mounted before legacy quotation route',server.indexOf("require('./routes/quotation-workflow-hardening')")>=0&&server.indexOf("require('./routes/quotation-workflow-hardening')")<server.indexOf("require('./routes/quotations')"));
check('Quotation sale filter matches persisted retail type',quotes.includes('<option value="retail"')&&!quotes.includes('<option value="sale"'));
for(const c of checks)console.log(`${c.pass?'PASS':'FAIL'} Workflow: ${c.name}`);
if(checks.some(c=>!c.pass))process.exit(1);
console.log(`Workflow contract OK (${checks.length} checks across ${workflows.length} workflows).`);
