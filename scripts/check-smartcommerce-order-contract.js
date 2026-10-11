'use strict';
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

const route=read('routes/smartcommerce-orders.js');
const apiKey=read('lib/apiKeyAuth.js');
const publisher=read('lib/smartcommerceSyncPublisher.js');
const schema=read('lib/smartcommerceSyncSchema.js');
const server=read('server.js');

const checks=[];
const check=(name,pass)=>checks.push({name,pass:!!pass});

check('SmartCommerce orders are mounted after API-key authentication',
  server.indexOf("app.use('/api', apiKeyAuth)")>=0 &&
  server.indexOf("app.use('/api/smartcommerce-orders'")>server.indexOf("app.use('/api', apiKeyAuth)"));
check('SmartCommerce reads require orders:read scope',
  apiKey.includes("prefix: '/api/smartcommerce-orders', scope: 'orders:read'"));
check('SmartCommerce writes require orders:write scope',
  apiKey.includes("prefix: '/api/smartcommerce-orders', scope: 'orders:write'"));
check('external order id is uniquely constrained',
  route.includes('ux_transactions_external_order_id'));
check('order replay stores a deterministic payload hash',
  route.includes("external_payload_hash TEXT") &&
  route.includes("function stableHash(value)") &&
  route.includes("UPDATE transactions SET external_payload_hash = ? WHERE id = ?"));
check('changed replay payload is rejected',
  route.includes("external_order_id already exists with different order data"));
check('replay response reports whether legacy hash evidence exists',
  route.includes('idempotency_verified'));
check('duplicate product lines are rejected before stock mutation',
  route.includes('Duplicate product_id') && route.includes('seenProducts'));
check('order line count is bounded',
  route.includes('SmartCommerce orders are limited to 200 line items'));
check('branch stock decrement is conditional and transactional',
  route.includes('AND stock_qty >= ?') && route.includes("db.transaction('write')"));
check('SmartCommerce sales write attributable stock movement evidence',
  route.includes("INSERT INTO stock_movements (product_id,branch_id,quantity_change,type,reference,reason)") &&
  route.includes("'SmartCommerce paid order'"));
check('SmartCommerce checkout records transaction items and payment evidence',
  route.includes('INSERT INTO transaction_items') && route.includes('INSERT INTO transaction_payments'));
check('durable sync outbox is drained after successful API mutations',
  server.includes('flushSmartCommerceSyncOutbox') && server.includes("res.on('finish'"));
check('durable sync publisher is HMAC authenticated',
  publisher.includes("crypto.createHmac('sha256'") &&
  publisher.includes('SMARTCOMMERCE_SYNC_URL') &&
  publisher.includes('SMARTCOMMERCE_POS_SYNC_SECRET'));
check('durable sync publisher classifies retry and review states',
  publisher.includes("status='needs_review'") &&
  publisher.includes('backoffSeconds') &&
  publisher.includes('markRetry'));
check('durable sync schema covers catalog, availability, customer and commerce lifecycle',
  ['category.upserted','product.upserted','availability.upserted','customer.upserted','promotion.upserted','rental.upserted','repair.upserted']
    .every(marker=>schema.includes(marker)));

for(const c of checks) console.log(`${c.pass?'PASS':'FAIL'} SmartCommerce: ${c.name}`);
if(checks.some(c=>!c.pass)) process.exit(1);
console.log(`SmartCommerce integration contract OK (${checks.length} checks).`);
