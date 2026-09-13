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

router.get('/sales-summary', async (req,res) => {
  try {
    const {start,end}=range(req,30); const bf=branch(req,'t');
    const {rows}=await db.execute({sql:`SELECT date(t.created_at) sale_date,COUNT(*) transaction_count,
        COALESCE(SUM(t.subtotal),0) subtotal,COALESCE(SUM(t.discount_amount),0) discounts,COALESCE(SUM(t.tax_amount),0) tax,
        COALESCE(SUM(t.total),0) sales_total,COALESCE(AVG(t.total),0) average_sale,COALESCE(SUM(i.units_sold),0) units_sold
      FROM transactions t LEFT JOIN (SELECT transaction_id,SUM(quantity) units_sold FROM transaction_items GROUP BY transaction_id) i ON i.transaction_id=t.id
      WHERE t.status='completed' AND date(t.created_at) BETWEEN date(?) AND date(?)${bf.clause}
      GROUP BY date(t.created_at) ORDER BY sale_date DESC`,args:[start,end,...bf.args]});
    const summary=rows.reduce((a,r)=>{a.transactions+=Number(r.transaction_count)||0;a.sales_total+=Number(r.sales_total)||0;a.discounts+=Number(r.discounts)||0;a.tax+=Number(r.tax)||0;a.units_sold+=Number(r.units_sold)||0;return a;},{transactions:0,sales_total:0,discounts:0,tax:0,units_sold:0});
    summary.average_sale=summary.transactions?summary.sales_total/summary.transactions:0;res.json({start,end,summary,rows});
  }catch(e){res.status(500).json({error:e.message});}
});

router.get('/payments', async (req,res) => {
  try {
    const {start,end}=range(req,30); const bf=branch(req,'t');
    const {rows}=await db.execute({sql:`SELECT payment_method,COUNT(*) payment_count,COALESCE(SUM(amount),0) amount FROM (
      SELECT COALESCE(tp.payment_method,'Unknown') payment_method,tp.amount,t.id transaction_id FROM transaction_payments tp JOIN transactions t ON t.id=tp.transaction_id WHERE t.status='completed' AND date(t.created_at) BETWEEN date(?) AND date(?)${bf.clause}
      UNION ALL SELECT COALESCE(t.payment_method,'Unknown'),t.total,t.id FROM transactions t WHERE t.status='completed' AND date(t.created_at) BETWEEN date(?) AND date(?)${bf.clause} AND NOT EXISTS(SELECT 1 FROM transaction_payments tp WHERE tp.transaction_id=t.id)
    ) x GROUP BY payment_method ORDER BY amount DESC`,args:[start,end,...bf.args,start,end,...bf.args]});
    const summary=rows.reduce((a,r)=>{a.payment_count+=Number(r.payment_count)||0;a.total_received+=Number(r.amount)||0;return a;},{payment_count:0,total_received:0});res.json({start,end,summary,rows});
  }catch(e){res.status(500).json({error:e.message});}
});

router.get('/employee-sales', async (req,res) => {
  try {
    const {start,end}=range(req,30); const bf=branch(req,'t');
    const {rows}=await db.execute({sql:`SELECT e.id employee_id,e.first_name||' '||e.last_name employee_name,
        COUNT(t.id) transaction_count,COALESCE(SUM(t.total),0) sales_total,COALESCE(AVG(t.total),0) average_sale,
        COALESCE(SUM(t.discount_amount),0) discounts,COALESCE(SUM(i.units_sold),0) units_sold
      FROM transactions t JOIN employees e ON e.id=t.employee_id LEFT JOIN (SELECT transaction_id,SUM(quantity) units_sold FROM transaction_items GROUP BY transaction_id) i ON i.transaction_id=t.id
      WHERE t.status='completed' AND date(t.created_at) BETWEEN date(?) AND date(?)${bf.clause}
      GROUP BY e.id ORDER BY sales_total DESC`,args:[start,end,...bf.args]});
    const summary=rows.reduce((a,r)=>{a.employees+=1;a.transactions+=Number(r.transaction_count)||0;a.sales_total+=Number(r.sales_total)||0;return a;},{employees:0,transactions:0,sales_total:0});res.json({start,end,summary,rows});
  }catch(e){res.status(500).json({error:e.message});}
});

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

