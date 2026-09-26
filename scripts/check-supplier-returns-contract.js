'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const route=read('routes/supplier-returns.js');
const rec=read('routes/supplier-recoverables.js');
const confirmation=read('lib/supplier-recoverable-confirmation.js');
const sync=read('routes/accounting-source-sync.js');
const posting=read('lib/accounting-posting.js');
const server=read('server.js');
const ui=read('public/index.html');
for(const [name,src] of Object.entries({route,rec,confirmation,sync,posting}))new vm.Script(src,{filename:name});
const checks=[
 ['supplier return route mounted',server.includes("app.use('/api/supplier-returns'")],
 ['supplier returns require purchasing authority',route.includes("requireAnyPermission('purchasing','purchasing_receive','purchasing_approve','reports_financial')")],
 ['supplier return schema is durable',route.includes('CREATE TABLE IF NOT EXISTS supplier_returns')&&route.includes('CREATE TABLE IF NOT EXISTS supplier_return_items')&&route.includes('CREATE TABLE IF NOT EXISTS supplier_return_events')],
 ['return identifiers are concurrency safe',route.includes('randomUUID')&&route.includes("return 'SRT-'")],
 ['cold start initializes valuation stock status and recoverables',route.includes('ensureInventoryMovementValuation')&&route.includes('ensureInventoryStockStatus')&&route.includes('ensureSupplierRecoverablesSchema')],
 ['return lifecycle separates draft approve dispatch',route.includes("status TEXT NOT NULL DEFAULT 'draft'")&&route.includes("status='approved'")&&route.includes("status='dispatched'")],
 ['approval requires purchasing approve permission',route.includes("router.post('/:id/approve',requirePermission('purchasing_approve')")],
 ['dispatch requires purchasing receive permission',route.includes("router.post('/:id/dispatch',requirePermission('purchasing_receive')")],
 ['dispatch only accepts approved returns',route.includes("if(row.status!=='approved')throw new Error('Only approved supplier returns can be dispatched')")],
 ['return quantities obey inventory precision rules',route.includes('normalizeInventoryQuantity')&&route.includes("label:'Supplier return quantity'")],
 ['available stock is revalidated before dispatch',route.includes('getAvailableQty(tx,item.product_id,row.branch_id)')],
 ['restricted stock status is explicitly supported',route.includes("source_status TEXT NOT NULL DEFAULT 'available'")&&route.includes('inventory_stock_status_balances')],
 ['restricted status balance is decremented with dispatch',route.includes("UPDATE inventory_stock_status_balances SET quantity=quantity-?")],
 ['optional receipt evidence must match product supplier and branch',route.includes('Receipt evidence for')&&route.includes('pr.supplier_id')&&route.includes('pr.branch_id')],
 ['valuation is removed from inventory cost pool',route.includes('removeFromPool(tx,item.product_id')],
 ['return preserves tracked legacy and untracked valuation composition',route.includes('tracked_quantity')&&route.includes('tracked_value')&&route.includes('legacy_quantity')&&route.includes('untracked_quantity')],
 ['branch stock is reduced atomically',route.includes('UPDATE branch_inventory SET stock_qty=stock_qty-?')],
 ['bin quantity is synchronized with branch stock',route.includes('syncBinQty(tx,item.product_id,row.branch_id,-Number(item.quantity))')],
 ['global product stock is reduced',route.includes("UPDATE products SET stock_qty=MAX(0,stock_qty-?)")],
 ['physical stock movement is supplier-return typed',route.includes("'supplier_return',row.return_number")],
 ['recoverable claim is created only in dispatch path',route.indexOf("claim_type,status,source_type")>route.indexOf("router.post('/:id/dispatch'")],
 ['supplier return creates identified not confirmed claim',route.includes("'supplier_return','identified','supplier_return'")],
 ['claim preserves expected credit and valuation evidence',route.includes('expectedCreditAmount')&&route.includes('inventoryTrackedValue')&&route.includes('legacyQuantity')&&route.includes('untrackedQuantity')],
 ['claim currency comes from branch',route.includes("SELECT currency FROM branches WHERE id=?")],
 ['supplier return UI is available from purchasing',ui.includes("tabBtn('supplier-returns','Supplier Returns')")&&ui.includes('renderSupplierReturns')],
 ['UI exposes draft approve dispatch control',ui.includes('Draft → Approved → Dispatched')&&ui.includes('_approveSupplierReturn')&&ui.includes('_dispatchSupplierReturn')],
 ['UI warns dispatch changes physical stock and creates claim',ui.includes('Physical stock and valuation will leave inventory and an identified supplier recoverable claim will be created')],
 ['UI supports damaged quarantine inspection blocked and expired source stock',ui.includes('<option value="damaged">Damaged</option>')&&ui.includes('<option value="quarantine">Quarantine</option>')&&ui.includes('<option value="inspection">Inspection</option>')&&ui.includes('<option value="blocked">Blocked</option>')&&ui.includes('<option value="expired">Expired</option>')],
 ['chart of accounts has pending supplier-return credit asset',posting.includes("['1160','Supplier Returns Pending Credit','asset','debit']")],
 ['dispatch accounting debits pending credit and credits inventory',sync.includes("sourceType:'supplier_return_dispatch'")&&sync.includes("code:'1160',debit:amount")&&sync.includes("code:'1200',debit:0,credit:amount")],
 ['incomplete carrying value becomes evidence gap not invented posting',sync.includes('supplier_return_inventory_value_incomplete')&&sync.includes('Accounting will not invent the missing inventory value')],
 ['supplier-return confirmation requires exact dispatched return',confirmation.includes('Supplier return accounting basis requires the exact dispatched return')],
 ['supplier-return confirmation preserves operational receivable when accounting is unresolved',confirmation.includes("accountingBasis={status:'unresolved'")&&confirmation.includes('Returned inventory does not have complete auditable carrying-value evidence.')],
 ['supplier confirmed credit mismatch is surfaced rather than invented as variance',confirmation.includes('differs from returned inventory carrying value')],
 ['recoverables UI exposes accounting reconciliation status',ui.includes('Accounting: '+"'+this.escapeHtml(accountingStatus.replaceAll('_',' '))")],
 ['confirmed reconciled supplier return uses supplier_return_clearing basis',confirmation.includes("'supplier_return_clearing'")],
 ['confirmation accounting moves pending credit to Supplier Recoverables',sync.includes("x.basis_type==='supplier_return_clearing'")&&sync.includes("code:'1150',debit:amount")&&sync.includes("code:'1160',debit:0,credit:amount")],
 ['settlement can then use existing AP offset or cash bank refund controls',rec.includes("if(type==='ap_offset')")&&rec.includes("'cash_refund','bank_refund','ap_offset'")]
];
let failed=0;
for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Supplier returns: ${name}`);if(!ok)failed++;}
if(failed){console.error(`Supplier returns contract FAILED (${failed}/${checks.length} failed).`);process.exit(1);}
console.log(`Supplier returns contract OK (${checks.length} checks).`);
