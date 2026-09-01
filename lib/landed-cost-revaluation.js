const { db } = require('../database');
const { ensureInventoryCostLayers } = require('./inventory-cost-layers');

let readyPromise = null;
function money4(v){ const n=Number(v); return Number.isFinite(n)?Number(n.toFixed(4)):0; }

async function ensureLandedCostRevaluationSchema(){
  if(readyPromise) return readyPromise;
  readyPromise=(async()=>{
    await ensureInventoryCostLayers();
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS landed_cost_revaluations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        allocation_item_id INTEGER NOT NULL UNIQUE REFERENCES landed_cost_allocation_items(id),
        allocation_id INTEGER NOT NULL REFERENCES landed_cost_allocations(id),
        purchase_receipt_item_id INTEGER NOT NULL REFERENCES purchase_receipt_items(id),
        product_id INTEGER NOT NULL REFERENCES products(id),
        branch_key INTEGER NOT NULL DEFAULT 0,
        allocated_amount REAL NOT NULL,
        cogs_adjustment REAL NOT NULL DEFAULT 0,
        inventory_adjustment REAL NOT NULL DEFAULT 0,
        receipt_quantity REAL NOT NULL,
        tracked_quantity_consumed_before_allocation REAL NOT NULL DEFAULT 0,
        replay_method TEXT NOT NULL DEFAULT 'historical_moving_average_delta_replay',
        replayed_through DATETIME NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:'CREATE INDEX IF NOT EXISTS idx_landed_revaluations_allocation ON landed_cost_revaluations(allocation_id)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_landed_revaluations_product_branch ON landed_cost_revaluations(product_id,branch_key)'}
    ],'write');
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}

