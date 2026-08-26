'use strict';
const {db}=require('../database');
const {ensureInventoryCostLayers}=require('./inventory-cost-layers');

let readyPromise=null;
const q=v=>{const n=Number(v);return Number.isFinite(n)?Number(n.toFixed(4)):0;};
const m=v=>{const n=Number(v);return Number.isFinite(n)?Number(n.toFixed(4)):0;};

async function ensureInventoryMovementValuation(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await ensureInventoryCostLayers();
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS inventory_adjustment_valuations(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stock_movement_id INTEGER UNIQUE REFERENCES stock_movements(id),
        product_id INTEGER NOT NULL REFERENCES products(id),
        branch_key INTEGER NOT NULL DEFAULT 0,
        quantity_change REAL NOT NULL,
        tracked_quantity REAL NOT NULL DEFAULT 0,
        tracked_value REAL NOT NULL DEFAULT 0,
        legacy_quantity REAL NOT NULL DEFAULT 0,
        untracked_quantity REAL NOT NULL DEFAULT 0,
        reason TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS inventory_transfer_valuations(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transfer_id INTEGER NOT NULL REFERENCES branch_transfers(id),
        transfer_item_id INTEGER NOT NULL UNIQUE REFERENCES branch_transfer_items(id),
        product_id INTEGER NOT NULL REFERENCES products(id),
        from_branch_id INTEGER NOT NULL,
        to_branch_id INTEGER NOT NULL,
        quantity_requested REAL NOT NULL,
        tracked_quantity REAL NOT NULL DEFAULT 0,
        tracked_value REAL NOT NULL DEFAULT 0,
        legacy_quantity REAL NOT NULL DEFAULT 0,
        untracked_quantity REAL NOT NULL DEFAULT 0,
        quantity_received_valued REAL NOT NULL DEFAULT 0,
        quantity_cancelled_restored REAL NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:'CREATE INDEX IF NOT EXISTS idx_transfer_valuation_transfer ON inventory_transfer_valuations(transfer_id)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_adjustment_valuation_product ON inventory_adjustment_valuations(product_id,branch_key)'}
    ],'write');
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}

async function ensurePool(executor,productId,branchKey,physicalFallback=0){
  await executor.execute({sql:`INSERT OR IGNORE INTO inventory_cost_pools(product_id,branch_key,legacy_unlayered_qty,tracked_qty,tracked_value)
    VALUES(?,?,?,?,?)`,args:[productId,branchKey,Math.max(0,q(physicalFallback)),0,0]});
  const {rows:[pool]}=await executor.execute({sql:'SELECT * FROM inventory_cost_pools WHERE product_id=? AND branch_key=?',args:[productId,branchKey]});
  return pool;
}

function consumeComposition(pool,quantity){
  const qty=q(quantity),legacy=q(Math.min(q(pool.legacy_unlayered_qty),qty));
  const remaining=q(Math.max(0,qty-legacy));
  const tracked=q(Math.min(q(pool.tracked_qty),remaining));
  const unit=Number(pool.tracked_qty)>0?m(Number(pool.tracked_value||0)/Number(pool.tracked_qty||1)):0;
  const value=m(tracked*unit);
  const shortage=q(Math.max(0,qty-legacy-tracked));
  return {qty,legacy,tracked,value,shortage};
}

async function removeFromPool(executor,productId,branchKey,quantity,sourceType,sourceId){
  const pool=await ensurePool(executor,productId,branchKey,0);
  const c=consumeComposition(pool,quantity);
  await executor.execute({sql:`UPDATE inventory_cost_pools SET
    legacy_unlayered_qty=ROUND(MAX(0,legacy_unlayered_qty-?),4),
    tracked_qty=ROUND(MAX(0,tracked_qty-?),4),
    tracked_value=ROUND(MAX(0,tracked_value-?),4),updated_at=CURRENT_TIMESTAMP
    WHERE product_id=? AND branch_key=?`,args:[c.legacy,c.tracked,c.value,productId,branchKey]});
  if(c.shortage>0)await executor.execute({sql:`INSERT OR IGNORE INTO inventory_cost_evidence_gaps(source_type,source_id,product_id,branch_key,gap_type,quantity,details)
    VALUES(?,?,?,?,?,?,?)`,args:[sourceType,String(sourceId),productId,branchKey,'inventory_movement_cost_pool_shortage',c.shortage,'Physical inventory left stock but the auditable valuation pool did not contain enough quantity. No cost was invented for the uncovered portion.']});
  return c;
}

