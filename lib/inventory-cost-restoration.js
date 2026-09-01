const { db } = require('../database');
const { ensureInventoryCostLayers } = require('./inventory-cost-layers');

let readyPromise = null;
function qty4(v){ const n=Number(v); return Number.isFinite(n)?Number(n.toFixed(4)):0; }
function money4(v){ const n=Number(v); return Number.isFinite(n)?Number(n.toFixed(4)):0; }

async function ensureInventoryCostRestoration(){
  if(readyPromise) return readyPromise;
  readyPromise=(async()=>{
    await ensureInventoryCostLayers();
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS inventory_cost_restorations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        transaction_item_id INTEGER NOT NULL REFERENCES transaction_items(id),
        product_id INTEGER NOT NULL REFERENCES products(id),
        branch_key INTEGER NOT NULL DEFAULT 0,
        quantity REAL NOT NULL,
        tracked_quantity REAL NOT NULL DEFAULT 0,
        tracked_value REAL NOT NULL DEFAULT 0,
        legacy_quantity REAL NOT NULL DEFAULT 0,
        untracked_quantity REAL NOT NULL DEFAULT 0,
        unit_cost_reference REAL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(source_type,source_id,transaction_item_id)
      )`},
      {sql:'CREATE INDEX IF NOT EXISTS idx_inventory_cost_restorations_item ON inventory_cost_restorations(transaction_item_id,created_at)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_inventory_cost_restorations_product_branch ON inventory_cost_restorations(product_id,branch_key,created_at)'}
    ],'write');

    // Refund and credit-note returns put merchandise back into sellable stock.
    // Restore the same tracked-vs-legacy cost composition that left the pool on
    // the original sale. Replacement returns are quarantined and deliberately
    // excluded because they are not restored to sellable inventory.
    await db.execute({sql:`CREATE TRIGGER IF NOT EXISTS trg_inventory_cost_return_restore
      AFTER INSERT ON return_items
      WHEN NEW.transaction_item_id IS NOT NULL
       AND COALESCE((SELECT resolution FROM returns WHERE id=NEW.return_id),'')!='replacement'
      BEGIN
        INSERT OR IGNORE INTO inventory_cost_pools(product_id,branch_key,legacy_unlayered_qty,tracked_qty,tracked_value)
        SELECT ti.product_id,COALESCE(c.branch_key,t.branch_id,0),0,0,0
        FROM transaction_items ti
        JOIN transactions t ON t.id=ti.transaction_id
        LEFT JOIN inventory_cost_consumptions c ON c.transaction_item_id=ti.id
        WHERE ti.id=NEW.transaction_item_id AND ti.product_id IS NOT NULL;

        INSERT OR IGNORE INTO inventory_cost_restorations(
          source_type,source_id,transaction_item_id,product_id,branch_key,quantity,
          tracked_quantity,tracked_value,legacy_quantity,untracked_quantity,unit_cost_reference)
        SELECT 'return_item',CAST(NEW.id AS TEXT),ti.id,ti.product_id,COALESCE(c.branch_key,t.branch_id,0),NEW.quantity,
          CASE WHEN c.id IS NOT NULL AND c.tracked_unit_cost IS NOT NULL
            THEN ROUND(c.tracked_quantity*(NEW.quantity/NULLIF(ti.quantity,0)),4) ELSE 0 END,
          CASE WHEN c.id IS NOT NULL AND c.tracked_unit_cost IS NOT NULL
            THEN ROUND(c.tracked_quantity*(NEW.quantity/NULLIF(ti.quantity,0))*c.tracked_unit_cost,4) ELSE 0 END,
          CASE WHEN c.id IS NOT NULL
            THEN ROUND(c.legacy_quantity*(NEW.quantity/NULLIF(ti.quantity,0)),4) ELSE NEW.quantity END,
          CASE WHEN c.id IS NOT NULL THEN ROUND(MAX(0,NEW.quantity
            -(CASE WHEN c.tracked_unit_cost IS NOT NULL THEN c.tracked_quantity*(NEW.quantity/NULLIF(ti.quantity,0)) ELSE 0 END)
            -(c.legacy_quantity*(NEW.quantity/NULLIF(ti.quantity,0)))),4) ELSE 0 END,
          ti.unit_cost_at_sale
        FROM transaction_items ti
        JOIN transactions t ON t.id=ti.transaction_id
        LEFT JOIN inventory_cost_consumptions c ON c.transaction_item_id=ti.id
        WHERE ti.id=NEW.transaction_item_id AND ti.product_id IS NOT NULL;

        UPDATE inventory_cost_pools
        SET tracked_qty=ROUND(tracked_qty+COALESCE((SELECT tracked_quantity FROM inventory_cost_restorations WHERE source_type='return_item' AND source_id=CAST(NEW.id AS TEXT) AND transaction_item_id=NEW.transaction_item_id),0),4),
            tracked_value=ROUND(tracked_value+COALESCE((SELECT tracked_value FROM inventory_cost_restorations WHERE source_type='return_item' AND source_id=CAST(NEW.id AS TEXT) AND transaction_item_id=NEW.transaction_item_id),0),4),
            legacy_unlayered_qty=ROUND(legacy_unlayered_qty+COALESCE((SELECT legacy_quantity+untracked_quantity FROM inventory_cost_restorations WHERE source_type='return_item' AND source_id=CAST(NEW.id AS TEXT) AND transaction_item_id=NEW.transaction_item_id),0),4),
            updated_at=CURRENT_TIMESTAMP
        WHERE product_id=(SELECT product_id FROM transaction_items WHERE id=NEW.transaction_item_id)
          AND branch_key=COALESCE((SELECT c.branch_key FROM inventory_cost_consumptions c WHERE c.transaction_item_id=NEW.transaction_item_id),(SELECT t.branch_id FROM transaction_items ti JOIN transactions t ON t.id=ti.transaction_id WHERE ti.id=NEW.transaction_item_id),0);

        INSERT OR IGNORE INTO inventory_cost_evidence_gaps(source_type,source_id,product_id,branch_key,gap_type,quantity,details)
        SELECT 'return_item',CAST(NEW.id AS TEXT),r.product_id,r.branch_key,'restored_inventory_cost_not_fully_evidenced',
          ROUND(r.legacy_quantity+r.untracked_quantity,4),
          'Returned merchandise was restored physically, but all or part of its original acquisition cost is not evidence-backed. The unknown portion remains legacy-unlayered instead of being assigned a manufactured cost.'
        FROM inventory_cost_restorations r
        WHERE r.source_type='return_item' AND r.source_id=CAST(NEW.id AS TEXT) AND r.transaction_item_id=NEW.transaction_item_id
          AND r.legacy_quantity+r.untracked_quantity>0;
      END`,args:[]});
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}

async function restoreTransactionItemCost(executor,{sourceType,sourceId,transactionItemId,quantity}){
  await ensureInventoryCostRestoration();
  const restoreQty=qty4(quantity);
  if(!sourceType||sourceId===undefined||sourceId===null||!transactionItemId||restoreQty<=0) throw new Error('Invalid inventory cost restoration request');

  const {rows:[existing]}=await executor.execute({sql:`SELECT * FROM inventory_cost_restorations WHERE source_type=? AND source_id=? AND transaction_item_id=?`,args:[sourceType,String(sourceId),transactionItemId]});
  if(existing) return existing;

  const {rows:[line]}=await executor.execute({sql:`SELECT ti.id,ti.transaction_id,ti.product_id,ti.quantity sold_quantity,ti.unit_cost_at_sale,t.branch_id
    FROM transaction_items ti JOIN transactions t ON t.id=ti.transaction_id WHERE ti.id=?`,args:[transactionItemId]});
  if(!line||!line.product_id) throw new Error(`Transaction item ${transactionItemId} has no inventory product evidence`);
  const soldQty=qty4(line.sold_quantity);
  if(soldQty<=0||restoreQty-soldQty>0.0001) throw new Error(`Restoration quantity exceeds original sold quantity for transaction item ${transactionItemId}`);

  const {rows:[consumption]}=await executor.execute({sql:'SELECT * FROM inventory_cost_consumptions WHERE transaction_item_id=?',args:[transactionItemId]});
  const branchKey=Number(consumption?.branch_key ?? line.branch_id ?? 0);

  const {rows:[already]}=await executor.execute({sql:`SELECT COALESCE(SUM(quantity),0) quantity FROM inventory_cost_restorations WHERE transaction_item_id=?`,args:[transactionItemId]});
  const priorQty=qty4(already?.quantity);
  if(priorQty+restoreQty-soldQty>0.0001) throw new Error(`Cumulative restoration would exceed original sold quantity for transaction item ${transactionItemId}`);

  let trackedQty=0,trackedValue=0,legacyQty=0,untrackedQty=0;
  const unitRef=Number.isFinite(Number(line.unit_cost_at_sale))?money4(line.unit_cost_at_sale):null;
  if(consumption){
    const ratio=restoreQty/soldQty;
    trackedQty=qty4(Number(consumption.tracked_quantity||0)*ratio);
    legacyQty=qty4(Number(consumption.legacy_quantity||0)*ratio);
    untrackedQty=qty4(Math.max(0,restoreQty-trackedQty-legacyQty));
    const trackedUnit=Number(consumption.tracked_unit_cost);
    trackedValue=Number.isFinite(trackedUnit)?money4(trackedQty*trackedUnit):0;
    if(trackedQty>0&&!Number.isFinite(trackedUnit)){
      trackedQty=0;
      untrackedQty=qty4(restoreQty-legacyQty);
    }
  }else{
    legacyQty=restoreQty;
  }

  await executor.execute({sql:`INSERT OR IGNORE INTO inventory_cost_pools(product_id,branch_key,legacy_unlayered_qty,tracked_qty,tracked_value)
    VALUES(?,?,0,0,0)`,args:[line.product_id,branchKey]});

  if(trackedQty>0||trackedValue>0){
    await executor.execute({sql:`UPDATE inventory_cost_pools SET tracked_qty=ROUND(tracked_qty+?,4),tracked_value=ROUND(tracked_value+?,4),updated_at=CURRENT_TIMESTAMP WHERE product_id=? AND branch_key=?`,args:[trackedQty,trackedValue,line.product_id,branchKey]});
  }
  const unknownQty=qty4(legacyQty+untrackedQty);
  if(unknownQty>0){
    await executor.execute({sql:`UPDATE inventory_cost_pools SET legacy_unlayered_qty=ROUND(legacy_unlayered_qty+?,4),updated_at=CURRENT_TIMESTAMP WHERE product_id=? AND branch_key=?`,args:[unknownQty,line.product_id,branchKey]});
    await executor.execute({sql:`INSERT OR IGNORE INTO inventory_cost_evidence_gaps(source_type,source_id,product_id,branch_key,gap_type,quantity,details)
      VALUES(?,?,?,?,?,?,?)`,args:[sourceType,String(sourceId),line.product_id,branchKey,'restored_inventory_cost_not_fully_evidenced',unknownQty,'Returned/voided inventory was restored physically, but all or part of its original acquisition cost is not evidence-backed. The unknown portion remains legacy-unlayered instead of being assigned a manufactured cost.']});
  }

  const r=await executor.execute({sql:`INSERT INTO inventory_cost_restorations(source_type,source_id,transaction_item_id,product_id,branch_key,quantity,tracked_quantity,tracked_value,legacy_quantity,untracked_quantity,unit_cost_reference)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`,args:[sourceType,String(sourceId),transactionItemId,line.product_id,branchKey,restoreQty,trackedQty,trackedValue,legacyQty,untrackedQty,unitRef]});
  const {rows:[row]}=await executor.execute({sql:'SELECT * FROM inventory_cost_restorations WHERE id=?',args:[Number(r.lastInsertRowid)]});
  return row;
}

module.exports={ensureInventoryCostRestoration,restoreTransactionItemCost};
