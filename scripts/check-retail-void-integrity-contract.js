'use strict';
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const guard=read('routes/lifecycle-concurrency-guard.js');
const voidRoute=read('routes/transaction-void-hardening.js');
const checks=[
  ['void mutation is lifecycle-serialized',guard.includes("/^\\/transactions\\/(\\d+)\\/void$/")&&guard.includes('transaction:${id}:void')],
  ['void mutation requires operation identity',guard.includes("method==='PATCH'&&/^\\/transactions\\/\\d+\\/void$/.test(req.path)")],
  ['void state change uses compare-and-swap',voidRoute.includes("WHERE id=? AND status='completed'")&&voidRoute.includes("Number(changed.rowsAffected||0)!==1")],
  ['stale concurrent void fails closed',voidRoute.includes('Transaction changed before void commit')&&voidRoute.includes('{status:409}')],
  ['inventory restoration remains inside void transaction',voidRoute.includes('restoreTransactionItemCost(tx')&&voidRoute.includes("'void_restore'"))],
  ['customer commercial rollback remains inside void transaction',voidRoute.includes('UPDATE customers SET loyalty_points=MAX(0,loyalty_points-?)')],
  ['unpaid commission cleanup is atomic with void',voidRoute.includes('await tx.execute({sql:"DELETE FROM commission_records')],
  ['paid commission history is not silently deleted',voidRoute.includes("status!='paid'")&&voidRoute.includes('Paid commission is intentionally preserved')),
  ['commission cleanup is not a swallowed post-commit side effect',!voidRoute.includes("try{await db.execute({sql:\"DELETE FROM commission_records"))],
  ['void preserves rental workflow authority',voidRoute.includes('cancel it through the Rentals workflow')),
  ['void preserves repair workflow authority',voidRoute.includes('reverse it through the repair workflow')),
  ['void rejects transactions with existing return evidence',voidRoute.includes('already has return')&&voidRoute.includes('double-restore inventory')),
];
let failed=0;
for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Retail void integrity: ${name}`);if(!ok)failed++;}
if(failed){console.error(`Retail void integrity contract FAILED (${failed}/${checks.length} failed).`);process.exit(1);}
console.log(`Retail void integrity contract OK (${checks.length} checks).`);
