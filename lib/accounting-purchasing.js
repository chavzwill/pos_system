const { db } = require('../database');
const { postSourceJournal } = require('./accounting-posting');

async function exists(table){
  const { rows:[r] } = await db.execute({ sql:"SELECT name FROM sqlite_master WHERE type='table' AND name=?", args:[table] });
  return !!r;
}
function money(v){ const n=Number(v); return Number.isFinite(n)?Number(n.toFixed(2)):0; }

async function syncLandedCosts({actorId,stats}){
  stats.landed_cost_allocations ||= {posted:0,existing:0};
  if(!(await exists('landed_cost_allocations'))||!(await exists('landed_cost_allocation_items')))return;
  const {rows:allocations}=await db.execute({sql:`SELECT lca.*,si.invoice_number FROM landed_cost_allocations lca JOIN supplier_invoices si ON si.id=lca.supplier_invoice_id ORDER BY lca.id`,args:[]});
  for(const allocation of allocations){
    try{
      const {rows:items}=await db.execute({sql:'SELECT * FROM landed_cost_allocation_items WHERE allocation_id=? ORDER BY id',args:[allocation.id]});
      if(!items.length){stats.evidence_gaps.push({allocation_id:allocation.id,allocation_number:allocation.allocation_number,type:'landed_cost_allocation_lines_missing',automatic_posting:false});continue;}
      const recorded=money(allocation.capitalizable_amount),allocated=money(items.reduce((s,x)=>s+Number(x.allocated_amount||0),0));
      let invalid=false;
      for(const x of items){
        const qty=Number(x.quantity_received),orig=money(x.original_unit_cost),amount=money(x.allocated_amount),per=money(x.landed_cost_per_unit),adjusted=money(x.adjusted_unit_cost);
        if(!Number.isFinite(qty)||qty<=0||amount<0||Math.abs(per-money(amount/qty))>0.01||Math.abs(adjusted-money(orig+per))>0.01){invalid=true;break;}
      }
      if(invalid||recorded<=0||Math.abs(recorded-allocated)>0.01){stats.reconciliation_issues.push({allocation_id:allocation.id,allocation_number:allocation.allocation_number,type:'landed_cost_allocation_value_mismatch',capitalizable_amount:recorded,allocated_amount:allocated,invalid_line_evidence:invalid});continue;}
      const j=await postSourceJournal({sourceType:'landed_cost_allocation',sourceId:allocation.id,sourceReference:allocation.allocation_number,entryDate:String(allocation.allocated_at||new Date().toISOString()).slice(0,10),description:`Allocate landed costs ${allocation.allocation_number} into received inventory`,branchId:allocation.branch_id,actorId,lines:[{code:'1200',debit:recorded,credit:0,description:'Capitalize allocated freight, duty and other landed costs into inventory'},{code:'1260',debit:0,credit:recorded,description:'Clear landed cost allocation clearing'}]});
      stats.landed_cost_allocations[j.existing?'existing':'posted']++;
    }catch(e){stats.errors.push(`landed_cost_allocation:${allocation.id}: ${e.message}`);}
  }
}

