const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission } = require('../lib/permissions');
const { syncBinQty } = require('../lib/binSync');

let schemaReady = false;
async function ensureSchema(){
  if(schemaReady) return;
  await db.execute({sql:`CREATE TABLE IF NOT EXISTS repair_part_reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    work_order_id INTEGER NOT NULL,
    work_order_item_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    branch_id INTEGER NOT NULL,
    quantity_reserved INTEGER NOT NULL DEFAULT 0,
    quantity_consumed INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    created_by INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(work_order_item_id, branch_id)
  )`,args:[]});
  await db.execute({sql:`CREATE TABLE IF NOT EXISTS repair_part_usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    work_order_id INTEGER NOT NULL,
    work_order_item_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    branch_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    employee_id INTEGER,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,args:[]});
  await db.execute({sql:'CREATE INDEX IF NOT EXISTS idx_rpr_work_order ON repair_part_reservations(work_order_id,status)',args:[]});
  await db.execute({sql:'CREATE INDEX IF NOT EXISTS idx_rpu_work_order ON repair_part_usage_events(work_order_id,created_at)',args:[]});
  schemaReady=true;
}
router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Repair parts integrity schema initialization failed',detail:e.message});}});

async function overview(workOrderId){
  const {rows:[wo]}=await db.execute({sql:'SELECT id,wo_number,branch_id,status FROM work_orders WHERE id = ?',args:[workOrderId]});
  if(!wo) return null;
  const {rows:items}=await db.execute({sql:`SELECT woi.*, p.stock_qty as global_stock_qty,
    COALESCE((SELECT stock_qty FROM branch_inventory WHERE product_id = woi.product_id AND branch_id = wo.branch_id),0) as home_stock_qty,
    COALESCE((SELECT SUM(quantity_reserved-quantity_consumed) FROM repair_part_reservations r WHERE r.product_id=woi.product_id AND r.branch_id=wo.branch_id AND r.status='active' AND r.work_order_id != wo.id),0) as reserved_elsewhere,
    COALESCE((SELECT SUM(quantity_reserved) FROM repair_part_reservations r WHERE r.work_order_item_id=woi.id AND r.status='active'),0) as reserved_for_item,
    COALESCE((SELECT SUM(quantity_consumed) FROM repair_part_reservations r WHERE r.work_order_item_id=woi.id),0) as consumed_for_item,
    COALESCE((SELECT SUM(CASE WHEN u.event_type='return' THEN u.quantity ELSE 0 END) FROM repair_part_usage_events u WHERE u.work_order_item_id=woi.id),0) as returned_for_item
    FROM work_order_items woi JOIN work_orders wo ON wo.id=woi.work_order_id LEFT JOIN products p ON p.id=woi.product_id
    WHERE woi.work_order_id=? ORDER BY woi.id`,args:[workOrderId]});
  for(const item of items){
    item.available_to_promise = item.product_id ? Math.max(0, Number(item.home_stock_qty||0)-Number(item.reserved_elsewhere||0)) : 0;
    item.shortage = item.is_customer_supplied ? 0 : Math.max(0, Number(item.quantity||0)-Number(item.reserved_for_item||0)-Number(item.consumed_for_item||0));
    item.integrity_status = item.is_customer_supplied ? 'customer_supplied' : !item.product_id ? 'purchase_required' : item.shortage>0 ? (item.available_to_promise>0?'partially_available':'shortage') : 'covered';
  }
  const {rows:events}=await db.execute({sql:`SELECT u.*,p.name as product_name,b.name as branch_name,e.first_name||' '||e.last_name as employee_name
    FROM repair_part_usage_events u LEFT JOIN products p ON p.id=u.product_id LEFT JOIN branches b ON b.id=u.branch_id LEFT JOIN employees e ON e.id=u.employee_id
    WHERE u.work_order_id=? ORDER BY u.created_at DESC,u.id DESC LIMIT 100`,args:[workOrderId]});
  return {work_order:wo,items,events,summary:{lines:items.length,shortage_lines:items.filter(i=>i.shortage>0&&!i.is_customer_supplied).length,covered_lines:items.filter(i=>i.integrity_status==='covered').length,consumed_units:items.reduce((s,i)=>s+Number(i.consumed_for_item||0),0)}};
}

router.get('/work-orders/:id',requirePermission('work_orders'),async(req,res)=>{try{const data=await overview(req.params.id);if(!data)return res.status(404).json({error:'Work order not found'});res.json(data);}catch(e){res.status(500).json({error:e.message});}});

router.post('/work-orders/:id/reserve',requirePermission('wo_assign_parts'),async(req,res)=>{
  const {work_order_item_id,branch_id,quantity,employee_id}=req.body||{};
  const qty=parseInt(quantity); if(!work_order_item_id||!branch_id||!qty||qty<=0)return res.status(400).json({error:'work_order_item_id, branch_id and positive quantity are required'});
  const tx=await db.transaction('write'); let committed=false;
  try{
    const {rows:[item]}=await tx.execute({sql:'SELECT woi.*,wo.status FROM work_order_items woi JOIN work_orders wo ON wo.id=woi.work_order_id WHERE woi.id=? AND woi.work_order_id=?',args:[work_order_item_id,req.params.id]});
    if(!item) throw new Error('Work order part not found'); if(!item.product_id) throw new Error('Only catalog parts can be reserved'); if(item.is_customer_supplied) throw new Error('Customer-supplied parts are not inventory-reserved');
    const {rows:[stock]}=await tx.execute({sql:'SELECT COALESCE(stock_qty,0) as stock_qty FROM branch_inventory WHERE product_id=? AND branch_id=?',args:[item.product_id,branch_id]});
    const {rows:[other]}=await tx.execute({sql:`SELECT COALESCE(SUM(quantity_reserved-quantity_consumed),0) as q FROM repair_part_reservations WHERE product_id=? AND branch_id=? AND status='active' AND work_order_item_id != ?`,args:[item.product_id,branch_id,work_order_item_id]});
    const available=Number(stock?.stock_qty||0)-Number(other?.q||0); if(qty>available) throw new Error(`Only ${Math.max(0,available)} units are available to reserve at this branch`);
    const remaining=Math.max(0,Number(item.quantity||0)); if(qty>remaining) throw new Error(`Reservation cannot exceed required quantity ${remaining}`);
    await tx.execute({sql:`INSERT INTO repair_part_reservations (work_order_id,work_order_item_id,product_id,branch_id,quantity_reserved,created_by)
      VALUES (?,?,?,?,?,?) ON CONFLICT(work_order_item_id,branch_id) DO UPDATE SET quantity_reserved=excluded.quantity_reserved,status='active',updated_at=CURRENT_TIMESTAMP`,args:[req.params.id,work_order_item_id,item.product_id,branch_id,qty,employee_id||null]});
    await tx.commit(); committed=true; res.json(await overview(req.params.id));
  }catch(e){if(!committed)await tx.rollback();res.status(400).json({error:e.message});}
});

router.post('/work-orders/:id/release',requirePermission('wo_assign_parts'),async(req,res)=>{
  try{const {work_order_item_id,branch_id}=req.body||{};const {rows:[r]}=await db.execute({sql:'SELECT * FROM repair_part_reservations WHERE work_order_id=? AND work_order_item_id=? AND branch_id=?',args:[req.params.id,work_order_item_id,branch_id]});if(!r)return res.status(404).json({error:'Reservation not found'});if(Number(r.quantity_consumed||0)>0)return res.status(400).json({error:'Consumed quantity cannot be released; return it first if it was unused'});await db.execute({sql:"UPDATE repair_part_reservations SET status='released',quantity_reserved=0,updated_at=CURRENT_TIMESTAMP WHERE id=?",args:[r.id]});res.json(await overview(req.params.id));}catch(e){res.status(400).json({error:e.message});}
});

router.post('/work-orders/:id/consume',requirePermission('wo_assign_parts'),async(req,res)=>{
  const {work_order_item_id,branch_id,quantity,employee_id,reason}=req.body||{};const qty=parseInt(quantity);if(!work_order_item_id||!branch_id||!qty||qty<=0)return res.status(400).json({error:'work_order_item_id, branch_id and positive quantity are required'});
  const tx=await db.transaction('write');let committed=false;
  try{
    const {rows:[r]}=await tx.execute({sql:'SELECT * FROM repair_part_reservations WHERE work_order_id=? AND work_order_item_id=? AND branch_id=? AND status=\'active\'',args:[req.params.id,work_order_item_id,branch_id]});if(!r)throw new Error('Reserve this part before consuming it');
    const remaining=Number(r.quantity_reserved)-Number(r.quantity_consumed);if(qty>remaining)throw new Error(`Only ${remaining} reserved units remain available to consume`);
    const {rows:[stock]}=await tx.execute({sql:'SELECT COALESCE(stock_qty,0) as stock_qty FROM branch_inventory WHERE product_id=? AND branch_id=?',args:[r.product_id,branch_id]});if(Number(stock?.stock_qty||0)<qty)throw new Error('Branch stock changed and is no longer sufficient; review the reservation before consuming');
    await tx.execute({sql:'UPDATE branch_inventory SET stock_qty=stock_qty-?,updated_at=CURRENT_TIMESTAMP WHERE product_id=? AND branch_id=?',args:[qty,r.product_id,branch_id]});
    await syncBinQty(tx,r.product_id,branch_id,-qty);
    await tx.execute({sql:'UPDATE products SET stock_qty=MAX(0,stock_qty-?) WHERE id=?',args:[qty,r.product_id]});
    await tx.execute({sql:'UPDATE repair_part_reservations SET quantity_consumed=quantity_consumed+?,updated_at=CURRENT_TIMESTAMP WHERE id=?',args:[qty,r.id]});
    await tx.execute({sql:`INSERT INTO repair_part_usage_events (work_order_id,work_order_item_id,product_id,branch_id,event_type,quantity,employee_id,reason) VALUES (?,?,?,?,?,?,?,?)`,args:[req.params.id,work_order_item_id,r.product_id,branch_id,'consume',qty,employee_id||null,reason||null]});
    await tx.execute({sql:`INSERT INTO stock_movements (product_id,branch_id,quantity_change,type,reference,reason) VALUES (?,?,?,?,?,?)`,args:[r.product_id,branch_id,-qty,'repair_usage',`WO:${req.params.id}`,reason||'Consumed on repair']});
    await tx.commit();committed=true;res.json(await overview(req.params.id));
  }catch(e){if(!committed)await tx.rollback();res.status(400).json({error:e.message});}
});

router.post('/work-orders/:id/return',requirePermission('wo_assign_parts'),async(req,res)=>{
  const {work_order_item_id,branch_id,quantity,employee_id,reason}=req.body||{};const qty=parseInt(quantity);if(!work_order_item_id||!branch_id||!qty||qty<=0)return res.status(400).json({error:'work_order_item_id, branch_id and positive quantity are required'});
  const tx=await db.transaction('write');let committed=false;
  try{
    const {rows:[r]}=await tx.execute({sql:'SELECT * FROM repair_part_reservations WHERE work_order_id=? AND work_order_item_id=? AND branch_id=?',args:[req.params.id,work_order_item_id,branch_id]});if(!r)throw new Error('Reservation not found');if(qty>Number(r.quantity_consumed||0))throw new Error(`Cannot return more than ${r.quantity_consumed||0} consumed units`);
    await tx.execute({sql:`INSERT INTO branch_inventory (product_id,branch_id,stock_qty,min_stock,updated_at) VALUES (?,?,?,(SELECT min_stock FROM products WHERE id=?),CURRENT_TIMESTAMP) ON CONFLICT(product_id,branch_id) DO UPDATE SET stock_qty=stock_qty+?,updated_at=CURRENT_TIMESTAMP`,args:[r.product_id,branch_id,qty,r.product_id,qty]});
    await syncBinQty(tx,r.product_id,branch_id,qty);await tx.execute({sql:'UPDATE products SET stock_qty=stock_qty+? WHERE id=?',args:[qty,r.product_id]});
    await tx.execute({sql:'UPDATE repair_part_reservations SET quantity_consumed=MAX(0,quantity_consumed-?),updated_at=CURRENT_TIMESTAMP WHERE id=?',args:[qty,r.id]});
    await tx.execute({sql:`INSERT INTO repair_part_usage_events (work_order_id,work_order_item_id,product_id,branch_id,event_type,quantity,employee_id,reason) VALUES (?,?,?,?,?,?,?,?)`,args:[req.params.id,work_order_item_id,r.product_id,branch_id,'return',qty,employee_id||null,reason||null]});
    await tx.execute({sql:`INSERT INTO stock_movements (product_id,branch_id,quantity_change,type,reference,reason) VALUES (?,?,?,?,?,?)`,args:[r.product_id,branch_id,qty,'repair_return',`WO:${req.params.id}`,reason||'Unused repair part returned']});
    await tx.commit();committed=true;res.json(await overview(req.params.id));
  }catch(e){if(!committed)await tx.rollback();res.status(400).json({error:e.message});}
});

module.exports=router;