router.get('/supplier-performance', async (req,res) => {
  try {
    const {start,end}=range(req,180); const bf=branch(req,'po');
    const {rows}=await db.execute({sql:`SELECT s.id supplier_id,s.name supplier_name,
      COUNT(DISTINCT po.id) purchase_orders,
      COALESCE(SUM(poi.quantity_ordered),0) units_ordered,COALESCE(SUM(poi.quantity_received),0) units_received,
      COALESCE(SUM(COALESCE(poi.quantity_damaged,0)),0) damaged_units,
      COALESCE(AVG(CASE WHEN po.received_at IS NOT NULL THEN julianday(po.received_at)-julianday(po.created_at) END),0) average_lead_days,
      COALESCE(100.0*SUM(CASE WHEN po.status='received' AND po.expected_date IS NOT NULL AND po.received_at IS NOT NULL AND date(po.received_at)<=date(po.expected_date) THEN 1 ELSE 0 END)/NULLIF(SUM(CASE WHEN po.status='received' THEN 1 ELSE 0 END),0),0) on_time_rate,
      COALESCE(100.0*(CASE WHEN SUM(poi.quantity_received)<SUM(poi.quantity_ordered) THEN SUM(poi.quantity_received) ELSE SUM(poi.quantity_ordered) END)/NULLIF(SUM(poi.quantity_ordered),0),0) fill_rate,
      COALESCE(100.0*(SUM(poi.quantity_received)-SUM(COALESCE(poi.quantity_damaged,0)))/NULLIF(SUM(poi.quantity_received),0),0) quality_acceptance_rate
      FROM suppliers s LEFT JOIN purchase_orders po ON po.supplier_id=s.id AND date(po.created_at) BETWEEN date(?) AND date(?)${bf.clause}
      LEFT JOIN purchase_order_items poi ON poi.po_id=po.id WHERE s.active=1 GROUP BY s.id,s.name ORDER BY s.name`,args:[start,end,...bf.args]});
    const salesBf=branch(req,'t');
    const {rows:sales}=await db.execute({sql:`SELECT p.supplier_id,COALESCE(SUM(ti.quantity),0) units_sold,COALESCE(SUM(ti.total),0) sales_value,
      COALESCE(SUM(ti.quantity*(ti.unit_price-COALESCE(p.cost,0))),0) estimated_gross_profit
      FROM transaction_items ti JOIN transactions t ON t.id=ti.transaction_id JOIN products p ON p.id=ti.product_id
      WHERE t.status='completed' AND p.supplier_id IS NOT NULL AND date(t.created_at) BETWEEN date(?) AND date(?)${salesBf.clause} GROUP BY p.supplier_id`,args:[start,end,...salesBf.args]});
    const returnBf=branch(req,'r');
    const {rows:returns}=await db.execute({sql:`SELECT p.supplier_id,COALESCE(SUM(ri.quantity),0) units_returned FROM return_items ri JOIN returns r ON r.id=ri.return_id JOIN products p ON p.id=ri.product_id WHERE r.status='processed' AND p.supplier_id IS NOT NULL AND date(r.created_at) BETWEEN date(?) AND date(?)${returnBf.clause} GROUP BY p.supplier_id`,args:[start,end,...returnBf.args]});
    const saleMap=new Map(sales.map(x=>[Number(x.supplier_id),x])),returnMap=new Map(returns.map(x=>[Number(x.supplier_id),x]));
    for(const r of rows){const sale=saleMap.get(Number(r.supplier_id))||{},ret=returnMap.get(Number(r.supplier_id))||{};r.units_sold=Number(sale.units_sold||0);r.sales_value=Number(sale.sales_value||0);r.estimated_gross_profit=Number(sale.estimated_gross_profit||0);r.units_returned=Number(ret.units_returned||0);r.customer_return_rate=r.units_sold>0?Number((100*r.units_returned/r.units_sold).toFixed(2)):0;r.effective_fulfillment=Number(((Number(r.on_time_rate||0)+Number(r.fill_rate||0)+Number(r.quality_acceptance_rate||0))/3).toFixed(2));const returnScore=Math.max(0,100-Math.min(100,r.customer_return_rate*10));r.overall_rating_score=Number((Number(r.on_time_rate||0)*0.30+Number(r.fill_rate||0)*0.30+Number(r.quality_acceptance_rate||0)*0.25+returnScore*0.15).toFixed(2));r.supplier_rating=r.overall_rating_score>=90?'Excellent':r.overall_rating_score>=80?'Good':r.overall_rating_score>=65?'Needs attention':'Poor';}
    const summary={suppliers:rows.length,sales_value:rows.reduce((a,r)=>a+r.sales_value,0),estimated_gross_profit:rows.reduce((a,r)=>a+r.estimated_gross_profit,0),units_sold:rows.reduce((a,r)=>a+r.units_sold,0),units_returned:rows.reduce((a,r)=>a+r.units_returned,0)};
    res.json({start,end,summary,rows,note:'Supplier rating combines on-time delivery, fill rate and received-goods quality. Customer return rate is shown separately and affects the plain-language rating. Estimated gross profit uses the product cost available to the POS and is not a substitute for audited landed-cost profitability.'});
  }catch(e){res.status(500).json({error:e.message});}
});