async function finalizeLandedCostAllocationItem(executor, allocationItemId){
  const {rows:[existing]}=await executor.execute({sql:'SELECT * FROM landed_cost_revaluations WHERE allocation_item_id=?',args:[allocationItemId]});
  if(existing) return existing;

  const {rows:[item]}=await executor.execute({sql:`SELECT lcai.*,lca.id allocation_id,lca.allocated_at,lca.allocation_number,
      l.id layer_id,l.product_id layer_product_id,l.branch_key,l.quantity_original,l.received_at
    FROM landed_cost_allocation_items lcai
    JOIN landed_cost_allocations lca ON lca.id=lcai.allocation_id
    JOIN inventory_cost_layers l ON l.purchase_receipt_item_id=lcai.purchase_receipt_item_id
    WHERE lcai.id=?`,args:[allocationItemId]});
  if(!item) throw new Error(`Landed cost allocation item ${allocationItemId} has no auditable inventory cost layer`);

  const productId=Number(item.product_id||item.layer_product_id);
  const branchKey=Number(item.branch_key||0);
  const targetLayerId=Number(item.layer_id);
  const amount=money4(item.allocated_amount);
  const receiptQty=Number(item.quantity_original||item.quantity_received||0);
  if(!productId||!targetLayerId||!Number.isFinite(amount)||amount<0||!Number.isFinite(receiptQty)||receiptQty<=0) throw new Error('Invalid landed-cost revaluation evidence');

  const cutoff=String(item.allocated_at||new Date().toISOString());
  const {rows:layers}=await executor.execute({sql:`SELECT id,received_at,quantity_original
    FROM inventory_cost_layers
    WHERE product_id=? AND branch_key=? AND datetime(received_at)<=datetime(?)
    ORDER BY datetime(received_at),id`,args:[productId,branchKey,cutoff]});
  const {rows:consumptions}=await executor.execute({sql:`SELECT c.id,c.tracked_quantity,COALESCE(t.created_at,c.created_at) event_at
    FROM inventory_cost_consumptions c
    JOIN transactions t ON t.id=c.transaction_id
    WHERE c.product_id=? AND c.branch_key=? AND datetime(COALESCE(t.created_at,c.created_at))<=datetime(?)
    ORDER BY datetime(COALESCE(t.created_at,c.created_at)),c.id`,args:[productId,branchKey,cutoff]});

  const events=[];
  for(const l of layers) events.push({kind:'receipt',at:String(l.received_at),id:Number(l.id),qty:Number(l.quantity_original||0)});
  for(const c of consumptions) events.push({kind:'consume',at:String(c.event_at),id:Number(c.id),qty:Number(c.tracked_quantity||0)});
  events.sort((a,b)=>{
    const ta=Date.parse(a.at)||0,tb=Date.parse(b.at)||0;
    if(ta!==tb)return ta-tb;
    if(a.kind!==b.kind)return a.kind==='receipt'?-1:1;
    return a.id-b.id;
  });

  let poolQty=0;
  let deltaRemaining=0;
  let deltaConsumed=0;
  let trackedConsumedAfterReceipt=0;
  let active=false;
  for(const ev of events){
    if(ev.kind==='receipt'){
      poolQty=money4(poolQty+Math.max(0,ev.qty));
      if(ev.id===targetLayerId){ active=true; deltaRemaining=amount; }
      continue;
    }
    const consume=Math.min(Math.max(0,ev.qty),Math.max(0,poolQty));
    if(active && consume>0 && poolQty>0 && deltaRemaining>0){
      const deltaThis=money4(deltaRemaining*(consume/poolQty));
      deltaConsumed=money4(deltaConsumed+deltaThis);
      deltaRemaining=money4(Math.max(0,deltaRemaining-deltaThis));
      trackedConsumedAfterReceipt=money4(trackedConsumedAfterReceipt+consume);
    }
    poolQty=money4(Math.max(0,poolQty-consume));
  }

  if(!active) throw new Error(`Could not locate receipt layer for landed cost allocation item ${allocationItemId}`);
  const inventoryAdjustment=money4(Math.max(0,amount-deltaConsumed));
  const cogsAdjustment=money4(amount-inventoryAdjustment);
  if(Math.abs(money4(cogsAdjustment+inventoryAdjustment)-amount)>0.0001) throw new Error('Late landed-cost split does not reconcile to allocated amount');

  const r=await executor.execute({sql:`INSERT INTO landed_cost_revaluations(
      allocation_item_id,allocation_id,purchase_receipt_item_id,product_id,branch_key,allocated_amount,cogs_adjustment,inventory_adjustment,receipt_quantity,tracked_quantity_consumed_before_allocation,replayed_through)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`,args:[allocationItemId,item.allocation_id,item.purchase_receipt_item_id,productId,branchKey,amount,cogsAdjustment,inventoryAdjustment,receiptQty,trackedConsumedAfterReceipt,cutoff]});

  if(inventoryAdjustment>0){
    const update=await executor.execute({sql:`UPDATE inventory_cost_pools
      SET tracked_value=ROUND(tracked_value+?,4),updated_at=CURRENT_TIMESTAMP
      WHERE product_id=? AND branch_key=?`,args:[inventoryAdjustment,productId,branchKey]});
    if(Number(update.rowsAffected||0)!==1) throw new Error('Inventory cost pool missing for landed-cost revaluation');
  }

  const {rows:[row]}=await executor.execute({sql:'SELECT * FROM landed_cost_revaluations WHERE id=?',args:[Number(r.lastInsertRowid)]});
  return row;
}

async function finalizeLandedCostAllocation(executor, allocationId){
  const {rows:items}=await executor.execute({sql:'SELECT id FROM landed_cost_allocation_items WHERE allocation_id=? ORDER BY id',args:[allocationId]});
  if(!items.length) throw new Error('Landed cost allocation has no allocation items');
  const rows=[];
  for(const item of items) rows.push(await finalizeLandedCostAllocationItem(executor,item.id));
  const allocated=money4(rows.reduce((s,x)=>s+Number(x.allocated_amount||0),0));
  const split=money4(rows.reduce((s,x)=>s+Number(x.cogs_adjustment||0)+Number(x.inventory_adjustment||0),0));
  if(Math.abs(allocated-split)>0.0001) throw new Error('Landed-cost revaluation allocation does not reconcile');
  return rows;
}

module.exports={ensureLandedCostRevaluationSchema,finalizeLandedCostAllocation,finalizeLandedCostAllocationItem};
