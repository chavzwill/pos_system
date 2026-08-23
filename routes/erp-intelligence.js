const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requireAnyPermission } = require('../lib/permissions');

router.use(requireAnyPermission('dashboard', 'reports', 'inventory', 'purchasing', 'work_orders'));

function push(alerts, severity, type, title, detail, entity = {}) {
  alerts.push({ severity, type, title, detail, entity });
}

router.get('/alerts', async (req, res) => {
  try {
    const alerts = [];

    const { rows: stock } = await db.execute({
      sql: `SELECT p.id product_id,p.sku,p.name product_name,b.id branch_id,b.name branch_name,
                   bi.stock_qty,bi.min_stock
            FROM branch_inventory bi JOIN products p ON p.id=bi.product_id JOIN branches b ON b.id=bi.branch_id
            WHERE p.active=1 AND b.active=1 AND COALESCE(p.is_service,0)=0 AND bi.stock_qty<=bi.min_stock
            ORDER BY bi.stock_qty ASC, p.name LIMIT 100`, args: []
    });
    for (const x of stock) push(alerts, Number(x.stock_qty) <= 0 ? 'critical' : 'high', 'inventory',
      Number(x.stock_qty) <= 0 ? 'Stockout' : 'Low stock',
      `${x.product_name} (${x.sku}) at ${x.branch_name}: ${x.stock_qty} on hand, minimum ${x.min_stock}.`,
      { product_id:x.product_id, branch_id:x.branch_id, sku:x.sku });

    const { rows: overduePOs } = await db.execute({
      sql: `SELECT po.id,po.po_number,po.status,po.expected_date,s.name supplier_name,b.name branch_name
            FROM purchase_orders po LEFT JOIN suppliers s ON s.id=po.supplier_id LEFT JOIN branches b ON b.id=po.branch_id
            WHERE po.status IN ('sent','approved','partial') AND po.expected_date IS NOT NULL AND date(po.expected_date)<date('now')
            ORDER BY po.expected_date LIMIT 100`, args: []
    });
    for (const x of overduePOs) push(alerts, x.status === 'partial' ? 'high' : 'medium', 'purchasing', 'Purchase order overdue',
      `${x.po_number} from ${x.supplier_name || 'supplier'} was expected ${x.expected_date} and is ${x.status}.`, { purchase_order_id:x.id });

    const { rows: overdueRentals } = await db.execute({
      sql: `SELECT ra.id,ra.agreement_number,ra.due_date,c.first_name||' '||c.last_name customer_name,b.name branch_name
            FROM rental_agreements ra JOIN customers c ON c.id=ra.customer_id LEFT JOIN branches b ON b.id=ra.branch_id
            WHERE ra.status='active' AND ra.due_date IS NOT NULL AND date(ra.due_date)<date('now')
            ORDER BY ra.due_date LIMIT 100`, args: []
    });
    for (const x of overdueRentals) push(alerts, 'critical', 'rental', 'Rental overdue',
      `${x.agreement_number} for ${x.customer_name} was due ${x.due_date}.`, { rental_agreement_id:x.id });

    const { rows: transfers } = await db.execute({
      sql: `SELECT t.id,t.transfer_number,t.status,t.created_at,fb.name from_branch,tb.name to_branch
            FROM branch_transfers t LEFT JOIN branches fb ON fb.id=t.from_branch_id LEFT JOIN branches tb ON tb.id=t.to_branch_id
            WHERE t.status IN ('pending','in_transit') AND datetime(t.created_at)<datetime('now','-2 days')
            ORDER BY t.created_at LIMIT 100`, args: []
    });
    for (const x of transfers) push(alerts, x.status === 'in_transit' ? 'high' : 'medium', 'transfer', 'Transfer needs attention',
      `${x.transfer_number} (${x.from_branch || 'source'} → ${x.to_branch || 'destination'}) has remained ${x.status} since ${x.created_at}.`, { transfer_id:x.id });

    const { rows: ar } = await db.execute({
      sql: `SELECT id,customer_number,first_name||' '||last_name customer_name,account_balance,credit_limit,account_blocked
            FROM customers WHERE active=1 AND COALESCE(account_balance,0)>0
            ORDER BY account_balance DESC LIMIT 100`, args: []
    });
    for (const x of ar) {
      const limit = Number(x.credit_limit) || 0, balance = Number(x.account_balance) || 0;
      const over = limit > 0 && balance > limit;
      push(alerts, Number(x.account_blocked) || over ? 'high' : 'medium', 'accounts_receivable', over ? 'Customer over credit limit' : 'Accounts receivable outstanding',
        `${x.customer_name} owes ${balance.toFixed(2)}${limit > 0 ? ` against a ${limit.toFixed(2)} limit` : ''}.`, { customer_id:x.id, customer_number:x.customer_number });
    }

    const { rows: pickups } = await db.execute({
      sql: `SELECT wo.id,wo.wo_number,wo.status,wo.pickup_due_date,c.first_name||' '||c.last_name customer_name
            FROM work_orders wo JOIN customers c ON c.id=wo.customer_id
            WHERE wo.status='awaiting_pickup' AND wo.pickup_due_date IS NOT NULL AND date(wo.pickup_due_date)<date('now')
            ORDER BY wo.pickup_due_date LIMIT 100`, args: []
    });
    for (const x of pickups) push(alerts, 'high', 'repair', 'Completed repair overdue for pickup',
      `${x.wo_number} for ${x.customer_name} has passed its pickup due date ${x.pickup_due_date}.`, { work_order_id:x.id });

    const { rows: timers } = await db.execute({
      sql: `SELECT te.id time_entry_id,t.id task_id,t.description,t.allotted_minutes,wo.id work_order_id,wo.wo_number,
                   e.first_name||' '||e.last_name technician_name,
                   ROUND((julianday('now')-julianday(te.started_at))*24*60,1) elapsed_minutes
            FROM work_order_task_time_entries te JOIN work_order_tasks t ON t.id=te.task_id
            JOIN work_orders wo ON wo.id=t.work_order_id LEFT JOIN employees e ON e.id=te.technician_id
            WHERE te.ended_at IS NULL AND t.allotted_minutes>0
              AND (julianday('now')-julianday(te.started_at))*24*60 > t.allotted_minutes*1.25
            ORDER BY elapsed_minutes DESC LIMIT 100`, args: []
    });
    for (const x of timers) push(alerts, Number(x.elapsed_minutes) > Number(x.allotted_minutes) * 2 ? 'high' : 'medium', 'repair_timer', 'Repair task over allotted time',
      `${x.technician_name || 'Technician'} is ${x.elapsed_minutes} minutes into “${x.description}” on ${x.wo_number}; allotted ${x.allotted_minutes} minutes.`,
      { work_order_id:x.work_order_id, task_id:x.task_id, time_entry_id:x.time_entry_id });

    const { rows: drawers } = await db.execute({
      sql: `SELECT ds.id,ds.opened_at,d.name drawer_name,b.name branch_name,e.first_name||' '||e.last_name employee_name
            FROM drawer_sessions ds LEFT JOIN cash_drawers d ON d.id=ds.drawer_id LEFT JOIN branches b ON b.id=ds.branch_id LEFT JOIN employees e ON e.id=ds.employee_id
            WHERE ds.status='open' AND datetime(ds.opened_at)<datetime('now','-18 hours')
            ORDER BY ds.opened_at LIMIT 100`, args: []
    });
    for (const x of drawers) push(alerts, 'medium', 'drawer', 'Drawer session open unusually long',
      `${x.drawer_name || 'Drawer'} at ${x.branch_name || 'branch'} has been open since ${x.opened_at}${x.employee_name ? ` (${x.employee_name})` : ''}.`, { drawer_session_id:x.id });

    const { rows: quotes } = await db.execute({
      sql: `SELECT q.id,q.quote_number,q.status,q.valid_until,c.first_name||' '||c.last_name customer_name,q.total
            FROM quotations q LEFT JOIN customers c ON c.id=q.customer_id
            WHERE q.status NOT IN ('converted','cancelled','rejected') AND q.valid_until IS NOT NULL AND date(q.valid_until)<date('now')
            ORDER BY q.valid_until LIMIT 100`, args: []
    });
    for (const x of quotes) push(alerts, 'medium', 'quotation', 'Quotation expired without conversion',
      `${x.quote_number}${x.customer_name ? ` for ${x.customer_name}` : ''} expired ${x.valid_until} with value ${Number(x.total || 0).toFixed(2)}.`, { quotation_id:x.id });

    const rank = { critical:0, high:1, medium:2, low:3 };
    alerts.sort((a,b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9));
    const counts = alerts.reduce((a,x) => { a[x.severity]=(a[x.severity]||0)+1; a.total++; return a; }, { total:0,critical:0,high:0,medium:0,low:0 });
    res.json({ generated_at:new Date().toISOString(), counts, alerts,
      methodology:'Evidence-only management exceptions derived from current POS records. No operational action is executed automatically.' });
  } catch (e) { res.status(500).json({ error:e.message }); }
});

module.exports = router;
