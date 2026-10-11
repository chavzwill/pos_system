'use strict';
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

const server=read('server.js');
const rentals=read('routes/rentals.js');
const purchaseOrders=read('routes/purchase-orders.js');
const customerGuard=read('routes/customer-workflow-hardening.js');

const checks=[];
const check=(name,pass)=>checks.push({name,pass:!!pass});

const readyAt=server.indexOf("app.use(async (req,res,next)=>{try{await ensureReady()");
const uploadStaticAt=server.indexOf("app.use('/uploads', express.static");
const api404At=server.indexOf("app.all('/api/*'");
const spaAt=server.indexOf("app.get('*'");

check('generic upload static serving occurs only after database readiness',readyAt>=0&&uploadStaticAt>readyAt);
check('PO attachments are blocked from direct static access',
  server.includes("'/uploads/po-attachments'")&&server.includes("'/uploads/rental-po-attachments'"));
check('legacy customer ID scans require an authenticated session',
  server.includes("'/uploads/customer-ids'")&&server.includes("sessionAuth"));
check('rental signatures require an authenticated session',
  server.includes("'/uploads/rental-signatures'")&&server.includes("sessionAuth"));
check('public product/branding uploads remain reachable through controlled generic static serving',
  server.includes("app.use('/uploads', express.static"));
check('purchase-order attachment API is purchasing-authorized',
  purchaseOrders.includes("router.use(requirePermission('purchasing'))")&&
  purchaseOrders.includes("router.get('/:id/attachments/:aid/download'"));
check('rental PO attachment API download requires rental or POS authority',
  rentals.includes("router.get('/agreements/:id/po-attachment/download', requireAnyPermission('rentals_checkout', 'pos')"));
check('new customer identity scans are stored outside the public upload tree',
  customerGuard.includes('../protected_uploads/customer-ids')&&customerGuard.includes('PROTECTED_ID_DIR'));
check('unknown API routes return JSON 404 before the SPA catch-all',
  api404At>=0&&spaAt>api404At&&server.includes('API endpoint not found:'));

for(const c of checks) console.log(`${c.pass?'PASS':'FAIL'} Upload security: ${c.name}`);
if(checks.some(c=>!c.pass)) process.exit(1);
console.log(`Upload/API boundary contract OK (${checks.length} checks).`);
