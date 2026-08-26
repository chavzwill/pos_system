'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requireAuth,requirePermission}=require('../lib/permissions');
const {nextNumber}=require('../lib/nextNumber');
const {ensureInventoryTraceability,getTrackingProfile}=require('../lib/inventory-traceability');
const {ensureInventoryMovementValuation,reserveTransferValuation,receiveTransferValuation,cancelTransferValuation}=require('../lib/inventory-movement-valuation');

router.use(requireAuth);
let readyPromise=null;
async function ensureSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await ensureInventoryTraceability();
    await ensureInventoryMovementValuation();
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS transfer_identity_allocations(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transfer_id INTEGER NOT NULL REFERENCES branch_transfers(id),
        transfer_item_id INTEGER NOT NULL REFERENCES branch_transfer_items(id),
        product_id INTEGER NOT NULL REFERENCES products(id),
        tracking_mode TEXT NOT NULL,
        serial_id INTEGER REFERENCES inventory_serials(id),
        source_lot_id INTEGER REFERENCES inventory_lots(id),
        lot_number TEXT,
        quantity INTEGER NOT NULL,
        source_branch_id INTEGER NOT NULL REFERENCES branches(id),
        destination_branch_id INTEGER NOT NULL REFERENCES branches(id),
        source_bin_id INTEGER REFERENCES storage_bins(id),
        destination_bin_id INTEGER REFERENCES storage_bins(id),
        manufacture_date TEXT,
        expiry_date TEXT,
        unit_cost REAL,
        status TEXT NOT NULL DEFAULT 'in_transit',
        received_quantity INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        received_at DATETIME,
        cancelled_at DATETIME
      )`},
      {sql:'CREATE INDEX IF NOT EXISTS idx_transfer_identity_transfer ON transfer_identity_allocations(transfer_id,transfer_item_id,status)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_transfer_identity_serial ON transfer_identity_allocations(serial_id,status)'}
    ],'write');
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
async function binControlled(executor,productId,branchId){const {rows}=await executor.execute({sql:'SELECT bin_id,quantity FROM product_bin_assignments WHERE product_id=? AND branch_id=?',args:[productId,branchId]});return rows;}
async function decrementExactBin(executor,productId,branchId,binId,qty){
  const bins=await binControlled(executor,productId,branchId);if(!bins.length)return;
  if(!binId)throw new Error('Tracked inventory at a bin-controlled branch requires exact source bin identity');
  const row=bins.find(x=>Number(x.bin_id)===Number(binId));if(!row||Number(row.quantity||0)<qty)throw new Error('Exact tracked source bin no longer contains enough quantity');
  await executor.execute({sql:'UPDATE product_bin_assignments SET quantity=quantity-?,updated_at=CURRENT_TIMESTAMP WHERE product_id=? AND branch_id=? AND bin_id=?',args:[qty,productId,branchId,binId]});
}
async function incrementExactBin(executor,productId,branchId,binId,qty){
  const bins=await binControlled(executor,productId,branchId);if(!bins.length)return;
  if(!binId)throw new Error('Destination bin is required for tracked inventory at this branch');
  const row=bins.find(x=>Number(x.bin_id)===Number(binId));if(!row)throw new Error('Selected destination bin is not assigned to this product at the destination branch');
  await executor.execute({sql:'UPDATE product_bin_assignments SET quantity=quantity+?,updated_at=CURRENT_TIMESTAMP WHERE product_id=? AND branch_id=? AND bin_id=?',args:[qty,productId,branchId,binId]});
}
async function allocateIdentity(executor,{transferId,transferItemId,productId,qty,from,to,line}){
  const profile=await getTrackingProfile(executor,productId);if(profile.tracking_mode==='none')return false;
  if(profile.tracking_mode==='serial'){
    const serials=Array.isArray(line.serial_numbers)?line.serial_numbers.map(String):[];
    if(serials.length!==qty)throw new Error(`Serial-tracked transfer requires exactly ${qty} serial numbers`);
    if(new Set(serials.map(x=>x.toLowerCase())).size!==serials.length)throw new Error('The same serial cannot appear twice on a transfer line');
    for(const sn of serials){
      const {rows:[s]}=await executor.execute({sql:`SELECT * FROM inventory_serials WHERE lower(serial_number)=lower(?) AND product_id=? AND branch_id=? AND status='available'`,args:[sn,productId,from]});
      if(!s)throw new Error(`Serial ${sn} is not available at the source branch`);
      if(s.expiry_date&&String(s.expiry_date)<new Date().toISOString().slice(0,10))throw new Error(`Serial ${sn} is expired and cannot be transferred as available stock`);
      const {rows:[busy]}=await executor.execute({sql:`SELECT id FROM transfer_identity_allocations WHERE serial_id=? AND status='in_transit'`,args:[s.id]});if(busy)throw new Error(`Serial ${sn} is already in transit`);
      const destBin=line.destination_bin_id?Number(line.destination_bin_id):null;
      await decrementExactBin(executor,productId,from,s.bin_id,1);
      await executor.execute({sql:`INSERT INTO transfer_identity_allocations(transfer_id,transfer_item_id,product_id,tracking_mode,serial_id,lot_number,quantity,source_branch_id,destination_branch_id,source_bin_id,destination_bin_id,manufacture_date,expiry_date,unit_cost) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:[transferId,transferItemId,productId,'serial',s.id,s.lot_number,1,from,to,s.bin_id,destBin,s.manufacture_date,s.expiry_date,s.unit_cost]});
      await executor.execute({sql:`UPDATE inventory_serials SET status='in_transit',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='available'`,args:[s.id]});
      await executor.execute({sql:`INSERT INTO inventory_identity_events(product_id,branch_id,serial_id,event_type,quantity,reference_type,reference_id,employee_id,details) VALUES(?,?,?,?,?,?,?,?,?)`,args:[productId,from,s.id,'transfer_out',1,'branch_transfer',String(transferId),line.employee_id||null,`Serial ${sn} placed in transit` ]});
    }
    return true;
  }
  let allocations=[];
  if(Array.isArray(line.lots)&&line.lots.length){
    for(const x of line.lots){const q=Number(x.quantity);if(!Number.isInteger(q)||q<=0)throw new Error('Lot transfer quantities must be positive whole numbers');const {rows:[lot]}=await executor.execute({sql:`SELECT * FROM inventory_lots WHERE id=? AND product_id=? AND branch_id=? AND status='available'`,args:[Number(x.lot_id),productId,from]});if(!lot)throw new Error(`Lot ${x.lot_id} is not available at the source branch`);allocations.push({lot,quantity:q,destination_bin_id:x.destination_bin_id?Number(x.destination_bin_id):line.destination_bin_id?Number(line.destination_bin_id):null});}
    if(allocations.reduce((s,x)=>s+x.quantity,0)!==qty)throw new Error(`Selected lot quantities must total ${qty}`);
  }else{
    const {rows:lots}=await executor.execute({sql:`SELECT * FROM inventory_lots WHERE product_id=? AND branch_id=? AND status='available' AND available_quantity>0 AND (expiry_date IS NULL OR date(expiry_date)>=date('now')) ORDER BY CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END,date(expiry_date),created_at,id`,args:[productId,from]});
    let remain=qty;for(const lot of lots){if(remain<=0)break;const take=Math.min(remain,Number(lot.available_quantity));if(take>0){allocations.push({lot,quantity:take,destination_bin_id:line.destination_bin_id?Number(line.destination_bin_id):null});remain-=take;}}
    if(remain>0)throw new Error(`Only ${qty-remain} traceable lot units are available for transfer`);
  }
  for(const a of allocations){
    if(Number(a.lot.available_quantity)<a.quantity)throw new Error(`Lot ${a.lot.lot_number} no longer contains enough available quantity`);
    await decrementExactBin(executor,productId,from,a.lot.bin_id,a.quantity);
    await executor.execute({sql:'UPDATE inventory_lots SET available_quantity=available_quantity-? WHERE id=? AND available_quantity>=?',args:[a.quantity,a.lot.id,a.quantity]});
    await executor.execute({sql:`INSERT INTO transfer_identity_allocations(transfer_id,transfer_item_id,product_id,tracking_mode,source_lot_id,lot_number,quantity,source_branch_id,destination_branch_id,source_bin_id,destination_bin_id,manufacture_date,expiry_date,unit_cost) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:[transferId,transferItemId,productId,'lot',a.lot.id,a.lot.lot_number,a.quantity,from,to,a.lot.bin_id,a.destination_bin_id,a.lot.manufacture_date,a.lot.expiry_date,a.lot.unit_cost]});
    await executor.execute({sql:`INSERT INTO inventory_identity_events(product_id,branch_id,lot_id,event_type,quantity,reference_type,reference_id,details) VALUES(?,?,?,?,?,?,?,?)`,args:[productId,from,a.lot.id,'transfer_out',a.quantity,'branch_transfer',String(transferId),`Lot ${a.lot.lot_number} placed in transit`]});
  }
  return true;
}

router.post('/',requirePermission('transfers'),async(req,res)=>{
  try{await ensureSchema();const from=Number(req.body?.from_branch_id),to=Number(req.body?.to_branch_id),items=Array.isArray(req.body?.items)?req.body.items:[];
    if(!from||!to||from===to)return res.status(400).json({error:'Two different valid branches are required'});if(!items.length)return res.status(400).json({error:'No items in transfer'});
    const tx=await db.transaction('write');let committed=false;
    try{
      const {rows:[fb]}=await tx.execute({sql:'SELECT id FROM branches WHERE id=?',args:[from]});const {rows:[tb]}=await tx.execute({sql:'SELECT id FROM branches WHERE id=?',args:[to]});if(!fb||!tb)throw new Error('Transfer branch not found');
      const number=await nextNumber(tx,'branch_transfers','transfer_number','TRF-',6);const tr=await tx.execute({sql:'INSERT INTO branch_transfers(transfer_number,from_branch_id,to_branch_id,employee_id,notes,quote_id) VALUES(?,?,?,?,?,NULL)',args:[number,from,to,req.employee?.id||null,req.body?.notes||null]});const transferId=Number(tr.lastInsertRowid);
      for(const line of items){const productId=Number(line.product_id),qty=Number(line.quantity);if(!productId||!Number.isInteger(qty)||qty<=0)throw new Error('Every transfer line requires a product and positive whole-number quantity');
        const {rows:[p]}=await tx.execute({sql:'SELECT * FROM products WHERE id=? AND active=1',args:[productId]});if(!p||p.is_service||p.is_non_inventory)throw new Error(`Product ${productId} is not transferable inventory`);
        const {rows:[src]}=await tx.execute({sql:'SELECT stock_qty FROM branch_inventory WHERE product_id=? AND branch_id=?',args:[productId,from]});if(Number(src?.stock_qty||0)<qty)throw new Error(`Insufficient stock for ${p.name} at source branch`);
        const ir=await tx.execute({sql:'INSERT INTO branch_transfer_items(transfer_id,product_id,product_name,sku,quantity_requested) VALUES(?,?,?,?,?)',args:[transferId,productId,p.name,p.sku,qty]});const itemId=Number(ir.lastInsertRowid);
        const tracked=await allocateIdentity(tx,{transferId,transferItemId:itemId,productId,qty,from,to,line:{...line,employee_id:req.employee?.id||null}});
        await tx.execute({sql:'UPDATE branch_inventory SET stock_qty=stock_qty-?,updated_at=CURRENT_TIMESTAMP WHERE product_id=? AND branch_id=?',args:[qty,productId,from]});
        if(!tracked){const {syncBinQty}=require('../lib/binSync');await syncBinQty(tx,productId,from,-qty);}
        await tx.execute({sql:'UPDATE products SET stock_qty=MAX(0,stock_qty-?) WHERE id=?',args:[qty,productId]});
        await reserveTransferValuation(tx,{transferId,transferItemId:itemId,productId,fromBranchId:from,toBranchId:to,quantityRequested:qty});
      }
      await tx.commit();committed=true;const {rows:[saved]}=await db.execute({sql:'SELECT * FROM branch_transfers WHERE id=?',args:[transferId]});const {rows:savedItems}=await db.execute({sql:'SELECT * FROM branch_transfer_items WHERE transfer_id=?',args:[transferId]});saved.items=savedItems;res.status(201).json(saved);
    }catch(e){if(!committed)await tx.rollback();res.status(400).json({error:e.message});}
  }catch(e){res.status(500).json({error:e.message});}
});

router.patch('/:id/receive',requirePermission('transfers_dropoff'),async(req,res)=>{
  try{await ensureSchema();const {rows:[transfer]}=await db.execute({sql:'SELECT * FROM branch_transfers WHERE id=?',args:[req.params.id]});if(!transfer)return res.status(404).json({error:'Transfer not found'});if(['cancelled','received'].includes(transfer.status))return res.status(409).json({error:`Transfer is already ${transfer.status}`});
    const submitted=Array.isArray(req.body?.items)?req.body.items:[];if(!submitted.length)return res.status(400).json({error:'At least one received quantity is required'});
    const tx=await db.transaction('write');let committed=false;
    try{
      for(const s of submitted){const id=Number(s.item_id),qty=Number(s.quantity_received);if(!id||!Number.isInteger(qty)||qty<=0)throw new Error('Received quantities must be positive whole numbers');const {rows:[item]}=await tx.execute({sql:'SELECT * FROM branch_transfer_items WHERE id=? AND transfer_id=?',args:[id,transfer.id]});if(!item)throw new Error(`Transfer item ${id} not found`);const pending=Number(item.quantity_requested)-Number(item.quantity_received||0);if(qty>pending)throw new Error(`Received quantity exceeds pending quantity for ${item.product_name}`);
        const {rows:allocs}=await tx.execute({sql:`SELECT * FROM transfer_identity_allocations WHERE transfer_item_id=? AND status='in_transit' ORDER BY id`,args:[id]});
        if(allocs.length){const availableIdentity=allocs.reduce((sum,a)=>sum+(Number(a.quantity)-Number(a.received_quantity||0)),0);if(qty>availableIdentity)throw new Error('Receipt quantity exceeds tracked serial/lot identity still in transit');let remain=qty;
          for(const a of allocs){if(remain<=0)break;const open=Number(a.quantity)-Number(a.received_quantity||0),take=Math.min(remain,open);if(take<=0)continue;
            if(a.tracking_mode==='serial'){if(take!==1||open!==1)throw new Error('Serial identity transfer allocation is inconsistent');await incrementExactBin(tx,a.product_id,transfer.to_branch_id,a.destination_bin_id,1);await tx.execute({sql:`UPDATE inventory_serials SET branch_id=?,bin_id=?,status='available',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='in_transit'`,args:[transfer.to_branch_id,a.destination_bin_id||null,a.serial_id]});await tx.execute({sql:`INSERT INTO inventory_identity_events(product_id,branch_id,serial_id,event_type,quantity,reference_type,reference_id,employee_id,details) VALUES(?,?,?,?,?,?,?,?,?)`,args:[a.product_id,transfer.to_branch_id,a.serial_id,'transfer_in',1,'branch_transfer',String(transfer.id),req.employee?.id||null,'Serial received at destination branch']});}
            else{await incrementExactBin(tx,a.product_id,transfer.to_branch_id,a.destination_bin_id,take);const r=await tx.execute({sql:`INSERT INTO inventory_lots(product_id,branch_id,bin_id,lot_number,manufacture_date,expiry_date,received_quantity,available_quantity,unit_cost,purchase_receipt_item_id,supplier_id,status) SELECT product_id,?,?,?,?,?,?,?,unit_cost,purchase_receipt_item_id,supplier_id,'available' FROM inventory_lots WHERE id=?`,args:[transfer.to_branch_id,a.destination_bin_id||null,a.lot_number,a.manufacture_date,a.expiry_date,take,take,a.source_lot_id]});const newLotId=Number(r.lastInsertRowid);await tx.execute({sql:`INSERT INTO inventory_identity_events(product_id,branch_id,lot_id,event_type,quantity,reference_type,reference_id,employee_id,details) VALUES(?,?,?,?,?,?,?,?,?)`,args:[a.product_id,transfer.to_branch_id,newLotId,'transfer_in',take,'branch_transfer',String(transfer.id),req.employee?.id||null,`Lot ${a.lot_number} received at destination branch`]});}
            await tx.execute({sql:`UPDATE transfer_identity_allocations SET received_quantity=received_quantity+?,status=CASE WHEN received_quantity+?>=quantity THEN 'received' ELSE status END,received_at=CASE WHEN received_quantity+?>=quantity THEN CURRENT_TIMESTAMP ELSE received_at END WHERE id=?`,args:[take,take,take,a.id]});remain-=take;
          }
        }else{const {syncBinQty}=require('../lib/binSync');await syncBinQty(tx,item.product_id,transfer.to_branch_id,qty);}
        await tx.execute({sql:'UPDATE branch_transfer_items SET quantity_received=quantity_received+? WHERE id=?',args:[qty,id]});await tx.execute({sql:`INSERT INTO branch_inventory(product_id,branch_id,stock_qty,min_stock,updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(product_id,branch_id) DO UPDATE SET stock_qty=stock_qty+?,updated_at=CURRENT_TIMESTAMP`,args:[item.product_id,transfer.to_branch_id,qty,0,qty]});await tx.execute({sql:'UPDATE products SET stock_qty=stock_qty+? WHERE id=?',args:[qty,item.product_id]});await receiveTransferValuation(tx,{transferItemId:id,quantity:qty});
      }
      const {rows:all}=await tx.execute({sql:'SELECT * FROM branch_transfer_items WHERE transfer_id=?',args:[transfer.id]});const complete=all.every(x=>Number(x.quantity_received||0)>=Number(x.quantity_requested));const any=all.some(x=>Number(x.quantity_received||0)>0);await tx.execute({sql:'UPDATE branch_transfers SET status=?,received_at=? WHERE id=?',args:[complete?'received':any?'in_transit':transfer.status,complete?new Date().toISOString():transfer.received_at,transfer.id]});await tx.commit();committed=true;const {rows:[saved]}=await db.execute({sql:'SELECT * FROM branch_transfers WHERE id=?',args:[transfer.id]});const {rows:items}=await db.execute({sql:'SELECT * FROM branch_transfer_items WHERE transfer_id=?',args:[transfer.id]});saved.items=items;res.json(saved);
    }catch(e){if(!committed)await tx.rollback();res.status(400).json({error:e.message});}
  }catch(e){res.status(500).json({error:e.message});}
});

router.patch('/:id/cancel',requirePermission('transfers'),async(req,res)=>{
  try{await ensureSchema();const {rows:[transfer]}=await db.execute({sql:'SELECT * FROM branch_transfers WHERE id=?',args:[req.params.id]});if(!transfer)return res.status(404).json({error:'Transfer not found'});if(['received','cancelled'].includes(transfer.status))return res.status(409).json({error:`Cannot cancel a ${transfer.status} transfer`});
    const tx=await db.transaction('write');let committed=false;try{const {rows:items}=await tx.execute({sql:'SELECT * FROM branch_transfer_items WHERE transfer_id=?',args:[transfer.id]});for(const item of items){const qty=Number(item.quantity_requested)-Number(item.quantity_received||0);if(qty<=0)continue;const {rows:allocs}=await tx.execute({sql:`SELECT * FROM transfer_identity_allocations WHERE transfer_item_id=? AND status='in_transit'`,args:[item.id]});if(allocs.length){for(const a of allocs){const open=Number(a.quantity)-Number(a.received_quantity||0);if(open<=0)continue;if(a.tracking_mode==='serial'){await incrementExactBin(tx,a.product_id,transfer.from_branch_id,a.source_bin_id,1);await tx.execute({sql:`UPDATE inventory_serials SET status='available',branch_id=?,bin_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`,args:[transfer.from_branch_id,a.source_bin_id||null,a.serial_id]});}else{await incrementExactBin(tx,a.product_id,transfer.from_branch_id,a.source_bin_id,open);await tx.execute({sql:'UPDATE inventory_lots SET available_quantity=available_quantity+? WHERE id=?',args:[open,a.source_lot_id]});}await tx.execute({sql:`UPDATE transfer_identity_allocations SET status='cancelled',cancelled_at=CURRENT_TIMESTAMP WHERE id=?`,args:[a.id]});await tx.execute({sql:`INSERT INTO inventory_identity_events(product_id,branch_id,lot_id,serial_id,event_type,quantity,reference_type,reference_id,employee_id,details) VALUES(?,?,?,?,?,?,?,?,?,?)`,args:[a.product_id,transfer.from_branch_id,a.source_lot_id||null,a.serial_id||null,'transfer_cancelled',open,'branch_transfer',String(transfer.id),req.employee?.id||null,'Unreceived tracked inventory restored to source branch']});}}
        else{const {syncBinQty}=require('../lib/binSync');await syncBinQty(tx,item.product_id,transfer.from_branch_id,qty);}await tx.execute({sql:`INSERT INTO branch_inventory(product_id,branch_id,stock_qty,min_stock,updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(product_id,branch_id) DO UPDATE SET stock_qty=stock_qty+?,updated_at=CURRENT_TIMESTAMP`,args:[item.product_id,transfer.from_branch_id,qty,0,qty]});await tx.execute({sql:'UPDATE products SET stock_qty=stock_qty+? WHERE id=?',args:[qty,item.product_id]});await cancelTransferValuation(tx,{transferItemId:item.id,quantity:qty});}await tx.execute({sql:"UPDATE branch_transfers SET status='cancelled' WHERE id=?",args:[transfer.id]});await tx.commit();committed=true;const {rows:[saved]}=await db.execute({sql:'SELECT * FROM branch_transfers WHERE id=?',args:[transfer.id]});res.json(saved);}catch(e){if(!committed)await tx.rollback();res.status(400).json({error:e.message});}
  }catch(e){res.status(500).json({error:e.message});}
});
module.exports=router;