async function syncPurchasingAccounting({ actorId, stats }){
  stats.purchase_receipts ||= { posted:0, existing:0 };
  stats.landed_cost_allocations ||= { posted:0, existing:0 };
  if(!(await exists('purchase_orders')) || !(await exists('purchase_order_items'))) return;

  if(!(await exists('purchase_receipts')) || !(await exists('purchase_receipt_items'))){
    const { rows:[legacy] } = await db.execute({sql:`SELECT COUNT(*) count, COALESCE(SUM(quantity_received),0) units FROM purchase_order_items WHERE COALESCE(quantity_received,0)>0`, args:[]});
    if(Number(legacy?.count||0)>0)stats.evidence_gaps.push({type:'purchase_receipt_event_ledger_missing',affected_lines:Number(legacy.count||0),received_units:Number(legacy.units||0),automatic_posting:false,reason:'Inventory was received before the auditable purchase-receipt event ledger existed. Accounting will not reconstruct receipt timing or value from current cumulative quantities.'});
    return;
  }

  const { rows:receipts } = await db.execute({sql:`SELECT pr.*,po.po_number,po.status po_status FROM purchase_receipts pr JOIN purchase_orders po ON po.id=pr.po_id ORDER BY pr.id`, args:[]});
  for(const receipt of receipts){
    try{
      const { rows:items } = await db.execute({sql:`SELECT pri.*,COALESCE(pri.product_id,poi.product_id) resolved_product_id FROM purchase_receipt_items pri LEFT JOIN purchase_order_items poi ON poi.id=pri.po_item_id WHERE pri.receipt_id=? ORDER BY pri.id`, args:[receipt.id]});
      if(!items.length){stats.evidence_gaps.push({receipt_id:receipt.id,receipt_number:receipt.receipt_number,type:'purchase_receipt_lines_missing',automatic_posting:false});continue;}
      const unresolved=items.filter(x=>!x.resolved_product_id);
      if(unresolved.length){stats.evidence_gaps.push({receipt_id:receipt.id,receipt_number:receipt.receipt_number,type:'purchase_receipt_product_link_missing',unresolved_lines:unresolved.length,automatic_posting:false,reason:'One or more received PO lines are not linked to a catalog product, so Accounting will not classify their value as Inventory yet.'});continue;}
      let calculated=0,invalidCost=0;
      for(const item of items){const qty=Number(item.quantity_received||0),unit=Number(item.unit_cost);if(!Number.isFinite(unit)||unit<0||!Number.isFinite(qty)||qty<=0){invalidCost++;continue;}calculated+=qty*unit;}
      calculated=money(calculated);const recorded=money(receipt.total_cost);
      if(invalidCost||Math.abs(calculated-recorded)>0.01){stats.reconciliation_issues.push({receipt_id:receipt.id,receipt_number:receipt.receipt_number,type:'purchase_receipt_value_mismatch',recorded_total:recorded,calculated_total:calculated,invalid_cost_lines:invalidCost});continue;}
      if(recorded<=0)continue;
      const j=await postSourceJournal({sourceType:'purchase_receipt',sourceId:receipt.id,sourceReference:receipt.receipt_number,entryDate:String(receipt.received_at||new Date().toISOString()).slice(0,10),description:`Inventory received ${receipt.receipt_number} against ${receipt.po_number}`,branchId:receipt.branch_id,actorId,lines:[{code:'1200',debit:recorded,credit:0,description:'Inventory received at preserved PO cost'},{code:'1250',debit:0,credit:recorded,description:'Purchasing/receiving clearing'}]});
      stats.purchase_receipts[j.existing?'existing':'posted']++;
    }catch(e){stats.errors.push(`purchase_receipt:${receipt.id}: ${e.message}`);}
  }

  if(await exists('supplier_invoices')){
    const {rows:invoiceCols}=await db.execute({sql:'PRAGMA table_info(supplier_invoices)',args:[]});
    const cols=new Set(invoiceCols.map(c=>String(c.name)));
    const optional=(name)=>cols.has(name)?name:`0 AS ${name}`;
    const treatment=cols.has('tax_treatment')?'tax_treatment':'NULL AS tax_treatment';
    const {rows:invoices}=await db.execute({sql:`SELECT id,invoice_number,purchase_order_id,subtotal,tax_amount,total,${optional('freight_amount')},${optional('duty_amount')},${optional('other_landed_cost_amount')},${treatment} FROM supplier_invoices WHERE status!='void' ORDER BY id`,args:[]});
    const hasAlloc=await exists('landed_cost_allocations');
    for(const inv of invoices){
      const tax=money(inv.tax_amount),tt=String(inv.tax_treatment||'').toLowerCase();
      if(tax>0&&!['recoverable','landed_cost','expense'].includes(tt))stats.evidence_gaps.push({supplier_invoice_id:inv.id,invoice_number:inv.invoice_number,type:'supplier_tax_treatment_unclassified',tax_amount:tax,automatic_posting:false,reason:'Supplier tax exists but its accounting treatment is not evidenced. Mark it recoverable, landed_cost, or expense before Accounting posts the invoice.'});
      const baseLanded=money(money(inv.freight_amount)+money(inv.duty_amount)+money(inv.other_landed_cost_amount));
      const landed=money(baseLanded+(tt==='landed_cost'?tax:0));
      if(landed>0){
        let allocated=false;
        if(hasAlloc){const {rows:[r]}=await db.execute({sql:'SELECT id FROM landed_cost_allocations WHERE supplier_invoice_id=?',args:[inv.id]});allocated=!!r;}
        if(!allocated)stats.evidence_gaps.push({supplier_invoice_id:inv.id,invoice_number:inv.invoice_number,purchase_order_id:inv.purchase_order_id,type:'landed_cost_allocation_pending',amount:landed,automatic_inventory_allocation:false,reason:'Capitalizable supplier charges remain in Landed Cost Allocation Clearing until an auditable receipt-line allocation is approved.'});
      }
      const components=money(money(inv.subtotal)+tax+baseLanded);
      if(Math.abs(components-money(inv.total))>0.01)stats.reconciliation_issues.push({supplier_invoice_id:inv.id,invoice_number:inv.invoice_number,type:'supplier_invoice_component_mismatch',component_total:components,recorded_total:money(inv.total)});
    }
    const { rows:closedPos } = await db.execute({sql:`SELECT po.id,po.po_number,COALESCE((SELECT SUM(pr.total_cost) FROM purchase_receipts pr WHERE pr.po_id=po.id),0) received_value,COALESCE((SELECT SUM(si.subtotal) FROM supplier_invoices si WHERE si.purchase_order_id=po.id AND si.status!='void'),0) invoiced_subtotal,(SELECT COUNT(*) FROM supplier_invoices si WHERE si.purchase_order_id=po.id AND si.status!='void') invoice_count FROM purchase_orders po WHERE po.status='received' AND EXISTS(SELECT 1 FROM purchase_receipts pr WHERE pr.po_id=po.id) ORDER BY po.id`,args:[]});
    for(const po of closedPos){const received=money(po.received_value),invoiced=money(po.invoiced_subtotal);if(Number(po.invoice_count||0)>0&&Math.abs(received-invoiced)>0.01)stats.reconciliation_issues.push({purchase_order_id:po.id,po_number:po.po_number,type:'po_receipt_invoice_value_mismatch',received_inventory_value:received,invoiced_merchandise_subtotal:invoiced,reason:'Only merchandise subtotal is reconciled to receipt value. Supplier tax and landed-cost components are classified separately.'});}
  }

  const { rows:legacy } = await db.execute({sql:`SELECT po.id,po.po_number,COUNT(*) affected_lines,COALESCE(SUM(poi.quantity_received),0) received_units FROM purchase_orders po JOIN purchase_order_items poi ON poi.po_id=po.id WHERE COALESCE(poi.quantity_received,0)>0 AND NOT EXISTS(SELECT 1 FROM purchase_receipts pr WHERE pr.po_id=po.id) GROUP BY po.id,po.po_number ORDER BY po.id`,args:[]});
  for(const po of legacy)stats.evidence_gaps.push({purchase_order_id:po.id,po_number:po.po_number,type:'legacy_purchase_receipt_without_event_evidence',affected_lines:Number(po.affected_lines||0),received_units:Number(po.received_units||0),automatic_posting:false,reason:'This PO contains received quantities but no immutable receipt event because it predates purchase-receipt evidence capture.'});

  await syncLandedCosts({actorId,stats});
}

module.exports={syncPurchasingAccounting};
