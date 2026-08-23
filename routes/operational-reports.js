const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission } = require('../lib/permissions');

router.use(requirePermission('reports'));

function range(req, fallbackDays = 90) {
  const end = String(req.query.end || new Date().toISOString().slice(0,10));
  const start = String(req.query.start || new Date(Date.now() - fallbackDays * 86400000).toISOString().slice(0,10));
  return { start, end };
}
function branch(req, alias = '') {
  const id = req.query.branch_id ? Number(req.query.branch_id) : null;
  const col = alias ? `${alias}.branch_id` : 'branch_id';
  return { clause: id ? ` AND ${col} = ?` : '', args: id ? [id] : [] };
}

router.get('/inventory-movements', async (req,res) => {
  try {
    const {start,end}=range(req,30); const bf=branch(req,'sm');
    const {rows}=await db.execute({sql:`SELECT sm.*,p.sku,p.name AS product_name,b.name AS branch_name
      FROM stock_movements sm JOIN products p ON p.id=sm.product_id LEFT JOIN branches b ON b.id=sm.branch_id
      WHERE date(sm.created_at) BETWEEN date(?) AND date(?)${bf.clause}
      ORDER BY sm.created_at DESC,sm.id DESC`,args:[start,end,...bf.args]});
    const totals=rows.reduce((a,r)=>{const q=Number(r.quantity_change)||0;a.net+=q;if(q>0)a.in+=q;if(q<0)a.out+=Math.abs(q);return a;},{in:0,out:0,net:0});
    res.json({start,end,totals,rows});
  }catch(e){res.status(500).json({error:e.message});}
});

router.get('/non-sale-reductions', async (req,res) => {
  try {
    const {start,end}=range(req,90); const bf=branch(req,'sm');
    const {rows}=await db.execute({sql:`SELECT sm.*,p.sku,p.name AS product_name,b.name AS branch_name,
        ABS(sm.quantity_change)*COALESCE(p.cost,0) AS estimated_cost_value
      FROM stock_movements sm JOIN products p ON p.id=sm.product_id LEFT JOIN branches b ON b.id=sm.branch_id
      WHERE sm.quantity_change<0 AND date(sm.created_at) BETWEEN date(?) AND date(?)${bf.clause}
        AND lower(COALESCE(sm.type,'')) NOT IN ('sale','pos_sale','transaction_sale')
      ORDER BY sm.created_at DESC`,args:[start,end,...bf.args]});
    const {rows:[summary]}=await db.execute({sql:`SELECT COUNT(*) AS movement_count,COALESCE(SUM(ABS(sm.quantity_change)),0) AS units_removed,
        COALESCE(SUM(ABS(sm.quantity_change)*COALESCE(p.cost,0)),0) AS estimated_cost_value
      FROM stock_movements sm JOIN products p ON p.id=sm.product_id
      WHERE sm.quantity_change<0 AND date(sm.created_at) BETWEEN date(?) AND date(?)${bf.clause}
        AND lower(COALESCE(sm.type,'')) NOT IN ('sale','pos_sale','transaction_sale')`,args:[start,end,...bf.args]});
    res.json({start,end,summary,rows,note:'Includes negative stock movements not explicitly typed as a POS sale. Review movement type/reason before treating every row as shrinkage.'});
  }catch(e){res.status(500).json({error:e.message});}
});