async function addComposition(executor,productId,branchKey,{legacy=0,tracked=0,value=0,shortage=0},sourceType,sourceId){
  await ensurePool(executor,productId,branchKey,0);
  const unknown=q(legacy+shortage);
  await executor.execute({sql:`UPDATE inventory_cost_pools SET
    legacy_unlayered_qty=ROUND(legacy_unlayered_qty+?,4),tracked_qty=ROUND(tracked_qty+?,4),tracked_value=ROUND(tracked_value+?,4),updated_at=CURRENT_TIMESTAMP
    WHERE product_id=? AND branch_key=?`,args:[unknown,q(tracked),m(value),productId,branchKey]});
  if(shortage>0)await executor.execute({sql:`INSERT OR IGNORE INTO inventory_cost_evidence_gaps(source_type,source_id,product_id,branch_key,gap_type,quantity,details)
    VALUES(?,?,?,?,?,?,?)`,args:[sourceType,String(sourceId),productId,branchKey,'inventory_movement_restored_without_cost_evidence',shortage,'Inventory was restored physically but no auditable acquisition-cost evidence existed for this portion, so it remains legacy-unlayered.']});
}

async function valueStockAdjustment(executor,{stockMovementId,productId,branchKey,quantityChange,reason,physicalBefore}){
  await ensureInventoryMovementValuation();
  const change=q(quantityChange);
  if(!change)return null;
  let comp={legacy:0,tracked:0,value:0,shortage:0};
  if(change<0){comp=await removeFromPool(executor,productId,branchKey,Math.abs(change),'stock_adjustment',stockMovementId);}
  else{
    await ensurePool(executor,productId,branchKey,physicalBefore||0);
    comp={legacy:change,tracked:0,value:0,shortage:0};
    await addComposition(executor,productId,branchKey,comp,'stock_adjustment',stockMovementId);
    await executor.execute({sql:`INSERT OR IGNORE INTO inventory_cost_evidence_gaps(source_type,source_id,product_id,branch_key,gap_type,quantity,details)
      VALUES(?,?,?,?,?,?,?)`,args:['stock_adjustment',String(stockMovementId),productId,branchKey,'positive_adjustment_cost_unknown',change,'A positive stock adjustment created physical inventory without immutable purchasing/receipt cost evidence. The quantity is carried as legacy-unlayered until better evidence is supplied.']});
  }
  const r=await executor.execute({sql:`INSERT OR IGNORE INTO inventory_adjustment_valuations(stock_movement_id,product_id,branch_key,quantity_change,tracked_quantity,tracked_value,legacy_quantity,untracked_quantity,reason)
    VALUES(?,?,?,?,?,?,?,?,?)`,args:[stockMovementId,productId,branchKey,change,q(comp.tracked),m(comp.value),q(comp.legacy),q(comp.shortage),reason||null]});
  return Number(r.lastInsertRowid||0);
}

