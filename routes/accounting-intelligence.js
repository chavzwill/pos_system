const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission } = require('../lib/permissions');

// Revenue, margin, COGS and receivables are financial-report data, not general operational reports.
router.use(requirePermission('reports_financial'));

function period(req) {
  const end = req.query.end || new Date().toISOString().slice(0,10);
  const start = req.query.start || new Date(Date.now() - 29*86400000).toISOString().slice(0,10);
  const branchId = req.query.branch_id ? Number(req.query.branch_id) : null;
  return { start, end, branchId };
}
function wherePeriod(alias, p, args, includeBranch=true) {
  let sql = `date(${alias}.created_at) BETWEEN date(?) AND date(?)`;
  args.push(p.start, p.end);
  if (includeBranch && p.branchId) { sql += ` AND ${alias}.branch_id = ?`; args.push(p.branchId); }
  return sql;
}

router.get('/overview', async (req,res) => {
  try {
    const startedAt=Date.now();
    const p = period(req);
    const salesArgs=[]; const salesWhere=wherePeriod('t',p,salesArgs);
    const marginArgs=[]; const marginWhere=wherePeriod('t',p,marginArgs);
    const [
      { rows:[sales] },
      { rows:[margin] },
      { rows:[ar] },
      { rows:[aging] },
    ] = await Promise.all([
      db.execute({ sql:`SELECT COUNT(*) transaction_count, COALESCE(SUM(t.subtotal),0) subtotal,
        COALESCE(SUM(t.discount_amount),0) discounts, COALESCE(SUM(t.tax_amount),0) tax,
        COALESCE(SUM(t.total),0) revenue, COALESCE(AVG(t.total),0) avg_ticket,
        COALESCE(SUM(CASE WHEN t.payment_method='credit' THEN t.total ELSE 0 END),0) credit_sales
        FROM transactions t WHERE t.status='completed' AND ${salesWhere}`, args:salesArgs }),
      db.execute({ sql:`SELECT COALESCE(SUM(ti.total),0) merchandise_revenue,
        COALESCE(SUM(CASE WHEN ti.product_id IS NOT NULL THEN COALESCE(pr.cost,0)*ti.quantity ELSE 0 END),0) estimated_cogs,
        COALESCE(SUM(ti.total - CASE WHEN ti.product_id IS NOT NULL THEN COALESCE(pr.cost,0)*ti.quantity ELSE 0 END),0) estimated_gross_profit
        FROM transaction_items ti JOIN transactions t ON t.id=ti.transaction_id LEFT JOIN products pr ON pr.id=ti.product_id
        WHERE t.status='completed' AND ${marginWhere}`, args:marginArgs }),
      db.execute({ sql:`SELECT COALESCE(SUM(CASE WHEN credit_enabled=1 THEN account_balance ELSE 0 END),0) total_ar,
        COALESCE(SUM(CASE WHEN credit_enabled=1 AND credit_limit>0 AND account_balance>credit_limit THEN 1 ELSE 0 END),0) over_limit_customers
        FROM customers WHERE active=1`, args:[] }),
      db.execute({ sql:`SELECT COALESCE(SUM(CASE WHEN age_days<=30 THEN balance_due ELSE 0 END),0) current_30,
        COALESCE(SUM(CASE WHEN age_days BETWEEN 31 AND 60 THEN balance_due ELSE 0 END),0) days_31_60,
        COALESCE(SUM(CASE WHEN age_days BETWEEN 61 AND 90 THEN balance_due ELSE 0 END),0) days_61_90,
        COALESCE(SUM(CASE WHEN age_days>90 THEN balance_due ELSE 0 END),0) over_90
        FROM (
          SELECT t.id, CAST(julianday('now')-julianday(t.created_at) AS INTEGER) age_days,
            MAX(0,t.total-COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa WHERE pa.transaction_id=t.id),0)) balance_due
          FROM transactions t WHERE t.status='completed' AND t.payment_method='credit'
        ) x WHERE balance_due>0.001`, args:[] }),
    ]);
    const gp = Number(margin.estimated_gross_profit||0), merchRev = Number(margin.merchandise_revenue||0);
    res.set('Server-Timing',`accounting-intelligence;dur=${Date.now()-startedAt}`);
    res.json({ period:p, generated_at:new Date().toISOString(), evaluation_ms:Date.now()-startedAt, sales,
      margin:{...margin, estimated_margin_pct: merchRev ? gp/merchRev*100 : 0, basis:'Estimated using current product cost where a catalog product is linked; not a posted accounting ledger.'},
      receivables:{...ar,...aging} });
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.get('/branches', async (req,res) => {
  try {
    const p=period(req), args=[];
    let where=`t.status='completed' AND ${wherePeriod('t',p,args,false)}`;
    if(p.branchId){where+=' AND t.branch_id=?';args.push(p.branchId);}
    const {rows}=await db.execute({sql:`SELECT b.id branch_id,b.name branch_name,
      COUNT(DISTINCT t.id) transactions, COALESCE(SUM(t.total),0) revenue,
      COALESCE(SUM(t.discount_amount),0) discounts, COALESCE(SUM(t.tax_amount),0) tax,
      COALESCE(SUM(ti.total),0) merchandise_revenue,
      COALESCE(SUM(CASE WHEN ti.product_id IS NOT NULL THEN COALESCE(pr.cost,0)*ti.quantity ELSE 0 END),0) estimated_cogs,
      COALESCE(SUM(ti.total-CASE WHEN ti.product_id IS NOT NULL THEN COALESCE(pr.cost,0)*ti.quantity ELSE 0 END),0) estimated_gross_profit
      FROM branches b LEFT JOIN transactions t ON t.branch_id=b.id AND ${where}
      LEFT JOIN transaction_items ti ON ti.transaction_id=t.id LEFT JOIN products pr ON pr.id=ti.product_id
      GROUP BY b.id,b.name ORDER BY revenue DESC`,args});
    res.json(rows.map(r=>({...r,estimated_margin_pct:Number(r.merchandise_revenue||0)?Number(r.estimated_gross_profit||0)/Number(r.merchandise_revenue)*100:0})));
  }catch(e){res.status(500).json({error:e.message});}
});

router.get('/exceptions', async (req,res)=>{
  try{
    const p=period(req); const out=[];
    const a=[]; const w=wherePeriod('t',p,a);
    const c=[]; const cw=wherePeriod('t',p,c);
    const [{rows:discounts},{rows:overdue},{rows:negative}] = await Promise.all([
      db.execute({sql:`SELECT t.id,t.transaction_number,t.total,t.subtotal,t.discount_amount,t.created_at,b.name branch_name,
        CASE WHEN t.subtotal>0 THEN t.discount_amount/t.subtotal*100 ELSE 0 END discount_pct
        FROM transactions t LEFT JOIN branches b ON b.id=t.branch_id
        WHERE t.status='completed' AND t.discount_amount>0 AND ${w}
        ORDER BY discount_pct DESC LIMIT 25`,args:a}),
      db.execute({sql:`SELECT c.id,c.customer_number,c.first_name||' '||c.last_name customer_name,c.account_balance,c.credit_limit
        FROM customers c WHERE c.active=1 AND c.credit_enabled=1 AND c.account_balance>0
        ORDER BY c.account_balance DESC LIMIT 25`,args:[]}),
      db.execute({sql:`SELECT t.id,t.transaction_number,ti.product_id,ti.product_name,ti.quantity,ti.total,COALESCE(pr.cost,0)*ti.quantity est_cost,t.created_at
        FROM transaction_items ti JOIN transactions t ON t.id=ti.transaction_id LEFT JOIN products pr ON pr.id=ti.product_id
        WHERE t.status='completed' AND ti.product_id IS NOT NULL AND ti.total < COALESCE(pr.cost,0)*ti.quantity AND ${cw}
        ORDER BY (COALESCE(pr.cost,0)*ti.quantity-ti.total) DESC LIMIT 25`,args:c}),
    ]);
    for(const r of discounts){if(Number(r.discount_pct)>=15)out.push({severity:Number(r.discount_pct)>=30?'high':'medium',type:'discount_leakage',title:`Large discount on ${r.transaction_number}`,detail:`Discount ${Number(r.discount_pct).toFixed(1)}% (${Number(r.discount_amount).toFixed(2)})`,source:{entity:'transaction',id:r.id,branch:r.branch_name,created_at:r.created_at}});}
    for(const r of overdue){const over=Number(r.credit_limit||0)>0&&Number(r.account_balance)>Number(r.credit_limit);out.push({severity:over?'high':'medium',type:'receivable_exposure',title:`Receivable exposure: ${r.customer_name}`,detail:`Outstanding ${Number(r.account_balance).toFixed(2)}${over?' exceeds credit limit':''}`,source:{entity:'customer',id:r.id,customer_number:r.customer_number}});}
    for(const r of negative)out.push({severity:'high',type:'negative_margin',title:`Potential negative margin: ${r.product_name}`,detail:`Sold ${Number(r.total).toFixed(2)} vs current-cost estimate ${Number(r.est_cost).toFixed(2)}`,source:{entity:'transaction',id:r.id,transaction_number:r.transaction_number,product_id:r.product_id,created_at:r.created_at}});
    res.json(out);
  }catch(e){res.status(500).json({error:e.message});}
});

router.get('/repair-economics', async (req,res)=>{
  try{
    const p=period(req),args=[]; let where=`date(wo.created_at) BETWEEN date(?) AND date(?)`;args.push(p.start,p.end);if(p.branchId){where+=' AND wo.branch_id=?';args.push(p.branchId);}
    const {rows}=await db.execute({sql:`SELECT wo.id,wo.wo_number,wo.status,wo.created_at,b.name branch_name,
      COALESCE(SUM(woi.unit_price*woi.quantity),0) parts_revenue,
      COALESCE(SUM(woi.unit_cost*woi.quantity),0) parts_cost,
      COALESCE(SUM((woi.unit_price-woi.unit_cost)*woi.quantity),0) parts_gross_profit,
      COALESCE(wo.estimate_labor,0) estimated_labor_revenue,
      COALESCE(wo.deposit_amount,0) deposit_amount
      FROM work_orders wo LEFT JOIN branches b ON b.id=wo.branch_id LEFT JOIN work_order_items woi ON woi.work_order_id=wo.id
      WHERE ${where} GROUP BY wo.id ORDER BY wo.created_at DESC LIMIT 100`,args});
    res.json({basis:'Repair economics currently uses work-order estimate and part-line values. It is operational intelligence, not ledger-posted profitability.',rows});
  }catch(e){res.status(500).json({error:e.message});}
});

module.exports=router;
