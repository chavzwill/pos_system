'use strict';
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

const server=read('server.js');
const rentals=read('routes/rentals.js');
const purchaseOrders=read('routes/purchase-orders.js');

const checks=[];
const check=(name,pass)=>checks.push({name,pass:!!pass});

check('purchase-order attachments are blocked from direct static access',
  server.includes("'/uploads/po-attachments'") && server.includes("'/uploads/rental-po-attachments'"));
check('legacy customer IDs require an authenticated session',
  server.includes("'/uploads/customer-ids'") && server.includes('sessionAuth'));
check('rental signatures require an authenticated session',
  server.includes("'/uploads/rental-signatures'") && server.includes('sessionAuth'));
check('public upload mount remains available after sensitive-path guards',
  server.indexOf("app.use('/uploads', express.static") > server.indexOf("'/uploads/rental-signatures'"));
check('unknown API routes return JSON 404 before the SPA fallback',
  server.includes('API endpoint not found:') &&
  server.indexOf('API endpoint not found:') < server.indexOf("app.get('*'"));
check('purchase-order attachment routes inherit purchasing permission',
  purchaseOrders.includes("router.use(requirePermission('purchasing'))") &&
  purchaseOrders.includes("router.get('/:id/attachments/:aid/download'"));
check('rental PO attachment download requires rentals checkout or POS authority',
  rentals.includes("router.get('/agreements/:id/po-attachment/download', requireAnyPermission('rentals_checkout', 'pos')"));

for(const c of checks) console.log(`${c.pass?'PASS':'FAIL'} Private files: ${c.name}`);
if(checks.some(c=>!c.pass)) process.exit(1);
console.log(`Private upload/API fallback contract OK (${checks.length} checks).`);
