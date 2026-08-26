'use strict';
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const route=read('routes/inventory-writeoffs.js');
const statusRoute=read('routes/inventory-stock-status.js');
const perms=read('lib/permissions.js');
const checks=[
  ['write-off route is mounted under inventory controls',statusRoute.includes("router.use('/writeoffs', require('./inventory-writeoffs'))")],
  ['create and approve permissions are segregated',perms.includes("inventory_writeoff_create")&&perms.includes("inventory_writeoff_approve")],
  ['write-offs require coded reason and detail',route.includes('A valid write-off reason code is required')&&route.includes('Write-off reason detail is required')],
  ['bin-controlled stock requires exact bin evidence',route.includes('select the exact bin being written off')&&route.includes('Exact-bin quantity changed')],
  ['approval is independent by default',route.includes('inventory_writeoff_allow_self_approval')&&route.includes('Independent approval is required for inventory write-offs')],
  ['approval rechecks live physical stock',route.includes('Branch inventory changed and no longer contains enough stock')],
  ['restricted-status stock is reconciled on approval',route.includes('inventory_stock_status_balances')&&route.includes("'written_off'")],
  ['physical branch and global stock move atomically',route.includes('UPDATE branch_inventory SET stock_qty=stock_qty-?')&&route.includes('UPDATE products SET stock_qty=(SELECT COALESCE(SUM(stock_qty),0)')],
  ['write-off creates stock movement evidence',route.includes("'writeoff'")&&route.includes('stock_movement_id')],
  ['write-off consumes auditable valuation pool',route.includes('valueStockAdjustment')&&route.includes('inventory_adjustment_valuations')],
  ['unknown legacy cost is not fabricated',route.includes("valuationStatus=(legacyQty+untrackedQty)>0")&&route.includes("'unvalued'")],
  ['tracked inventory loss posts expense and inventory credit',route.includes("code:'5500'")&&route.includes("code:'1200'")],
  ['write-off journal is source-idempotent',route.includes("sourceType:'inventory_writeoff'")],
  ['actor identity comes from authenticated employee',route.includes('req.employee?.id||null')],
  ['write-off events remain append-only audit evidence',route.includes('inventory_writeoff_events')&&route.includes("'submitted'")&&route.includes("'approved'")&&route.includes("'rejected'")]
];
let failed=0;
for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Inventory write-off: ${name}`);if(!ok)failed++;}
if(failed){console.error(`Inventory write-off contract FAILED (${failed}/${checks.length} failed).`);process.exit(1);}
console.log(`Inventory write-off contract OK (${checks.length} checks).`);