router.get('/damage-writeoff', async (req,res) => {
  try {
    const {start,end}=range(req,180); const bf=branch(req,'sm');
    const {rows:movements}=await db.execute({sql:`SELECT sm.*,p.sku,p.name AS product_name,b.name AS branch_name,
        ABS(sm.quantity_change)*COALESCE(p.cost,0) AS estimated_cost_value
      FROM stock_movements sm JOIN products p ON p.id=sm.product_id LEFT JOIN branches b ON b.id=sm.branch_id
      WHERE date(sm.created_at) BETWEEN date(?) AND date(?)${bf.clause}
        AND (lower(COALESCE(sm.type,'')) LIKE '%damage%' OR lower(COALESCE(sm.type,'')) LIKE '%write%off%' OR lower(COALESCE(sm.reason,'')) LIKE '%damage%' OR lower(COALESCE(sm.reason,'')) LIKE '%write%off%')
      ORDER BY sm.created_at DESC`,args:[start,end,...bf.args]});
    const pobf=branch(req,'po');
    const {rows:receiving}=await db.execute({sql:`SELECT po.po_number,po.created_at,po.received_at,s.name AS supplier_name,b.name AS branch_name,
        poi.product_name,poi.sku,poi.quantity_ordered,poi.quantity_received,COALESCE(poi.quantity_damaged,0) AS quantity_damaged,poi.damage_notes,poi.unit_cost,
        COALESCE(poi.quantity_damaged,0)*poi.unit_cost AS damaged_cost_value
      FROM purchase_order_items poi JOIN purchase_orders po ON po.id=poi.po_id LEFT JOIN suppliers s ON s.id=po.supplier_id LEFT JOIN branches b ON b.id=po.branch_id
      WHERE COALESCE(poi.quantity_damaged,0)>0 AND date(COALESCE(po.received_at,po.created_at)) BETWEEN date(?) AND date(?)${pobf.clause}
      ORDER BY COALESCE(po.received_at,po.created_at) DESC`,args:[start,end,...pobf.args]});
    res.json({start,end,movements,receiving});
  }catch(e){res.status(500).json({error:e.message});}
});

router.get('/stock-aging', async (req,res) => {
  try {
    const bf=branch(req,'bi'); const lookback=Math.min(365,Math.max(30,Number(req.query.lookback_days)||90));
    const {rows}=await db.execute({sql:`SELECT p.id AS product_id,p.sku,p.name AS product_name,b.id AS branch_id,b.name AS branch_name,
        bi.stock_qty,bi.min_stock,p.cost,p.price,bi.stock_qty*COALESCE(p.cost,0) AS inventory_cost,
        COALESCE(s.units_sold,0) AS units_sold, s.last_sale_at,
        CASE WHEN COALESCE(s.units_sold,0)>0 THEN ROUND(bi.stock_qty/(s.units_sold*1.0/?),1) ELSE NULL END AS days_cover,
        CASE WHEN COALESCE(s.units_sold,0)=0 THEN 'non_moving'
             WHEN bi.stock_qty/(s.units_sold*1.0/?)>=90 THEN 'slow_moving' ELSE 'moving' END AS movement_class
      FROM branch_inventory bi JOIN products p ON p.id=bi.product_id JOIN branches b ON b.id=bi.branch_id
      LEFT JOIN (SELECT ti.product_id,t.branch_id,SUM(CASE WHEN ti.quantity>0 THEN ti.quantity ELSE 0 END) units_sold,MAX(t.created_at) last_sale_at
        FROM transaction_items ti JOIN transactions t ON t.id=ti.transaction_id
        WHERE t.status='completed' AND date(t.created_at)>=date('now',?) GROUP BY ti.product_id,t.branch_id) s
        ON s.product_id=bi.product_id AND s.branch_id=bi.branch_id
      WHERE p.active=1 AND bi.stock_qty>0${bf.clause}
      ORDER BY CASE WHEN COALESCE(s.units_sold,0)=0 THEN 0 WHEN bi.stock_qty/(s.units_sold*1.0/?)>=90 THEN 1 ELSE 2 END,inventory_cost DESC`,
      args:[lookback,lookback,`-${lookback} days`,...bf.args,lookback]});
    const summary=rows.reduce((a,r)=>{a.total_cost+=Number(r.inventory_cost)||0;if(r.movement_class==='non_moving'){a.non_moving_skus++;a.non_moving_cost+=Number(r.inventory_cost)||0;}if(r.movement_class==='slow_moving'){a.slow_moving_skus++;a.slow_moving_cost+=Number(r.inventory_cost)||0;}return a;},{total_cost:0,non_moving_skus:0,non_moving_cost:0,slow_moving_skus:0,slow_moving_cost:0});
    res.json({lookback_days:lookback,summary,rows});
  }catch(e){res.status(500).json({error:e.message});}
});