router.get('/supplier-items', async (req,res) => {
  try {
    const {start,end}=range(req,90); const bf=branch(req,'t');
    const {rows}=await db.execute({sql:`SELECT s.id supplier_id,s.name supplier_name,p.id product_id,p.sku,p.name product_name,p.cost,p.price,
      COALESCE(SUM(CASE WHEN t.status='completed' THEN ti.quantity ELSE 0 END),0) units_sold,
      COALESCE(SUM(CASE WHEN t.status='completed' THEN ti.total ELSE 0 END),0) sales_value,
      COALESCE(SUM(CASE WHEN t.status='completed' THEN ti.quantity*(ti.unit_price-COALESCE(p.cost,0)) ELSE 0 END),0) estimated_gross_profit,
      MAX(CASE WHEN t.status='completed' THEN t.created_at END) last_sale_at
      FROM products p JOIN suppliers s ON s.id=p.supplier_id LEFT JOIN transaction_items ti ON ti.product_id=p.id
      LEFT JOIN transactions t ON t.id=ti.transaction_id AND date(t.created_at) BETWEEN date(?) AND date(?)${bf.clause}
      WHERE p.active=1 GROUP BY s.id,p.id ORDER BY s.name,sales_value DESC`,args:[start,end,...bf.args]});
    res.json({start,end,summary:{items:rows.length,sales_value:rows.reduce((a,r)=>a+Number(r.sales_value||0),0),estimated_gross_profit:rows.reduce((a,r)=>a+Number(r.estimated_gross_profit||0),0)},rows,note:'Estimated gross profit uses the product cost available to the POS. Use accounting reports for audited profitability.'});
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
    {id:'sales-summary',group:'Sales & Payments',label:'Sales Summary',description:'Daily sales totals, discounts, tax, units sold and average sale.'},
    {id:'payments',group:'Sales & Payments',label:'Payments by Method',description:'How customers paid and how much was received by each payment method.'},
    {id:'employee-sales',group:'Sales & Payments',label:'Sales by Employee',description:'Completed sales, units and discounts processed by each employee.'},
    {id:'inventory-movements',group:'Inventory',label:'Stock Movement History',description:'Every recorded increase and decrease in stock with its reason and branch.'},
    {id:'non-sale-reductions',group:'Inventory',label:'Stock Removed Outside Sales',description:'Stock reductions that were not recorded as normal POS sales.'},
    {id:'damage-writeoff',group:'Inventory',label:'Damaged & Written-Off Stock',description:'Damaged receiving and stock written off during the selected period.'},
    {id:'stock-aging',group:'Inventory',label:'Slow & Non-Moving Stock',description:'Items tying up cash because they are selling slowly or not at all.'},
    {id:'transfers',group:'Inventory',label:'Branch Transfers',description:'Stock sent between branches, including quantities still outstanding.'},
    {id:'purchasing',group:'Purchasing',label:'Purchase Orders & Receiving',description:'Orders placed with suppliers, what arrived, damage and outstanding value.'},
    {id:'supplier-performance',group:'Supplier Performance',label:'Supplier Performance & Rating',description:'Lead time, on-time delivery, fill rate, quality, returns, sales, profit contribution and an explainable supplier rating.'},
    {id:'supplier-items',group:'Supplier Performance',label:'Supplier Items, Sales & Profitability',description:'Items supplied, units sold, sales value and estimated gross profit by supplier and product.'},
    {id:'vendor-items',group:'Supplier Performance',label:'Supplier Item Sales (Legacy View)',description:'Legacy supplier-item contribution view kept for continuity.'},
    {id:'rentals',group:'Rentals & Repairs',label:'Rental Activity',description:'Rental status, fees, deposits, returns and damage charges.'},
    {id:'repairs',group:'Rentals & Repairs',label:'Repair & Work Order Activity',description:'Work-order status, parts, labour estimates, tasks and time recorded.'},
    {id:'returns',group:'Returns',label:'Returns & Refunds',description:'Customer returns, refunded transactions and quantities returned.'}
  ]);
});

module.exports=router;
