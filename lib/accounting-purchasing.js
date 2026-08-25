const { db } = require('../database');
const { postSourceJournal } = require('./accounting-posting');

async function exists(table){
  const { rows:[r] } = await db.execute({ sql:"SELECT name FROM sqlite_master WHERE type='table' AND name=?", args:[table] });
  return !!r;
}
function money(v){ const n=Number(v); return Number.isFinite(n)?Number(n.toFixed(2)):0; }

async function syncPurchasingAccounting({ actorId, stats }){
  stats.purchase_receipts ||= { posted:0, existing:0 };
  if(!(await exists('purchase_orders')) || !(await exists('purchase_order_items'))) return;

  if(!(await exists('purchase_receipts')) || !(await exists('purchase_receipt_items'))){
    const { rows:[legacy] } = await db.execute({
      sql:`SELECT COUNT(*) count, COALESCE(SUM(quantity_received),0) units
           FROM purchase_order_items WHERE COALESCE(quantity_received,0)>0`, args:[]
    });
    if(Number(legacy?.count||0)>0){
      stats.evidence_gaps.push({
        type:'purchase_receipt_event_ledger_missing',
        affected_lines:Number(legacy.count||0),
        received_units:Number(legacy.units||0),
        automatic_posting:false,
        reason:'Inventory was received before the auditable purchase-receipt event ledger existed. Accounting will not reconstruct receipt timing or value from current cumulative quantities.'
      });
    }
    return;
  }

  const { rows:receipts } = await db.execute({
    sql:`SELECT pr.*,po.po_number,po.status po_status
         FROM purchase_receipts pr JOIN purchase_orders po ON po.id=pr.po_id
         ORDER BY pr.id`, args:[]
  });

  for(const receipt of receipts){
    try{
      const { rows:items } = await db.execute({
        sql:`SELECT pri.*,COALESCE(pri.product_id,poi.product_id) resolved_product_id
             FROM purchase_receipt_items pri
             LEFT JOIN purchase_order_items poi ON poi.id=pri.po_item_id
             WHERE pri.receipt_id=? ORDER BY pri.id`, args:[receipt.id]
      });
      if(!items.length){
        stats.evidence_gaps.push({receipt_id:receipt.id,receipt_number:receipt.receipt_number,type:'purchase_receipt_lines_missing',automatic_posting:false});
        continue;
      }
      const unresolved=items.filter(x=>!x.resolved_product_id);
      if(unresolved.length){
        stats.evidence_gaps.push({
          receipt_id:receipt.id,receipt_number:receipt.receipt_number,type:'purchase_receipt_product_link_missing',
          unresolved_lines:unresolved.length,automatic_posting:false,
          reason:'One or more received PO lines are not linked to a catalog product, so Accounting will not classify their value as Inventory yet.'
        });
        continue;
      }
      let calculated=0;
      let invalidCost=0;
      for(const item of items){
        const qty=Number(item.quantity_received||0), unit=Number(item.unit_cost);
        if(!Number.isFinite(unit)||unit<0||!Number.isFinite(qty)||qty<=0){ invalidCost++; continue; }
        calculated += qty*unit;
      }
      calculated=money(calculated);
      const recorded=money(receipt.total_cost);
      if(invalidCost || Math.abs(calculated-recorded)>0.01){
        stats.reconciliation_issues.push({
          receipt_id:receipt.id,receipt_number:receipt.receipt_number,type:'purchase_receipt_value_mismatch',
          recorded_total:recorded,calculated_total:calculated,invalid_cost_lines:invalidCost
        });
        continue;
      }
      if(recorded<=0) continue;
      const j=await postSourceJournal({
        sourceType:'purchase_receipt',sourceId:receipt.id,sourceReference:receipt.receipt_number,
        entryDate:String(receipt.received_at||new Date().toISOString()).slice(0,10),
        description:`Inventory received ${receipt.receipt_number} against ${receipt.po_number}`,
        branchId:receipt.branch_id,actorId,
        lines:[
          {code:'1200',debit:recorded,credit:0,description:'Inventory received at preserved PO cost'},
          {code:'1250',debit:0,credit:recorded,description:'Purchasing/receiving clearing'}
        ]
      });
      stats.purchase_receipts[j.existing?'existing':'posted']++;
    }catch(e){ stats.errors.push(`purchase_receipt:${receipt.id}: ${e.message}`); }
  }

  if(await exists('supplier_invoices')){
    const { rows:closedPos } = await db.execute({
      sql:`SELECT po.id,po.po_number,
          COALESCE((SELECT SUM(pr.total_cost) FROM purchase_receipts pr WHERE pr.po_id=po.id),0) received_value,
          COALESCE((SELECT SUM(si.subtotal) FROM supplier_invoices si WHERE si.purchase_order_id=po.id AND si.status!='void'),0) invoiced_subtotal,
          (SELECT COUNT(*) FROM supplier_invoices si WHERE si.purchase_order_id=po.id AND si.status!='void') invoice_count
        FROM purchase_orders po
        WHERE po.status='received' AND EXISTS(SELECT 1 FROM purchase_receipts pr WHERE pr.po_id=po.id)
        ORDER BY po.id`, args:[]
    });
    for(const po of closedPos){
      const received=money(po.received_value), invoiced=money(po.invoiced_subtotal);
      if(Number(po.invoice_count||0)>0 && Math.abs(received-invoiced)>0.01){
        stats.reconciliation_issues.push({
          purchase_order_id:po.id,po_number:po.po_number,type:'po_receipt_invoice_value_mismatch',
          received_inventory_value:received,invoiced_subtotal:invoiced
        });
      }
    }
  }

  const { rows:legacy } = await db.execute({
    sql:`SELECT po.id,po.po_number,COUNT(*) affected_lines,COALESCE(SUM(poi.quantity_received),0) received_units
         FROM purchase_orders po JOIN purchase_order_items poi ON poi.po_id=po.id
         WHERE COALESCE(poi.quantity_received,0)>0
           AND NOT EXISTS(SELECT 1 FROM purchase_receipts pr WHERE pr.po_id=po.id)
         GROUP BY po.id,po.po_number ORDER BY po.id`, args:[]
  });
  for(const po of legacy){
    stats.evidence_gaps.push({
      purchase_order_id:po.id,po_number:po.po_number,type:'legacy_purchase_receipt_without_event_evidence',
      affected_lines:Number(po.affected_lines||0),received_units:Number(po.received_units||0),automatic_posting:false,
      reason:'This PO contains received quantities but no immutable receipt event because it predates purchase-receipt evidence capture.'
    });
  }
}

module.exports={syncPurchasingAccounting};