router.get('/transfers', async (req,res) => {
  try {
    const {start,end}=range(req,90); const id=req.query.branch_id?Number(req.query.branch_id):null;
    const {rows}=await db.execute({sql:`SELECT t.*,fb.name from_branch_name,tb.name to_branch_name,e.first_name||' '||e.last_name employee_name,
        COUNT(i.id) line_count,COALESCE(SUM(i.quantity_requested),0) units_requested,COALESCE(SUM(i.quantity_received),0) units_received,
        COALESCE(SUM((i.quantity_requested-i.quantity_received)*COALESCE(p.cost,0)),0) outstanding_cost_value
      FROM branch_transfers t LEFT JOIN branches fb ON fb.id=t.from_branch_id LEFT JOIN branches tb ON tb.id=t.to_branch_id LEFT JOIN employees e ON e.id=t.employee_id
      LEFT JOIN branch_transfer_items i ON i.transfer_id=t.id LEFT JOIN products p ON p.id=i.product_id
      WHERE date(t.created_at) BETWEEN date(?) AND date(?) ${id?'AND (t.from_branch_id=? OR t.to_branch_id=?)':''}
      GROUP BY t.id ORDER BY t.created_at DESC`,args:[start,end,...(id?[id,id]:[])]});
    res.json({start,end,rows});
  }catch(e){res.status(500).json({error:e.message});}
});

router.get('/purchasing', async (req,res) => {
  try {
    const {start,end}=range(req,180); const bf=branch(req,'po');
    const {rows}=await db.execute({sql:`SELECT po.id,po.po_number,po.status,po.created_at,po.expected_date,po.received_at,po.total,s.name supplier_name,b.name branch_name,
        COALESCE(SUM(poi.quantity_ordered),0) units_ordered,COALESCE(SUM(poi.quantity_received),0) units_received,COALESCE(SUM(poi.quantity_damaged),0) units_damaged,
        COALESCE(SUM((poi.quantity_ordered-poi.quantity_received)*poi.unit_cost),0) outstanding_value
      FROM purchase_orders po LEFT JOIN suppliers s ON s.id=po.supplier_id LEFT JOIN branches b ON b.id=po.branch_id LEFT JOIN purchase_order_items poi ON poi.po_id=po.id
      WHERE date(po.created_at) BETWEEN date(?) AND date(?)${bf.clause}
      GROUP BY po.id ORDER BY po.created_at DESC`,args:[start,end,...bf.args]});
    res.json({start,end,rows});
  }catch(e){res.status(500).json({error:e.message});}
});

router.get('/vendor-items', async (req,res) => {
  try {
    const {start,end}=range(req,90); const bf=branch(req,'t');
    const {rows}=await db.execute({sql:`SELECT s.id supplier_id,s.name supplier_name,p.id product_id,p.sku,p.name product_name,p.cost,p.price,
        COALESCE(SUM(CASE WHEN t.status='completed' THEN ti.quantity ELSE 0 END),0) units_sold,
        COALESCE(SUM(CASE WHEN t.status='completed' THEN ti.total ELSE 0 END),0) sales_value,
        COALESCE(SUM(CASE WHEN t.status='completed' THEN ti.quantity*(ti.unit_price-COALESCE(p.cost,0)) ELSE 0 END),0) catalog_margin_proxy,
        MAX(CASE WHEN t.status='completed' THEN t.created_at END) last_sale_at
      FROM products p JOIN suppliers s ON s.id=p.supplier_id
      LEFT JOIN transaction_items ti ON ti.product_id=p.id LEFT JOIN transactions t ON t.id=ti.transaction_id AND date(t.created_at) BETWEEN date(?) AND date(?)${bf.clause}
      WHERE p.active=1 GROUP BY s.id,p.id ORDER BY s.name,sales_value DESC`,args:[start,end,...bf.args]});
    res.json({start,end,rows,note:'Margin is a catalog-cost proxy, not landed/accounting profit.'});
  }catch(e){res.status(500).json({error:e.message});}
});