async function reserveTransferValuation(executor,{transferId,transferItemId,productId,fromBranchId,toBranchId,quantityRequested}){
  await ensureInventoryMovementValuation();
  const {rows:[existing]}=await executor.execute({sql:'SELECT * FROM inventory_transfer_valuations WHERE transfer_item_id=?',args:[transferItemId]});
  if(existing)return existing;
  const c=await removeFromPool(executor,productId,Number(fromBranchId),quantityRequested,'branch_transfer',transferItemId);
  await executor.execute({sql:`INSERT INTO inventory_transfer_valuations(transfer_id,transfer_item_id,product_id,from_branch_id,to_branch_id,quantity_requested,tracked_quantity,tracked_value,legacy_quantity,untracked_quantity)
    VALUES(?,?,?,?,?,?,?,?,?,?)`,args:[transferId,transferItemId,productId,fromBranchId,toBranchId,q(quantityRequested),c.tracked,c.value,c.legacy,c.shortage]});
  const {rows:[row]}=await executor.execute({sql:'SELECT * FROM inventory_transfer_valuations WHERE transfer_item_id=?',args:[transferItemId]});
  return row;
}

function sliceComposition(row,quantity,final=false){
  const total=q(row.quantity_requested),qty=q(quantity);
  const used=q(Number(row.quantity_received_valued||0)+Number(row.quantity_cancelled_restored||0));
  const remaining=q(Math.max(0,total-used));
  const take=q(Math.min(qty,remaining));
  if(take<=0)return {quantity:0,legacy:0,tracked:0,value:0,shortage:0};
  const remainingRatio=remaining>0?take/remaining:0;
  const priorRatio=total>0?used/total:0;
  const remLegacy=q(Number(row.legacy_quantity||0)*(1-priorRatio));
  const remTracked=q(Number(row.tracked_quantity||0)*(1-priorRatio));
  const remValue=m(Number(row.tracked_value||0)*(1-priorRatio));
  const remShort=q(Number(row.untracked_quantity||0)*(1-priorRatio));
  if(final||Math.abs(take-remaining)<0.0001)return {quantity:take,legacy:remLegacy,tracked:remTracked,value:remValue,shortage:remShort};
  return {quantity:take,legacy:q(remLegacy*remainingRatio),tracked:q(remTracked*remainingRatio),value:m(remValue*remainingRatio),shortage:q(remShort*remainingRatio)};
}

async function receiveTransferValuation(executor,{transferItemId,quantity}){
  await ensureInventoryMovementValuation();
  const {rows:[row]}=await executor.execute({sql:'SELECT * FROM inventory_transfer_valuations WHERE transfer_item_id=?',args:[transferItemId]});
  if(!row)throw new Error(`Transfer valuation evidence missing for item ${transferItemId}`);
  const comp=sliceComposition(row,quantity);
  if(comp.quantity<=0)return comp;
  await addComposition(executor,row.product_id,row.to_branch_id,comp,'branch_transfer_receive',transferItemId);
  await executor.execute({sql:'UPDATE inventory_transfer_valuations SET quantity_received_valued=ROUND(quantity_received_valued+?,4),updated_at=CURRENT_TIMESTAMP WHERE transfer_item_id=?',args:[comp.quantity,transferItemId]});
  return comp;
}

async function cancelTransferValuation(executor,{transferItemId,quantity}){
  await ensureInventoryMovementValuation();
  const {rows:[row]}=await executor.execute({sql:'SELECT * FROM inventory_transfer_valuations WHERE transfer_item_id=?',args:[transferItemId]});
  if(!row)throw new Error(`Transfer valuation evidence missing for item ${transferItemId}`);
  const comp=sliceComposition(row,quantity,true);
  if(comp.quantity<=0)return comp;
  await addComposition(executor,row.product_id,row.from_branch_id,comp,'branch_transfer_cancel',transferItemId);
  await executor.execute({sql:'UPDATE inventory_transfer_valuations SET quantity_cancelled_restored=ROUND(quantity_cancelled_restored+?,4),updated_at=CURRENT_TIMESTAMP WHERE transfer_item_id=?',args:[comp.quantity,transferItemId]});
  return comp;
}

module.exports={ensureInventoryMovementValuation,ensurePool,consumeComposition,removeFromPool,addComposition,valueStockAdjustment,reserveTransferValuation,receiveTransferValuation,cancelTransferValuation};