router.get('/rentals', async (req,res) => {
  try {
    const {start,end}=range(req,90); const bf=branch(req,'ra');
    const {rows}=await db.execute({sql:`SELECT ra.id,ra.agreement_number,ra.status,ra.checkout_date,ra.due_date,ra.returned_at,c.first_name||' '||c.last_name customer_name,b.name branch_name,
        ra.deposit_total,ra.deposit_refunded,ra.late_fee_total,ra.damage_fee_total,ra.duration_adjustment_total,ra.tax_adjustment_total,
        COALESCE(SUM(rai.final_rental_fee),0) rental_fee,COALESCE(SUM(rai.damage_fee),0) item_damage_fee,
        COALESCE(SUM(rai.quantity),0) units_rented,COALESCE(SUM(rai.quantity_returned),0) units_returned
      FROM rental_agreements ra JOIN customers c ON c.id=ra.customer_id LEFT JOIN branches b ON b.id=ra.branch_id LEFT JOIN rental_agreement_items rai ON rai.agreement_id=ra.id
      WHERE date(ra.created_at) BETWEEN date(?) AND date(?)${bf.clause} GROUP BY ra.id ORDER BY ra.created_at DESC`,args:[start,end,...bf.args]});
    res.json({start,end,rows});
  }catch(e){res.status(500).json({error:e.message});}
});

router.get('/repairs', async (req,res) => {
  try {
    const {start,end}=range(req,90); const bf=branch(req,'wo');
    const {rows}=await db.execute({sql:`SELECT wo.id,wo.wo_number,wo.status,wo.created_at,wo.completed_at,wo.picked_up_at,wo.pickup_due_date,c.first_name||' '||c.last_name customer_name,b.name branch_name,
        wo.assessment_fee,wo.estimate_labor,wo.estimate_consumables,wo.deposit_amount,
        COALESCE(parts.parts_total,0) parts_total,COALESCE(tasks.task_count,0) task_count,COALESCE(tasks.completed_tasks,0) completed_tasks,COALESCE(tasks.actual_minutes,0) actual_minutes
      FROM work_orders wo JOIN customers c ON c.id=wo.customer_id LEFT JOIN branches b ON b.id=wo.branch_id
      LEFT JOIN (SELECT work_order_id,SUM(total) parts_total FROM work_order_items GROUP BY work_order_id) parts ON parts.work_order_id=wo.id
      LEFT JOIN (SELECT t.work_order_id,COUNT(*) task_count,SUM(CASE WHEN t.status='complete' THEN 1 ELSE 0 END) completed_tasks,
          SUM(COALESCE(te.actual_minutes,0)) actual_minutes FROM work_order_tasks t LEFT JOIN (SELECT task_id,SUM((julianday(ended_at)-julianday(started_at))*24*60) actual_minutes FROM work_order_task_time_entries WHERE ended_at IS NOT NULL GROUP BY task_id) te ON te.task_id=t.id GROUP BY t.work_order_id) tasks ON tasks.work_order_id=wo.id
      WHERE date(wo.created_at) BETWEEN date(?) AND date(?)${bf.clause} ORDER BY wo.created_at DESC`,args:[start,end,...bf.args]});
    res.json({start,end,rows});
  }catch(e){res.status(500).json({error:e.message});}
});

router.get('/returns', async (req,res) => {
  try {
    const {start,end}=range(req,90); const bf=branch(req,'r');
    const {rows}=await db.execute({sql:`SELECT r.*,c.first_name||' '||c.last_name customer_name,b.name branch_name,t.transaction_number original_transaction_number,
        COALESCE(SUM(ri.quantity),0) units_returned
      FROM returns r LEFT JOIN customers c ON c.id=r.customer_id LEFT JOIN branches b ON b.id=r.branch_id LEFT JOIN transactions t ON t.id=r.original_transaction_id LEFT JOIN return_items ri ON ri.return_id=r.id
      WHERE date(r.created_at) BETWEEN date(?) AND date(?)${bf.clause} GROUP BY r.id ORDER BY r.created_at DESC`,args:[start,end,...bf.args]});
    res.json({start,end,rows});
  }catch(e){res.status(500).json({error:e.message});}
});

router.get('/catalog', async (req,res) => {
  res.json([
    {id:'inventory-movements',label:'Inventory movements'},{id:'non-sale-reductions',label:'Inventory removed outside POS sales'},
    {id:'damage-writeoff',label:'Damaged / write-off inventory'},{id:'stock-aging',label:'Slow & non-moving stock'},
    {id:'transfers',label:'Branch transfers'},{id:'purchasing',label:'Purchasing / receiving'},
    {id:'vendor-items',label:'Vendor item sales & contribution'},{id:'rentals',label:'Rentals'},
    {id:'repairs',label:'Repairs / work orders'},{id:'returns',label:'Returns / refunds'}
  ]);
});

module.exports=router;
